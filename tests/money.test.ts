import { describe, it, expect, afterAll } from "vitest";
import { pool, mkUser, mkAccount, balance, sumAllPostings, deposit, withdraw, transfer, key } from "./helpers.js";

afterAll(() => pool.end());

describe("conservation", () => {
  it("random deposits, withdrawals and transfers: balances equal net external flow, none negative", async () => {
    const u = await mkUser();
    const [a, b, c] = [await mkAccount(u), await mkAccount(u), await mkAccount(u)];
    const accts = [a, b, c];
    let seed = 12345;
    const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n);

    let netExternal = 0;
    for (let batch = 0; batch < 6; batch++) {
      const ops = Array.from({ length: 10 }, () => {
        const kind = rnd(3);
        const amt = 1 + rnd(5000);
        const x = accts[rnd(3)];
        const y = accts[(accts.indexOf(x) + 1 + rnd(2)) % 3];
        return { kind, amt, x, y };
      });
      const results = await Promise.all(
        ops.map((o) =>
          o.kind === 0 ? deposit(u, o.x, o.amt) : o.kind === 1 ? withdraw(u, o.x, o.amt) : transfer(u, o.x, o.y, o.amt)
        )
      );
      results.forEach((r, i) => {
        if (r.httpStatus !== 201) return;
        if (ops[i].kind === 0) netExternal += ops[i].amt;
        if (ops[i].kind === 1) netExternal -= ops[i].amt;
      });
    }
    const balances = await Promise.all(accts.map(balance));
    expect(balances.reduce((s, x) => s + x, 0)).toBe(netExternal);
    expect(Math.min(...balances)).toBeGreaterThanOrEqual(0);
    expect(await sumAllPostings()).toBe("0");
    expect((await pool.query(`SELECT * FROM reconcile_accounts()`)).rowCount).toBe(0);
  });

  it("a transfer moves exactly the amount from one account to the other", async () => {
    const u = await mkUser();
    const [a, b] = [await mkAccount(u), await mkAccount(u)];
    await deposit(u, a, 1000);
    const r = await transfer(u, a, b, 400);
    expect(r.httpStatus).toBe(201);
    expect([await balance(a), await balance(b)]).toEqual([600, 400]);
  });
});

describe("concurrency", () => {
  it("20 parallel withdrawals of the whole balance: exactly one succeeds, 19 refusals are recorded", async () => {
    const u = await mkUser();
    const a = await mkAccount(u);
    await deposit(u, a, 10000);
    const res = await Promise.all(Array.from({ length: 20 }, () => withdraw(u, a, 10000)));
    expect(res.filter((r) => r.httpStatus === 201)).toHaveLength(1);
    expect(res.filter((r) => r.httpStatus === 422)).toHaveLength(19);
    expect(await balance(a)).toBe(0);
    const refused = await pool.query(
      `SELECT count(*)::int AS n FROM refused_attempts WHERE account_id = $1 AND reason = 'insufficient_funds'`,
      [a]
    );
    expect(refused.rows[0].n).toBe(19);
  });

  it("many small withdrawals racing: total withdrawn never exceeds the balance", async () => {
    const u = await mkUser();
    const a = await mkAccount(u);
    await deposit(u, a, 1000);
    const res = await Promise.all(Array.from({ length: 30 }, () => withdraw(u, a, 70)));
    const ok = res.filter((r) => r.httpStatus === 201).length;
    expect(ok).toBe(14); // floor(1000 / 70)
    expect(await balance(a)).toBe(1000 - 14 * 70);
  });

  it("opposing transfers A->B and B->A in parallel: no deadlock, total conserved", async () => {
    const u = await mkUser();
    const [a, b] = [await mkAccount(u), await mkAccount(u)];
    await deposit(u, a, 10000);
    await deposit(u, b, 10000);
    const res = await Promise.all(
      Array.from({ length: 40 }, (_, n) => (n % 2 ? transfer(u, a, b, 100) : transfer(u, b, a, 100)))
    );
    expect(res.every((r) => r.httpStatus === 201)).toBe(true);
    expect((await balance(a)) + (await balance(b))).toBe(20000);
  });

  it("a deposit racing a withdrawal on the same account stays consistent", async () => {
    const u = await mkUser();
    const a = await mkAccount(u);
    await deposit(u, a, 500);
    const res = await Promise.all([
      ...Array.from({ length: 10 }, () => deposit(u, a, 100)),
      ...Array.from({ length: 10 }, () => withdraw(u, a, 100)),
    ]);
    const net = res.reduce((s, r, i) => (r.httpStatus === 201 ? s + (i < 10 ? 100 : -100) : s), 0);
    expect(await balance(a)).toBe(500 + net);
    expect((await pool.query(`SELECT * FROM reconcile_accounts()`)).rowCount).toBe(0);
  });
});

