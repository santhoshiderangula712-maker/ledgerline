import { pool } from "../src/db.js";
import { hashPassword } from "../src/auth.js";
import { moveMoney } from "../src/money.js";

async function user(email: string, password: string, role: string): Promise<number> {
  const r = await pool.query(
    `INSERT INTO users (email, password_hash, role) VALUES ($1, $2, $3)
     ON CONFLICT (email) DO NOTHING RETURNING id`,
    [email, await hashPassword(password), role]
  );
  if (r.rowCount) return Number(r.rows[0].id);
  return Number((await pool.query(`SELECT id FROM users WHERE email = $1`, [email])).rows[0].id);
}

async function account(ownerId: number, name: string): Promise<number> {
  const ex = await pool.query(`SELECT id FROM accounts WHERE owner_id = $1 AND name = $2`, [ownerId, name]);
  if (ex.rowCount) return Number(ex.rows[0].id);
  const a = await pool.query(`INSERT INTO accounts (owner_id, name) VALUES ($1, $2) RETURNING id`, [ownerId, name]);
  const id = Number(a.rows[0].id);
  await pool.query(`INSERT INTO account_members (account_id, user_id) VALUES ($1, $2)`, [id, ownerId]);
  return id;
}

async function main() {
  await user("admin@ledgerline.test", "Admin-demo-2026", "admin");
  const alice = await user("alice@ledgerline.test", "Alice-demo-2026", "holder");
  const bob = await user("bob@ledgerline.test", "Bob-demo-2026", "holder");
  await user("auditor@ledgerline.test", "Auditor-demo-2026", "auditor");

  const aliceMain = await account(alice, "Alice Current");
  await account(alice, "Alice Savings");
  const bobMain = await account(bob, "Bob Current");

  // Fixed idempotency keys: re-running the seed never deposits twice.
  await moveMoney(pool, { actorId: alice, type: "deposit", toAccountId: aliceMain, amountPaise: 500000, idempotencyKey: "seed-alice-1" });
  await moveMoney(pool, { actorId: bob, type: "deposit", toAccountId: bobMain, amountPaise: 100000, idempotencyKey: "seed-bob-1" });

  console.log("seeded: admin@, alice@, bob@, auditor@ ledgerline.test");
  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });