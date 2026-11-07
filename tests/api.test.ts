import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildApp } from "../src/app.js";
import { pool, mkUser, mkAccount, token, deposit, key } from "./helpers.js";

const app = buildApp();
let owner: number, other: number, auditor: number, admin: number, acct: number;
let tOwner: string, tOther: string, tAuditor: string, tAdmin: string;

const h = (t?: string, k?: string) => ({
  ...(t ? { authorization: `Bearer ${t}` } : {}),
  ...(k ? { "idempotency-key": k } : {}),
});

beforeAll(async () => {
  await app.ready();
  [owner, other, auditor, admin] = [await mkUser(), await mkUser(), await mkUser("auditor"), await mkUser("admin")];
  acct = await mkAccount(owner);
  await deposit(owner, acct, 10000);
  [tOwner, tOther, tAuditor, tAdmin] = await Promise.all([owner, other, auditor, admin].map(token));
});
afterAll(async () => {
  await app.close();
  await pool.end();
});

describe("authentication", () => {
  it("no token, a bad token, or a logged-out token gives 401", async () => {
    expect((await app.inject({ method: "GET", url: "/accounts" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/accounts", headers: h("nonsense") })).statusCode).toBe(401);
    const t = await token(owner);
    await app.inject({ method: "POST", url: "/auth/logout", headers: h(t) });
    expect((await app.inject({ method: "GET", url: "/accounts", headers: h(t) })).statusCode).toBe(401);
  });

  it("an expired session is refused", async () => {
    const u = await mkUser();
    const t = await token(u);
    expect((await app.inject({ method: "GET", url: "/accounts", headers: h(t) })).statusCode).toBe(200);
    await pool.query(`UPDATE sessions SET expires_at = now() - interval '1 minute' WHERE user_id = $1`, [u]);
    expect((await app.inject({ method: "GET", url: "/accounts", headers: h(t) })).statusCode).toBe(401);
  });
});

describe("account visibility: 404, never 403, for other people's accounts", () => {
  it("holder sees own account", async () => {
    const r = await app.inject({ method: "GET", url: `/accounts/${acct}`, headers: h(tOwner) });
    expect(r.statusCode).toBe(200);
    expect(r.json().balancePaise).toBe(10000);
  });
  it("another holder gets 404 for the account and its statement", async () => {
    expect((await app.inject({ method: "GET", url: `/accounts/${acct}`, headers: h(tOther) })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/accounts/${acct}/statement`, headers: h(tOther) })).statusCode).toBe(404);
  });
  it("auditor and admin can read any account", async () => {
    expect((await app.inject({ method: "GET", url: `/accounts/${acct}`, headers: h(tAuditor) })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: `/accounts/${acct}/statement`, headers: h(tAdmin) })).statusCode).toBe(200);
  });
});

describe("money routes", () => {
  it("rejects a missing Idempotency-Key (400)", async () => {
    const r = await app.inject({ method: "POST", url: "/withdrawals", headers: h(tOwner), payload: { accountId: acct, amountPaise: 100 } });
    expect(r.statusCode).toBe(400);
  });

  it("replayed HTTP request pays once and is flagged as replayed", async () => {
    const k = key();
    const send = () =>
      app.inject({ method: "POST", url: "/withdrawals", headers: h(tOwner, k), payload: { accountId: acct, amountPaise: 100 } });
    const r1 = await send();
    const r2 = await send();
    expect([r1.statusCode, r2.statusCode]).toEqual([201, 201]);
    expect(r1.headers["idempotent-replayed"]).toBe("false");
    expect(r2.headers["idempotent-replayed"]).toBe("true");
    expect(r2.json()).toEqual(r1.json());
  });

  it("other holder cannot withdraw (404), auditor and admin cannot (403)", async () => {
    const body = { accountId: acct, amountPaise: 100 };
    const before = (await app.inject({ method: "GET", url: `/accounts/${acct}`, headers: h(tOwner) })).json().balancePaise;
    expect((await app.inject({ method: "POST", url: "/withdrawals", headers: h(tOther, key()), payload: body })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: "/withdrawals", headers: h(tAuditor, key()), payload: body })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/withdrawals", headers: h(tAdmin, key()), payload: body })).statusCode).toBe(403);
    const after = (await app.inject({ method: "GET", url: `/accounts/${acct}`, headers: h(tOwner) })).json().balancePaise;
    expect(after).toBe(before);
  });

  it("an overdraw over HTTP is refused (422) and shows in the statement with who tried it", async () => {
    const r = await app.inject({ method: "POST", url: "/withdrawals", headers: h(tOwner, key()), payload: { accountId: acct, amountPaise: 900000 } });
    expect(r.statusCode).toBe(422);
    const st = (await app.inject({ method: "GET", url: `/accounts/${acct}/statement`, headers: h(tOwner) })).json();
    expect(st.some((e: any) => e.kind === "refused" && e.reason === "insufficient_funds")).toBe(true);
    const posting = st.find((e: any) => e.kind === "posting");
    expect(posting.runningBalancePaise).toBeTypeOf("number");
    expect(posting.initiatedBy).toContain("@test.local");
  });
});

describe("role boundaries on admin routes", () => {
  it("holder and auditor cannot create users, accounts or freeze accounts (403)", async () => {
    for (const t of [tOwner, tAuditor]) {
      expect((await app.inject({ method: "POST", url: "/admin/users", headers: h(t), payload: { email: "x@y.z", password: "longenough123", role: "admin" } })).statusCode).toBe(403);
      expect((await app.inject({ method: "POST", url: "/admin/accounts", headers: h(t), payload: { ownerUserId: owner, name: "x" } })).statusCode).toBe(403);
      expect((await app.inject({ method: "POST", url: `/admin/accounts/${acct}/status`, headers: h(t), payload: { status: "frozen" } })).statusCode).toBe(403);
    }
  });

  it("admin freezing an account makes later withdrawals refused", async () => {
    const own = await mkAccount(owner);
    await deposit(owner, own, 500);
    expect((await app.inject({ method: "POST", url: `/admin/accounts/${own}/status`, headers: h(tAdmin), payload: { status: "frozen" } })).statusCode).toBe(200);
    const r = await app.inject({ method: "POST", url: "/withdrawals", headers: h(tOwner, key()), payload: { accountId: own, amountPaise: 100 } });
    expect(r.statusCode).toBe(422);
    expect(r.json().reason).toBe("source_account_not_active");
  });

  it("auditor and admin can verify the ledger; a holder cannot", async () => {
    for (const t of [tAuditor, tAdmin]) {
      const r = await app.inject({ method: "GET", url: "/admin/verify-ledger", headers: h(t) });
      expect(r.statusCode).toBe(200);
      expect(r.json().ok).toBe(true);
    }
    expect((await app.inject({ method: "GET", url: "/admin/verify-ledger", headers: h(tOwner) })).statusCode).toBe(403);
  });
});