describe("idempotency", () => {
  it("same key sent 20 times in parallel pays once; all answers identical; replays are logged", async () => {
    const u = await mkUser();
    const a = await mkAccount(u);
    const k = key();
    const res = await Promise.all(Array.from({ length: 20 }, () => deposit(u, a, 5000, k)));
    expect(res.filter((r) => !r.replayed)).toHaveLength(1);
    expect(res.filter((r) => r.replayed)).toHaveLength(19);
    expect(new Set(res.map((r) => JSON.stringify(r.body))).size).toBe(1);
    expect(await balance(a)).toBe(5000);
    const logged = await pool.query(
      `SELECT count(*)::int AS n FROM idempotency_replays r
       JOIN idempotency_keys k ON k.id = r.idempotency_key_id WHERE k.user_id = $1 AND k.key = $2`,
      [u, k]
    );
    expect(logged.rows[0].n).toBe(19);
  });

  it("sequential replay returns the first result and moves nothing", async () => {
    const u = await mkUser();
    const a = await mkAccount(u);
    const k = key();
    const first = await deposit(u, a, 700, k);
    const second = await deposit(u, a, 700, k);
    expect(second.replayed).toBe(true);
    expect(second.body).toEqual(first.body);
    expect(await balance(a)).toBe(700);
  });

  it("same key with a different amount is rejected (422) and moves nothing", async () => {
    const u = await mkUser();
    const a = await mkAccount(u);
    const k = key();
    await deposit(u, a, 100, k);
    await expect(deposit(u, a, 999, k)).rejects.toMatchObject({ httpStatus: 422, code: "idempotency_key_reused" });
    expect(await balance(a)).toBe(100);
  });

  it("replaying a refused request returns the same refusal and records it only once", async () => {
    const u = await mkUser();
    const a = await mkAccount(u);
    const k = key();
    const r1 = await withdraw(u, a, 500, k);
    const r2 = await withdraw(u, a, 500, k);
    expect(r1.httpStatus).toBe(422);
    expect(r2.replayed).toBe(true);
    expect(r2.body).toEqual(r1.body);
    const n = await pool.query(`SELECT count(*)::int AS n FROM refused_attempts WHERE account_id = $1`, [a]);
    expect(n.rows[0].n).toBe(1);
  });

  it("the same key used by two different users does not collide (keys are per user)", async () => {
    const [u1, u2] = [await mkUser(), await mkUser()];
    const [a1, a2] = [await mkAccount(u1), await mkAccount(u2)];
    const k = key();
    await deposit(u1, a1, 100, k);
    const r = await deposit(u2, a2, 100, k);
    expect(r.replayed).toBe(false);
    expect(await balance(a2)).toBe(100);
  });
});

describe("authorisation", () => {
  it("another user cannot withdraw from, or transfer out of, my account (404) and nothing moves", async () => {
    const [owner, mallory] = [await mkUser(), await mkUser()];
    const a = await mkAccount(owner);
    const m = await mkAccount(mallory);
    await deposit(owner, a, 1000);
    await expect(withdraw(mallory, a, 100)).rejects.toMatchObject({ httpStatus: 404 });
    await expect(transfer(mallory, a, m, 100)).rejects.toMatchObject({ httpStatus: 404 });
    expect(await balance(a)).toBe(1000);
    expect(await balance(m)).toBe(0);
  });

  it("another user cannot deposit into my account either (404)", async () => {
    const [owner, other] = [await mkUser(), await mkUser()];
    const a = await mkAccount(owner);
    await expect(deposit(other, a, 100)).rejects.toMatchObject({ httpStatus: 404 });
    expect(await balance(a)).toBe(0);
  });

  it("auditor and admin cannot move money, even when listed as members of the account", async () => {
    const [owner, auditor, admin] = [await mkUser(), await mkUser("auditor"), await mkUser("admin")];
    const a = await mkAccount(owner, [owner, auditor, admin]);
    await deposit(owner, a, 1000);
    await expect(withdraw(auditor, a, 100)).rejects.toMatchObject({ httpStatus: 403 });
    await expect(withdraw(admin, a, 100)).rejects.toMatchObject({ httpStatus: 403 });
    expect(await balance(a)).toBe(1000);
  });

  it("a member without the withdraw permission cannot withdraw", async () => {
    const u = await mkUser();
    const a = await mkAccount(u);
    await deposit(u, a, 500);
    await pool.query(`UPDATE account_members SET can_withdraw = false WHERE account_id = $1`, [a]);
    await expect(withdraw(u, a, 100)).rejects.toMatchObject({ httpStatus: 404 });
    expect(await balance(a)).toBe(500);
  });

  it("denied attempts are written to the audit log", async () => {
    const [owner, mallory] = [await mkUser(), await mkUser()];
    const a = await mkAccount(owner);
    await expect(withdraw(mallory, a, 100)).rejects.toBeDefined();
    const r = await pool.query(`SELECT count(*)::int AS n FROM audit_log WHERE actor_id = $1 AND action = 'authz_denied'`, [mallory]);
    expect(r.rows[0].n).toBe(1);
  });
});

describe("validation and account state", () => {
  it.each([0, -5, 1.5, NaN, 2_000_000_000])("rejects invalid amount %s (400)", async (amt) => {
    const u = await mkUser();
    const a = await mkAccount(u);
    await expect(deposit(u, a, amt as number)).rejects.toMatchObject({ httpStatus: 400 });
    expect(await balance(a)).toBe(0);
  });

  it("rejects a transfer to the same account (400)", async () => {
    const u = await mkUser();
    const a = await mkAccount(u);
    await deposit(u, a, 100);
    await expect(transfer(u, a, a, 10)).rejects.toMatchObject({ httpStatus: 400 });
  });

  it("transfer to a non-existent account is rejected and nothing moves", async () => {
    const u = await mkUser();
    const a = await mkAccount(u);
    await deposit(u, a, 100);
    await expect(transfer(u, a, 999999999, 10)).rejects.toMatchObject({ httpStatus: 404 });
    expect(await balance(a)).toBe(100);
  });

  it("a frozen account refuses outgoing and incoming money, and the refusal is recorded", async () => {
    const u = await mkUser();
    const [a, b] = [await mkAccount(u), await mkAccount(u)];
    await deposit(u, a, 500);
    await deposit(u, b, 50);
    await pool.query(`UPDATE accounts SET status = 'frozen' WHERE id = $1`, [a]);
    expect((await withdraw(u, a, 100)).httpStatus).toBe(422);
    expect((await transfer(u, b, a, 1)).httpStatus).toBe(422);
    expect(await balance(a)).toBe(500);
    const n = await pool.query(`SELECT count(*)::int AS n FROM refused_attempts WHERE account_id = $1 OR counterparty_account_id = $1`, [a]);
    expect(n.rows[0].n).toBeGreaterThanOrEqual(2);
  });
});

describe("failure halfway", () => {
  it("an error after the debit and before the credit rolls everything back; the key is reusable afterwards", async () => {
    const u = await mkUser();
    const [a, b] = [await mkAccount(u), await mkAccount(u)];
    await deposit(u, a, 1000);
    const before = await pool.query(`SELECT count(*)::int AS n FROM postings WHERE account_id = $1`, [a]);

    const fn = `fail_${b}`;
    await pool.query(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected failure'; END $$`);
    await pool.query(
      `CREATE TRIGGER ${fn} BEFORE INSERT ON postings FOR EACH ROW WHEN (NEW.account_id = ${b}) EXECUTE FUNCTION ${fn}()`
    );
    const k = key();
    try {
      await expect(transfer(u, a, b, 300, k)).rejects.toThrow(/injected failure/);
    } finally {
      await pool.query(`DROP TRIGGER ${fn} ON postings`);
      await pool.query(`DROP FUNCTION ${fn}()`);
    }

    expect(await balance(a)).toBe(1000);
    expect(await balance(b)).toBe(0);
    const after = await pool.query(`SELECT count(*)::int AS n FROM postings WHERE account_id = $1`, [a]);
    expect(after.rows[0].n).toBe(before.rows[0].n);

    const retry = await transfer(u, a, b, 300, k);
    expect(retry.httpStatus).toBe(201);
    expect(retry.replayed).toBe(false);
    expect([await balance(a), await balance(b)]).toEqual([700, 300]);
  });
});
describe("statement order", () => {
  it("under concurrency, ordering an account's postings by created_at gives a consistent running balance", async () => {
    const u = await mkUser();
    const [a, b] = [await mkAccount(u), await mkAccount(u)];
    await deposit(u, a, 100000);
    await deposit(u, b, 100000);
    await Promise.all(
      Array.from({ length: 40 }, (_, n) => (n % 2 ? transfer(u, a, b, 100) : transfer(u, b, a, 100)))
    );
    for (const acct of [a, b]) {
      const rows = (
        await pool.query(
          `SELECT amount_paise, balance_after_paise FROM postings WHERE account_id = $1 ORDER BY created_at, id`,
          [acct]
        )
      ).rows;
      let running = 0;
      for (const r of rows) {
        running += Number(r.amount_paise);
        expect(Number(r.balance_after_paise)).toBe(running);
      }
    }
  });
});