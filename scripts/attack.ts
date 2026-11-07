const BASE = process.env.BASE_URL || "http://localhost:3000";
let failed = false;
const check = (name: string, ok: boolean, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name} ${extra}`);
  if (!ok) failed = true;
};

async function call(method: string, path: string, token?: string, body?: unknown, key?: string) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(key ? { "Idempotency-Key": key } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, replayed: res.headers.get("idempotent-replayed") };
}

async function login(email: string, password: string) {
  const r = await call("POST", "/auth/login", undefined, { email, password });
  if (!r.json?.token) throw new Error(`login failed for ${email}: ${r.status}`);
  return r.json.token as string;
}

async function main() {
  const run = Date.now();
  const alice = await login("alice@ledgerline.test", "Alice-demo-2026");
  const bob = await login("bob@ledgerline.test", "Bob-demo-2026");
  const aud = await login("auditor@ledgerline.test", "Auditor-demo-2026");
  const adm = await login("admin@ledgerline.test", "Admin-demo-2026");

  const accts = (await call("GET", "/accounts", alice)).json;
  const A = accts.find((a: any) => a.name === "Alice Current").id;
  const bal = async () =>
    (await call("GET", "/accounts", alice)).json.find((a: any) => a.id === A).balancePaise;

  // Top up so the script can be rerun: deposit Rs 5,000 (500000 paise).
  await call("POST", "/deposits", alice, { accountId: A, amountPaise: 500000 }, `topup-${run}`);
  const start = await bal();

  const k = `atk-${run}`;
  const w1 = await call("POST", "/withdrawals", alice, { accountId: A, amountPaise: 100 }, k);
  const w2 = await call("POST", "/withdrawals", alice, { accountId: A, amountPaise: 100 }, k);
  check("withdrawal succeeds", w1.status === 201);
  check("replay flagged and same body", w2.replayed === "true" && JSON.stringify(w1.json) === JSON.stringify(w2.json));
  check("replay moved money once", (await bal()) === start - 100);

  const diff = await call("POST", "/withdrawals", alice, { accountId: A, amountPaise: 999 }, k);
  check("same key, different amount -> 422", diff.status === 422);

  const noKey = await call("POST", "/withdrawals", alice, { accountId: A, amountPaise: 100 });
  check("missing Idempotency-Key -> 400", noKey.status === 400);

  check("Bob cannot read Alice's account (404)", (await call("GET", `/accounts/${A}`, bob)).status === 404);
  const steal = await call("POST", "/withdrawals", bob, { accountId: A, amountPaise: 100 }, `steal-${run}`);
  check("Bob cannot withdraw from Alice (404)", steal.status === 404);

  const au = await call("POST", "/withdrawals", aud, { accountId: A, amountPaise: 100 }, `aud-${run}`);
  check("auditor cannot move money (403)", au.status === 403);
  const ad = await call("POST", "/withdrawals", adm, { accountId: A, amountPaise: 100 }, `adm-${run}`);
  check("admin cannot move money (403)", ad.status === 403);

  const neg = await call("POST", "/withdrawals", alice, { accountId: A, amountPaise: -5 }, `neg-${run}`);
  check("negative amount rejected (400)", neg.status === 400);
  check("no token -> 401", (await call("GET", "/accounts")).status === 401);

  const before = await bal();
  const race = await Promise.all(
    Array.from({ length: 10 }, (_, n) =>
      call("POST", "/withdrawals", alice, { accountId: A, amountPaise: before }, `race-${run}-${n}`)
    )
  );
  check("race: exactly one of 10 full-balance withdrawals wins", race.filter((r) => r.status === 201).length === 1);
  check("race: balance is 0, not negative", (await bal()) === 0);

  const v = await call("GET", "/admin/verify-ledger", adm);
  check("verify-ledger ok", v.json?.ok === true);
  check("holder cannot call verify-ledger (403)", (await call("GET", "/admin/verify-ledger", alice)).status === 403);

  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });