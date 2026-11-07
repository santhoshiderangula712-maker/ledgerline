import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";
import { pool } from "./db.js";
import { AppError, moveMoney, type MoveType } from "./money.js";
import { authenticate, createSession, dummyHash, hashPassword, requireRole, verifyPassword, type AuthUser } from "./auth.js";

async function audit(actorId: number | null, action: string, detail: unknown) {
  await pool
    .query(`INSERT INTO audit_log (actor_id, action, detail) VALUES ($1, $2, $3)`, [
      actorId,
      action,
      JSON.stringify(detail),
    ])
    .catch(() => {});
}

function parseId(v: unknown): number {
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n <= 0) throw new AppError(404, "account_not_found");
  return n;
}

// Admin and auditor may see every customer account. A holder sees only the
// accounts they are a member of. Anything else is a 404, never a 403, so the
// existence of other people's accounts is not revealed.
async function visibleAccount(user: AuthUser, accountId: number) {
  const r =
    user.role === "holder"
      ? await pool.query(
          `SELECT a.id, a.name, a.status, a.balance_paise FROM accounts a
           JOIN account_members m ON m.account_id = a.id
           WHERE a.id = $1 AND m.user_id = $2 AND a.kind = 'customer'`,
          [accountId, user.id]
        )
      : await pool.query(
          `SELECT id, name, status, balance_paise FROM accounts WHERE id = $1 AND kind = 'customer'`,
          [accountId]
        );
  if (r.rowCount === 0) throw new AppError(404, "account_not_found");
  return r.rows[0];
}

const shape = (a: any) => ({ id: Number(a.id), name: a.name, status: a.status, balancePaise: Number(a.balance_paise) });

