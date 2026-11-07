import { describe, it, expect, afterAll } from "vitest";
import type { Pool } from "pg";
import { pool, mkUser, mkAccount, balance, key } from "./helpers.js";
import { moveMoney } from "../src/money.js";

afterAll(() => pool.end());

// Runs one statement inside a transaction as the restricted role, then rolls back.
async function asApp(sql: string) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SET LOCAL ROLE ledgerline_app");
    await c.query(sql);
  } finally {
    await c.query("ROLLBACK").catch(() => {});
    c.release();
  }
}

// A pool whose every transaction runs as the restricted role (SET LOCAL after BEGIN).
const appPool = {
  connect: async () => {
    const c = await pool.connect();
    const orig = c.query;
    const q = (orig as any).bind(c);
    (c as any).query = async (text: any, params?: any) => {
      const r = await q(text, params);
      if (text === "BEGIN") await q("SET LOCAL ROLE ledgerline_app");
      return r;
    };
    const rel = c.release.bind(c);
    (c as any).release = (e?: any) => {
      (c as any).query = orig;
      rel(e);
    };
    return c;
  },
} as unknown as Pool;

const DENIED = /permission denied|must be owner/;

describe("restricted application role", () => {
  it("cannot disable or drop triggers, drop tables, or replace the guard function", async () => {
    for (const sql of [
      `ALTER TABLE postings DISABLE TRIGGER postings_no_mutate`,
      `ALTER TABLE postings DISABLE TRIGGER ALL`,
      `DROP TRIGGER postings_no_mutate ON postings`,
      `DROP TABLE postings CASCADE`,
      `CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$`,
    ])
      await expect(asApp(sql), sql).rejects.toThrow(DENIED);
  });

  it("cannot UPDATE, DELETE or TRUNCATE ledger tables (denied before the triggers even fire)", async () => {
    for (const sql of [
      `UPDATE postings SET amount_paise = 1`,
      `DELETE FROM postings`,
      `TRUNCATE postings`,
      `UPDATE transactions SET type = 'transfer'`,
      `DELETE FROM transactions`,
      `DELETE FROM refused_attempts`,
      `UPDATE audit_log SET action = 'x'`,
      `DELETE FROM audit_log`,
      `DELETE FROM idempotency_replays`,
    ])
      await expect(asApp(sql), sql).rejects.toThrow(DENIED);
  });

  it("cannot promote a user, re-own an account, or delete accounts and memberships", async () => {
    for (const sql of [
      `UPDATE users SET role = 'admin'`,
      `DELETE FROM users`,
      `UPDATE accounts SET owner_id = 1`,
      `DELETE FROM accounts`,
      `DELETE FROM account_members`,
    ])
      await expect(asApp(sql), sql).rejects.toThrow(DENIED);
  });

  it("can still do everything the application needs: deposits, a withdrawal race, transfers, refusals, replays", async () => {
    const u = await mkUser();
    const [a, b] = [await mkAccount(u), await mkAccount(u)];
    const mv = (type: any, from: number | undefined, to: number | undefined, amt: number, k = key()) =>
      moveMoney(appPool, { actorId: u, type, fromAccountId: from, toAccountId: to, amountPaise: amt, idempotencyKey: k });

    await mv("deposit", undefined, a, 10000);
    const race = await Promise.all(Array.from({ length: 10 }, () => mv("withdrawal", a, undefined, 10000)));
    expect(race.filter((r) => r.httpStatus === 201)).toHaveLength(1);
    expect(race.filter((r) => r.httpStatus === 422)).toHaveLength(9);

    await mv("deposit", undefined, a, 500);
    expect((await mv("transfer", a, b, 200)).httpStatus).toBe(201);
    expect([await balance(a), await balance(b)]).toEqual([300, 200]);

    const k = key();
    await mv("deposit", undefined, b, 50, k);
    expect((await mv("deposit", undefined, b, 50, k)).replayed).toBe(true);
    expect(await balance(b)).toBe(250);

    expect((await pool.query(`SELECT * FROM verify_ledger()`)).rowCount).toBe(0);
    expect((await pool.query(`SELECT * FROM reconcile_accounts()`)).rowCount).toBe(0);
  });
});