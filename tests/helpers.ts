import crypto from "node:crypto";
import { pool } from "../src/db.js";
import { createSession } from "../src/auth.js";
import { moveMoney } from "../src/money.js";

export { pool };

export async function mkUser(role: "admin" | "holder" | "auditor" = "holder"): Promise<number> {
  const r = await pool.query(
    `INSERT INTO users (email, password_hash, role) VALUES ($1, 'x', $2) RETURNING id`,
    [`t-${crypto.randomUUID()}@test.local`, role]
  );
  return Number(r.rows[0].id);
}

export async function mkAccount(owner: number, members: number[] = [owner]): Promise<number> {
  const a = await pool.query(`INSERT INTO accounts (owner_id, name) VALUES ($1, 'test') RETURNING id`, [owner]);
  const id = Number(a.rows[0].id);
  for (const m of members)
    await pool.query(`INSERT INTO account_members (account_id, user_id) VALUES ($1, $2)`, [id, m]);
  return id;
}

export const key = () => `k-${crypto.randomUUID()}`;
export const token = (userId: number) => createSession(userId);

export async function balance(accountId: number): Promise<number> {
  const r = await pool.query(`SELECT balance_paise FROM accounts WHERE id = $1`, [accountId]);
  return Number(r.rows[0].balance_paise);
}

export async function sumAllPostings(): Promise<string> {
  const r = await pool.query(`SELECT COALESCE(SUM(amount_paise), 0)::text AS s FROM postings`);
  return r.rows[0].s;
}

export function deposit(actorId: number, accountId: number, amountPaise: number, idempotencyKey = key()) {
  return moveMoney(pool, { actorId, type: "deposit", toAccountId: accountId, amountPaise, idempotencyKey });
}
export function withdraw(actorId: number, accountId: number, amountPaise: number, idempotencyKey = key()) {
  return moveMoney(pool, { actorId, type: "withdrawal", fromAccountId: accountId, amountPaise, idempotencyKey });
}
export function transfer(actorId: number, from: number, to: number, amountPaise: number, idempotencyKey = key()) {
  return moveMoney(pool, { actorId, type: "transfer", fromAccountId: from, toAccountId: to, amountPaise, idempotencyKey });
}