import crypto from "node:crypto";
import type { Pool, PoolClient } from "pg";

export type MoveType = "deposit" | "withdrawal" | "transfer";

export interface MoveInput {
  actorId: number;
  type: MoveType;
  fromAccountId?: number; // withdrawal, transfer
  toAccountId?: number; // deposit, transfer
  amountPaise: number;
  idempotencyKey: string;
}

export interface MoveResult {
  httpStatus: number;
  body: Record<string, unknown>;
  replayed: boolean;
}

export class AppError extends Error {
  constructor(
    public httpStatus: number,
    public code: string,
    message?: string,
    public audit = false
  ) {
    super(message ?? code);
  }
}

export const MAX_AMOUNT_PAISE = 1_000_000_000; // Rs 1 crore per request

const PERMISSION_COLUMN: Record<MoveType, string> = {
  deposit: "can_deposit",
  withdrawal: "can_withdraw",
  transfer: "can_transfer",
};

function validate(i: MoveInput): void {
  if (!["deposit", "withdrawal", "transfer"].includes(i.type))
    throw new AppError(400, "invalid_type");
  if (!Number.isSafeInteger(i.amountPaise) || i.amountPaise <= 0 || i.amountPaise > MAX_AMOUNT_PAISE)
    throw new AppError(400, "invalid_amount", `amount must be an integer 1..${MAX_AMOUNT_PAISE} paise`);
  if (typeof i.idempotencyKey !== "string" || i.idempotencyKey.length < 1 || i.idempotencyKey.length > 200)
    throw new AppError(400, "invalid_idempotency_key");
  const isId = (n: unknown) => Number.isSafeInteger(n) && (n as number) > 0;
  if (i.type === "deposit" && (!isId(i.toAccountId) || i.fromAccountId !== undefined))
    throw new AppError(400, "invalid_accounts", "deposit needs toAccountId only");
  if (i.type === "withdrawal" && (!isId(i.fromAccountId) || i.toAccountId !== undefined))
    throw new AppError(400, "invalid_accounts", "withdrawal needs fromAccountId only");
  if (i.type === "transfer") {
    if (!isId(i.fromAccountId) || !isId(i.toAccountId))
      throw new AppError(400, "invalid_accounts", "transfer needs fromAccountId and toAccountId");
    if (i.fromAccountId === i.toAccountId)
      throw new AppError(400, "invalid_accounts", "cannot transfer to the same account");
  }
}

function hashRequest(i: MoveInput): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify([i.type, i.fromAccountId ?? null, i.toAccountId ?? null, i.amountPaise]))
    .digest("hex");
}

export async function moveMoney(pool: Pool, input: MoveInput): Promise<MoveResult> {
  validate(input);
  const requestHash = hashRequest(input);
  const client = await pool.connect();
  try {
    // READ COMMITTED (the default) is REQUIRED here. See DECISIONS notes below.
    await client.query("BEGIN");
    const result = await moveInTx(client, input, requestHash);
    await client.query("COMMIT");
    return result;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    if (e instanceof AppError && e.audit) {
      // Authorisation failures are recorded outside the rolled-back transaction.
      await client
        .query("INSERT INTO audit_log (actor_id, action, detail) VALUES ($1, 'authz_denied', $2)", [
          input.actorId,
          JSON.stringify({
            code: e.code,
            type: input.type,
            from: input.fromAccountId ?? null,
            to: input.toAccountId ?? null,
            amountPaise: input.amountPaise,
          }),
        ])
        .catch(() => {});
    }
    throw e;
  } finally {
    client.release();
  }
}

async function moveInTx(c: PoolClient, i: MoveInput, requestHash: string): Promise<MoveResult> {
  // ---- 1. Claim the idempotency key ---------------------------------------
  // If an identical key is in flight in another transaction, this INSERT BLOCKS
  // on the unique index until that transaction commits or rolls back.
  //  - first one committed -> we get no row back and replay its stored answer
  //  - first one rolled back -> we insert and proceed
  const claim = await c.query(
    `INSERT INTO idempotency_keys (user_id, key, request_hash)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id, key) DO NOTHING
     RETURNING id`,
    [i.actorId, i.idempotencyKey, requestHash]
  );
  if (claim.rowCount === 0) {
    const ex = await c.query(
      `SELECT id, request_hash, response_status, response_body
       FROM idempotency_keys WHERE user_id = $1 AND key = $2`,
      [i.actorId, i.idempotencyKey]
    );
    const row = ex.rows[0];
    if (row.request_hash !== requestHash)
      throw new AppError(422, "idempotency_key_reused", "this key was used with a different request");
    if (row.response_status === null) throw new AppError(409, "request_in_flight");
    await c.query(`INSERT INTO idempotency_replays (idempotency_key_id, user_id) VALUES ($1, $2)`, [
      row.id,
      i.actorId,
    ]);
    return { httpStatus: row.response_status, body: row.response_body, replayed: true };
  }
  const keyId = claim.rows[0].id;

  // ---- 2. Authorise on the server (BEFORE locking any account) ------------
  const u = await c.query(`SELECT role FROM users WHERE id = $1`, [i.actorId]);
  if (u.rowCount === 0 || u.rows[0].role !== "holder")
    throw new AppError(403, "role_not_permitted", "only account holders can move money", true);

  const controlled = i.type === "deposit" ? i.toAccountId! : i.fromAccountId!;
  // FOR SHARE: an admin revoking this membership must wait for us to finish.
  const m = await c.query(
    `SELECT ${PERMISSION_COLUMN[i.type]} AS ok FROM account_members
     WHERE account_id = $1 AND user_id = $2 FOR SHARE`,
    [controlled, i.actorId]
  );
  if (m.rowCount === 0 || !m.rows[0].ok)
    // 404, not 403: do not reveal whether someone else's account exists.
    throw new AppError(404, "account_not_found", undefined, true);

  // ---- 3. Lock every account involved, in ascending id order --------------
  const ext = await c.query(`SELECT id FROM accounts WHERE kind = 'external'`);
  const externalId = Number(ext.rows[0].id);
  const fromId = i.type === "deposit" ? externalId : i.fromAccountId!;
  const toId = i.type === "withdrawal" ? externalId : i.toAccountId!;

  const locked = await c.query(
    `SELECT id, kind, status, balance_paise FROM accounts
     WHERE id = ANY($1::bigint[]) ORDER BY id FOR UPDATE`,
    [[fromId, toId]]
  );
  if (locked.rowCount !== 2) throw new AppError(404, "account_not_found");
  const acc = new Map<number, { kind: string; status: string; balance: bigint }>();
  for (const r of locked.rows)
    acc.set(Number(r.id), { kind: r.kind, status: r.status, balance: BigInt(r.balance_paise) });
  const from = acc.get(fromId)!;
  const to = acc.get(toId)!;

  // A "transfer" must never touch the EXTERNAL account (that would be a withdrawal in disguise).
  if (i.type === "transfer" && (from.kind !== "customer" || to.kind !== "customer"))
    throw new AppError(404, "account_not_found");

  // ---- 4. Business checks AFTER the lock (never before) -------------------
  const amount = BigInt(i.amountPaise);
  const refuseCtx = {
    // The account whose statement should show the refusal:
    accountId: i.type === "deposit" ? toId : fromId,
    counterpartyId: i.type === "deposit" ? null : i.type === "transfer" ? toId : null,
  };
  if (from.kind === "customer" && from.status !== "active")
    return refuse(c, i, keyId, refuseCtx, "source_account_not_active");
  if (to.kind === "customer" && to.status !== "active")
    return refuse(c, i, keyId, refuseCtx, "destination_account_not_active");
  if (from.kind === "customer" && from.balance < amount)
    return refuse(c, i, keyId, refuseCtx, "insufficient_funds");

  // ---- 5. Write the ledger and the balances (same transaction) ------------
  const t = await c.query(
    `INSERT INTO transactions (type, initiated_by, idempotency_key_id)
     VALUES ($1, $2, $3) RETURNING id`,
    [i.type, i.actorId, keyId]
  );
  const txnId = Number(t.rows[0].id);

  const legs = [
    { id: fromId, delta: -amount, before: from.balance },
    { id: toId, delta: amount, before: to.balance },
  ];
  for (const leg of legs) {
    // id / prev_hash / hash are filled in by the database trigger.
    await c.query(
      `INSERT INTO postings (txn_id, account_id, amount_paise, balance_after_paise)
       VALUES ($1, $2, $3, $4)`,
      [txnId, leg.id, leg.delta.toString(), (leg.before + leg.delta).toString()]
    );
    await c.query(`UPDATE accounts SET balance_paise = balance_paise + $1 WHERE id = $2`, [
      leg.delta.toString(),
      leg.id,
    ]);
  }

  const mine = legs.find((l) => l.id === controlled)!;
  const body = {
    status: "completed",
    transactionId: txnId,
    type: i.type,
    fromAccountId: i.type === "deposit" ? null : fromId,
    toAccountId: i.type === "withdrawal" ? null : toId,
    amountPaise: i.amountPaise,
    yourBalanceAfterPaise: Number(mine.before + mine.delta),
  };
    const stored = await c.query(
    `UPDATE idempotency_keys
     SET status = 'completed', response_status = 201, response_body = $2, completed_at = now()
     WHERE id = $1
     RETURNING response_body`,
    [keyId, JSON.stringify(body)]
  );
  return { httpStatus: 201, body: stored.rows[0].response_body, replayed: false };
}

// A business refusal moves no money, so it is COMMITTED (not rolled back):
// the refusal row and the stored answer both survive, and a replay of the
// same key returns the same refusal.
async function refuse(
  c: PoolClient,
  i: MoveInput,
  keyId: number,
  ctx: { accountId: number; counterpartyId: number | null },
  reason: string
): Promise<MoveResult> {
  await c.query(
    `INSERT INTO refused_attempts
       (account_id, counterparty_account_id, initiated_by, type, amount_paise, reason, idempotency_key)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [ctx.accountId, ctx.counterpartyId, i.actorId, i.type, i.amountPaise, reason, i.idempotencyKey]
  );
  const body = { status: "refused", reason, type: i.type, amountPaise: i.amountPaise };
   const stored = await c.query(
    `UPDATE idempotency_keys
     SET status = 'completed', response_status = 422, response_body = $2, completed_at = now()
     WHERE id = $1
     RETURNING response_body`,
    [keyId, JSON.stringify(body)]
  );
  return { httpStatus: 422, body: stored.rows[0].response_body, replayed: false };
}