export function buildApp() {
  const app = Fastify({ logger: true, trustProxy: true });

  app.register(rateLimit, { global: false });

  app.setErrorHandler((err: any, req, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.httpStatus).send({ error: err.code, message: err.message });
    }
    if (err.statusCode && err.statusCode >= 400 && err.statusCode < 500) {
      return reply.status(err.statusCode).send({ error: err.code ?? "bad_request", message: err.message });
    }
    req.log.error(err);
    return reply.status(500).send({ error: "internal_error" });
  });

  // ---------------- public ----------------
  app.get("/", async () => ({ name: "LedgerLine", status: "running" }));
  app.get("/health", async () => {
    const { rows } = await pool.query("SELECT 1 AS ok");
    return { status: "ok", db: rows[0].ok === 1 };
  });

  app.post(
    "/auth/login",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (req) => {
      const b = (req.body ?? {}) as Record<string, unknown>;
      if (typeof b.email !== "string" || typeof b.password !== "string" || b.password.length > 200)
        throw new AppError(400, "invalid_request");
      const email = b.email.trim().toLowerCase().slice(0, 200);
      const r = await pool.query(`SELECT id, role, password_hash FROM users WHERE email = $1`, [email]);
      const row = r.rows[0];
      const ok = await verifyPassword(b.password, row ? row.password_hash : await dummyHash);
      if (!row || !ok) {
        await audit(null, "login_failed", { email });
        throw new AppError(401, "invalid_credentials");
      }
      const token = await createSession(Number(row.id));
      await audit(Number(row.id), "login", {});
      return { token, role: row.role, expiresInHours: 8 };
    }
  );

  // ---------------- any logged-in user ----------------
  app.post("/auth/logout", { preHandler: authenticate }, async (req) => {
    await pool.query(`UPDATE sessions SET revoked_at = now() WHERE token_hash = $1`, [req.tokenHash]);
    return { status: "logged_out" };
  });

  app.get("/me", { preHandler: authenticate }, async (req) => req.user);

  app.get("/accounts", { preHandler: authenticate }, async (req) => {
    const u = req.user!;
    const r =
      u.role === "holder"
        ? await pool.query(
            `SELECT a.id, a.name, a.status, a.balance_paise FROM accounts a
             JOIN account_members m ON m.account_id = a.id
             WHERE m.user_id = $1 AND a.kind = 'customer' ORDER BY a.id`,
            [u.id]
          )
        : await pool.query(
            `SELECT id, name, status, balance_paise FROM accounts WHERE kind = 'customer' ORDER BY id`
          );
    return r.rows.map(shape);
  });

  app.get("/accounts/:id", { preHandler: authenticate }, async (req) => {
    const id = parseId((req.params as any).id);
    return shape(await visibleAccount(req.user!, id));
  });

  app.get("/accounts/:id/statement", { preHandler: authenticate }, async (req) => {
    const id = parseId((req.params as any).id);
    await visibleAccount(req.user!, id);
    const limit = Math.min(Math.max(Number((req.query as any).limit) || 100, 1), 500);
    const r = await pool.query(
      `SELECT * FROM (
         SELECT 'posting' AS kind, p.id, p.created_at, t.type, p.amount_paise,
                p.balance_after_paise, u.email AS initiated_by, t.id AS txn_id, NULL::text AS reason
         FROM postings p
         JOIN transactions t ON t.id = p.txn_id
         JOIN users u ON u.id = t.initiated_by
         WHERE p.account_id = $1
         UNION ALL
         SELECT 'refused', r.id, r.created_at, r.type, r.amount_paise,
                NULL::bigint, u.email, NULL::bigint, r.reason
         FROM refused_attempts r
         LEFT JOIN users u ON u.id = r.initiated_by
         WHERE r.account_id = $1
       ) s ORDER BY created_at DESC, id DESC LIMIT $2`,
      [id, limit]
    );
    return r.rows.map((x) => ({
      kind: x.kind, // "posting" (money moved) or "refused" (nothing moved)
      id: Number(x.id),
      at: x.created_at,
      type: x.type,
      amountPaise: x.amount_paise === null ? null : Number(x.amount_paise), // posting: + credit, - debit
      runningBalancePaise: x.balance_after_paise === null ? null : Number(x.balance_after_paise),
      initiatedBy: x.initiated_by,
      transactionId: x.txn_id === null ? null : Number(x.txn_id),
      reason: x.reason,
    }));
  });

  // ---------------- money (holders only; enforced again inside moveMoney) ----------------
  async function money(req: any, reply: any, type: MoveType, from?: unknown, to?: unknown) {
    const key = req.headers["idempotency-key"];
    if (typeof key !== "string" || key.length === 0)
      throw new AppError(400, "idempotency_key_required", "send an Idempotency-Key header");
    const b = (req.body ?? {}) as Record<string, unknown>;
    const r = await moveMoney(pool, {
      actorId: req.user.id,
      type,
      fromAccountId: from as number | undefined,
      toAccountId: to as number | undefined,
      amountPaise: b.amountPaise as number,
      idempotencyKey: key,
    });
    return reply.status(r.httpStatus).header("Idempotent-Replayed", String(r.replayed)).send(r.body);
  }

  const auth = { preHandler: authenticate };
  app.post("/deposits", auth, (req: any, reply) => money(req, reply, "deposit", undefined, req.body?.accountId));
  app.post("/withdrawals", auth, (req: any, reply) => money(req, reply, "withdrawal", req.body?.accountId, undefined));
  app.post("/transfers", auth, (req: any, reply) =>
    money(req, reply, "transfer", req.body?.fromAccountId, req.body?.toAccountId)
  );

  // ---------------- admin ----------------
  app.post("/admin/users", { preHandler: requireRole("admin") }, async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const email = typeof b.email === "string" ? b.email.trim().toLowerCase() : "";
    if (!/^[^@\s]+@[^@\s]+$/.test(email) || email.length > 200) throw new AppError(400, "invalid_email");
    if (typeof b.password !== "string" || b.password.length < 10 || b.password.length > 200)
      throw new AppError(400, "weak_password", "password must be 10 to 200 characters");
    if (!["admin", "holder", "auditor"].includes(b.role as string)) throw new AppError(400, "invalid_role");
    try {
      const r = await pool.query(
        `INSERT INTO users (email, password_hash, role) VALUES ($1, $2, $3) RETURNING id`,
        [email, await hashPassword(b.password), b.role]
      );
      await audit(req.user!.id, "user_created", { userId: Number(r.rows[0].id), email, role: b.role });
      return reply.status(201).send({ id: Number(r.rows[0].id), email, role: b.role });
    } catch (e: any) {
      if (e.code === "23505") throw new AppError(409, "email_taken");
      throw e;
    }
  });

  app.post("/admin/accounts", { preHandler: requireRole("admin") }, async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const ownerId = Number(b.ownerUserId);
    if (!Number.isSafeInteger(ownerId) || ownerId <= 0) throw new AppError(400, "invalid_owner");
    if (typeof b.name !== "string" || b.name.trim().length === 0 || b.name.length > 100)
      throw new AppError(400, "invalid_name");
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      const o = await c.query(`SELECT role FROM users WHERE id = $1`, [ownerId]);
      if (o.rowCount === 0 || o.rows[0].role !== "holder")
        throw new AppError(400, "owner_must_be_a_holder");
      const a = await c.query(
        `INSERT INTO accounts (owner_id, name) VALUES ($1, $2) RETURNING id`,
        [ownerId, b.name.trim()]
      );
      const accountId = Number(a.rows[0].id);
      await c.query(`INSERT INTO account_members (account_id, user_id) VALUES ($1, $2)`, [accountId, ownerId]);
      await c.query(`INSERT INTO audit_log (actor_id, action, detail) VALUES ($1, 'account_created', $2)`, [
        req.user!.id,
        JSON.stringify({ accountId, ownerId }),
      ]);
      await c.query("COMMIT");
      return reply.status(201).send({ id: accountId, ownerUserId: ownerId, name: b.name.trim() });
    } catch (e) {
      await c.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      c.release();
    }
  });

  // Freezing takes the account row lock, so it waits for any in-flight movement
  // on that account and every later movement sees the new status.
  app.post("/admin/accounts/:id/status", { preHandler: requireRole("admin") }, async (req) => {
    const id = parseId((req.params as any).id);
    const status = (req.body as any)?.status;
    if (!["active", "frozen"].includes(status)) throw new AppError(400, "invalid_status");
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      const r = await c.query(
        `UPDATE accounts SET status = $1 WHERE id = $2 AND kind = 'customer' RETURNING id`,
        [status, id]
      );
      if (r.rowCount === 0) throw new AppError(404, "account_not_found");
      await c.query(`INSERT INTO audit_log (actor_id, action, detail) VALUES ($1, 'account_status', $2)`, [
        req.user!.id,
        JSON.stringify({ accountId: id, status }),
      ]);
      await c.query("COMMIT");
      return { id, status };
    } catch (e) {
      await c.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      c.release();
    }
  });

  // Admin and auditor: prove the books balance and the ledger is untampered.
  app.get("/admin/verify-ledger", { preHandler: requireRole("admin", "auditor") }, async () => {
    const chain = await pool.query(`SELECT * FROM verify_ledger()`);
    const recon = await pool.query(`SELECT * FROM reconcile_accounts()`);
    const sum = await pool.query(`SELECT COALESCE(SUM(amount_paise), 0)::text AS s FROM postings`);
    const postingsSum = sum.rows[0].s;
    return {
      ok: chain.rowCount === 0 && recon.rowCount === 0 && postingsSum === "0",
      postingsSumPaise: postingsSum, // must be "0"
      brokenPostings: chain.rows,
      unreconciledAccounts: recon.rows,
    };
  });

  return app;
}