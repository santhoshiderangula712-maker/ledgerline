import pg from "pg";
import { moveMoney } from "../src/money.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
let failed = false;
function check(name: string, ok: boolean, extra = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name} ${extra}`);
  if (!ok) failed = true;
}

async function account(userId: number, name: string): Promise<number> {
  const a = await pool.query(`INSERT INTO accounts (owner_id, name) VALUES ($1, $2) RETURNING id`, [userId, name]);
  const id = Number(a.rows[0].id);
  await pool.query(`INSERT INTO account_members (account_id, user_id) VALUES ($1, $2)`, [id, userId]);
  return id;
}
const balance = async (id: number) =>
  Number((await pool.query(`SELECT balance_paise FROM accounts WHERE id = $1`, [id])).rows[0].balance_paise);

async function main() {
  const tag = Date.now();
  const mkUser = async (n: string) =>
    Number((await pool.query(
      `INSERT INTO users (email, password_hash, role) VALUES ($1, 'x', 'holder') RETURNING id`,
      [`smoke-${tag}-${n}@test.local`])).rows[0].id);
  const alice = await mkUser("alice");
  const mallory = await mkUser("mallory");
  const A = await account(alice, "smoke A");
  const B = await account(alice, "smoke B");
  const dep = (acct: number, amt: number, key: string, who = alice) =>
    moveMoney(pool, { actorId: who, type: "deposit", toAccountId: acct, amountPaise: amt, idempotencyKey: key });

  await dep(A, 10000, `dep-${tag}`);

  // 1. 20 parallel withdrawals of the WHOLE balance: exactly one may win.
  const w = await Promise.all(
    Array.from({ length: 20 }, (_, n) =>
      moveMoney(pool, { actorId: alice, type: "withdrawal", fromAccountId: A, amountPaise: 10000, idempotencyKey: `w-${tag}-${n}` })
    )
  );
  check("exactly 1 withdrawal succeeds", w.filter((r) => r.httpStatus === 201).length === 1);
  check("19 are refused", w.filter((r) => r.httpStatus === 422).length === 19);
  check("balance is 0, not negative", (await balance(A)) === 0);

  // 2. Same key fired 20 times at once: money moves once.
  const rep = await Promise.all(Array.from({ length: 20 }, () => dep(A, 5000, `rep-${tag}`)));
  check("replay: 1 original + 19 replays", rep.filter((r) => !r.replayed).length === 1 && rep.filter((r) => r.replayed).length === 19);
  check("replay: all answers identical", new Set(rep.map((r) => JSON.stringify(r.body))).size === 1);
  check("replay: balance is 5000 (paid once)", (await balance(A)) === 5000);

  // 3. Same key, different amount -> rejected, nothing moves.
  const bad = await dep(A, 9999, `rep-${tag}`).catch((e) => e);
  check("same key + different body -> 422", bad.httpStatus === 422 && bad.code === "idempotency_key_reused");

  // 4. Someone else's account.
  const steal = await moveMoney(pool, { actorId: mallory, type: "withdrawal", fromAccountId: A, amountPaise: 100, idempotencyKey: `steal-${tag}` }).catch((e) => e);
  check("other user's account -> 404", steal.httpStatus === 404);
  check("balance unchanged after theft attempt", (await balance(A)) === 5000);

  // 5. Opposing transfers racing (deadlock test): A->B and B->A at once.
  await dep(B, 5000, `depB-${tag}`);
  const t = await Promise.all(
    Array.from({ length: 20 }, (_, n) =>
      moveMoney(pool, {
        actorId: alice, type: "transfer",
        fromAccountId: n % 2 ? A : B, toAccountId: n % 2 ? B : A,
        amountPaise: 100, idempotencyKey: `t-${tag}-${n}`,
      })
    )
  );
  check("20 opposing transfers all succeed (no deadlock)", t.every((r) => r.httpStatus === 201));
  check("A + B total conserved (10000)", (await balance(A)) + (await balance(B)) === 10000);

  // 6. Global invariants straight from the database.
  const sum = await pool.query(`SELECT COALESCE(SUM(amount_paise), 0)::text AS s FROM postings`);
  check("sum of ALL postings = 0", sum.rows[0].s === "0");
  check("reconcile_accounts() empty", (await pool.query(`SELECT * FROM reconcile_accounts()`)).rowCount === 0);
  check("verify_ledger() empty", (await pool.query(`SELECT * FROM verify_ledger()`)).rowCount === 0);

  await pool.end();
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });