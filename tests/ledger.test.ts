import { describe, it, expect, afterAll } from "vitest";
import { pool, mkUser, mkAccount, deposit, key } from "./helpers.js";

afterAll(() => pool.end());

describe("append-only ledger", () => {
  it("UPDATE and DELETE on postings, transactions, refused_attempts and audit_log are refused", async () => {
    const u = await mkUser();
    const a = await mkAccount(u);
    await deposit(u, a, 100);
    await pool.query(`INSERT INTO refused_attempts (account_id, initiated_by, type, reason) VALUES ($1, $2, 'withdrawal', 'test')`, [a, u]);
    await pool.query(`INSERT INTO audit_log (actor_id, action) VALUES ($1, 'test')`, [u]);

    const p = (await pool.query(`SELECT id, txn_id FROM postings WHERE account_id = $1 LIMIT 1`, [a])).rows[0];
    const statements = [
      [`UPDATE postings SET amount_paise = 1 WHERE id = $1`, [p.id]],
      [`DELETE FROM postings WHERE id = $1`, [p.id]],
      [`UPDATE transactions SET type = 'transfer' WHERE id = $1`, [p.txn_id]],
      [`DELETE FROM transactions WHERE id = $1`, [p.txn_id]],
      [`UPDATE refused_attempts SET reason = 'x' WHERE account_id = $1`, [a]],
      [`DELETE FROM refused_attempts WHERE account_id = $1`, [a]],
      [`UPDATE audit_log SET action = 'x' WHERE actor_id = $1`, [u]],
      [`DELETE FROM audit_log WHERE actor_id = $1`, [u]],
    ] as const;
    for (const [sql, params] of statements)
      await expect(pool.query(sql, params as unknown[]), sql).rejects.toThrow(/append-only/);
  });

  it.each(["postings", "transactions", "refused_attempts", "audit_log", "idempotency_replays"])(
    "TRUNCATE %s is refused",
    async (t) => {
      await expect(pool.query(`TRUNCATE ${t} CASCADE`)).rejects.toThrow(/append-only/);
    }
  );

  it("verify_ledger() detects a tampered posting (tamper inside a transaction that is rolled back)", async () => {
    const u = await mkUser();
    const a = await mkAccount(u);
    await deposit(u, a, 250);
    const id = Number((await pool.query(`SELECT id FROM postings WHERE account_id = $1 LIMIT 1`, [a])).rows[0].id);

    expect((await pool.query(`SELECT * FROM verify_ledger()`)).rowCount).toBe(0);

    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query(`ALTER TABLE postings DISABLE TRIGGER postings_no_mutate`);
      await c.query(`UPDATE postings SET amount_paise = amount_paise + 1 WHERE id = $1`, [id]);
      const r = await c.query(`SELECT bad_posting_id FROM verify_ledger()`);
      expect(r.rows.map((x) => Number(x.bad_posting_id))).toContain(id);
    } finally {
      await c.query("ROLLBACK");
      c.release();
    }
    expect((await pool.query(`SELECT * FROM verify_ledger()`)).rowCount).toBe(0);
  });
});

describe("database-level guards (the last line of defence)", () => {
  it("a transaction whose postings do not sum to zero cannot commit", async () => {
    const u = await mkUser();
    const a = await mkAccount(u);
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      const t = await c.query(`INSERT INTO transactions (type, initiated_by) VALUES ('deposit', $1) RETURNING id`, [u]);
      await c.query(
        `INSERT INTO postings (txn_id, account_id, amount_paise, balance_after_paise) VALUES ($1, $2, 100, 100)`,
        [t.rows[0].id, a]
      );
      await expect(c.query("COMMIT")).rejects.toThrow(/unbalanced/);
    } finally {
      await c.query("ROLLBACK").catch(() => {});
      c.release();
    }
  });

  it("a customer balance cannot be set below zero, even by direct SQL", async () => {
    const u = await mkUser();
    const a = await mkAccount(u);
    await expect(pool.query(`UPDATE accounts SET balance_paise = -1 WHERE id = $1`, [a])).rejects.toThrow(
      /no_negative_customer_balance/
    );
  });

  it("the unique (user, key) constraint rejects a duplicate idempotency key", async () => {
    const u = await mkUser();
    const k = key();
    await pool.query(`INSERT INTO idempotency_keys (user_id, key, request_hash) VALUES ($1, $2, 'h')`, [u, k]);
    await expect(
      pool.query(`INSERT INTO idempotency_keys (user_id, key, request_hash) VALUES ($1, $2, 'h')`, [u, k])
    ).rejects.toThrow(/idempotency_unique_per_user/);
  });

  it("there can only be one EXTERNAL account", async () => {
    await expect(pool.query(`INSERT INTO accounts (name, kind) VALUES ('second', 'external')`)).rejects.toThrow(
      /only_one_external_account/
    );
  });
});