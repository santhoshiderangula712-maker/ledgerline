\# THREATS.md



How I believe the money or the ledger could be broken, what I did about each, which test proves it, and what I knowingly left open. "Proven by" names a test in `tests/`. Statuses: \*\*Closed\*\*, \*\*Mitigated\*\* (reduced but not eliminated), \*\*Open\*\* (known, not fixed), \*\*Accepted\*\* (deliberate trade-off).



\## Model in one paragraph



Double-entry ledger in PostgreSQL, all money as integer paise. Every movement is one database transaction (READ COMMITTED) that: claims the idempotency key, authorises the actor, locks the accounts involved in ascending id order with `SELECT ... FOR UPDATE`, checks balance and status \*\*after\*\* the lock, writes balanced postings plus the balance updates, and stores the response under the key. Deposits and withdrawals post against one system EXTERNAL account, so the global invariant is: sum of all postings = 0, and sum of customer balances = net external deposits minus withdrawals. The database independently enforces: no negative customer balance (CHECK), balanced transactions (deferred constraint trigger), append-only ledger tables (triggers), and a hash chain verified by `verify\_ledger()`.



\## Money threats



| # | Threat | Defence | Proven by | Status |

|---|---|---|---|---|

| 1 | \*\*Parallel overdraw\*\*: many withdrawals race past the balance | Row lock on the account, balance checked after the lock; DB CHECK `balance >= 0` as second layer | `20 parallel withdrawals...`, `many small withdrawals racing` | Closed |

| 2 | \*\*Replayed request\*\* (retry, double-click) pays twice | Key claimed with `INSERT ... ON CONFLICT DO NOTHING` inside the money transaction; replay returns the stored response; replays logged in `idempotency\_replays` | `sequential replay...`, `same key sent 20 times in parallel...` | Closed |

| 3 | \*\*Retry arriving while the first is in flight\*\* | The duplicate's INSERT blocks on the unique index until the first commits, then replays its answer. If the first rolled back, the duplicate proceeds and pays once. The in-flight state is therefore never visible; the `409 request\_in\_flight` branch exists but is effectively unreachable | the 20-parallel replay test | Closed |

| 4 | \*\*Same key, different body\*\* | Request hash stored with the key; mismatch returns 422 and moves nothing | `same key with a different amount...` | Closed |

| 5 | \*\*Key collision across users\*\* | Uniqueness is `(user\_id, key)`, so one user can neither replay nor block another's key | `same key used by two different users...` | Closed |

| 6 | \*\*Moving money out of someone else's account (IDOR)\*\* | Membership and per-action permission checked server-side on every request, before any account lock; answered with 404 so existence is not leaked | `another user cannot withdraw...`, `...deposit into my account...`, `a member without the withdraw permission...` | Closed |

| 7 | \*\*Auditor or admin moving money\*\* | Only role `holder` may move money, checked inside `moveMoney` (not just the route), even for listed members | `auditor and admin cannot move money...`, API role tests | Closed |

| 8 | \*\*Bad amounts\*\*: zero, negative, fractional, NaN, huge, float rounding | Integer paise only, 1..1,000,000,000 per request, validated before any DB work | `rejects invalid amount` (5 cases) | Closed |

| 9 | \*\*Self-transfer, non-existent or EXTERNAL destination\*\* | Validation plus a post-lock check; a "transfer" can never touch EXTERNAL (that would be a withdrawal skipping its checks) | `rejects a transfer to the same account`, `non-existent account...` | Closed |

| 10 | \*\*Failure halfway\*\* (debit written, credit fails) | Single transaction; any error rolls back postings, balances \*\*and\*\* the idempotency key, so a retry can succeed | `an error after the debit and before the credit...` (fault injected with a trigger) | Closed |

| 11 | \*\*Refusals lost on rollback\*\* | A business refusal moves no money, so it is \*committed\* with the stored response rather than rolled back | `20 parallel...` asserts 19 `refused\_attempts` rows; `replaying a refused request...` | Closed |

| 12 | \*\*Frozen account\*\* | Status read after the lock, so a freeze takes effect for every later movement | `a frozen account refuses outgoing and incoming money...` | Mitigated: a freeze racing an in-flight transfer is correct by design (freeze waits for the row lock) but \*\*not tested\*\* |

| 13 | \*\*Deadlock\*\* between A->B and B->A | Locks taken in ascending id order; the ledger advisory lock is always taken after account locks, so it cannot form a cycle | `opposing transfers...` passes | \*\*Open (test gap)\*\*: see mutation 5 below. Removing `ORDER BY id` did \*\*not\*\* make any test fail, because Postgres usually returns a primary-key lookup in id order anyway. The ordering is a design guarantee I could not prove by test |

| 14 | \*\*Isolation level changed\*\* | The idempotency claim relies on READ COMMITTED (a blocked duplicate must see the first commit). `REPEATABLE READ` or `SERIALIZABLE` would break it | n/a | Accepted: documented in code and DECISIONS.md, not enforced |



\## Ledger and tampering threats



| # | Threat | Defence | Proven by | Status |

|---|---|---|---|---|

| 15 | \*\*Edit or delete a ledger row\*\* | `BEFORE UPDATE OR DELETE` triggers raise on `transactions`, `postings`, `refused\_attempts`, `audit\_log`, `idempotency\_replays`; TRUNCATE blocked the same way | `UPDATE and DELETE ... are refused`, `TRUNCATE ... is refused` | Mitigated (see 16) |

| 16 | **Privileged tampering**: the table owner drops or disables a trigger | Hash chain: each posting stores the hash of the previous one, computed **in the database**; `verify_ledger()` recomputes it; `reconcile_accounts()` compares balances with postings. The running app connects as `ledgerline_runtime` (a member of `ledgerline_app`) with SELECT and INSERT only on ledger tables and no ownership, so it cannot disable or drop triggers or alter the ledger | `verify_ledger() detects a tampered posting`; `tests/role.test.ts` (4 tests, run as the restricted role) | **Mitigated**: the app can no longer tamper. **Still open**: the owner credential exists (used for migrations), and an owner or superuser can still rewrite everything; the head-hash export (threat 17) is not built |

| 17 | \*\*Deleting the newest rows\*\* | Chain verification alone cannot see the tail removed; `reconcile\_accounts()` would flag it only if balances are not rewritten too | none | \*\*Open\*\*: mitigation (periodically exporting the head hash outside the database) is not built |

| 18 | \*\*Unbalanced transaction\*\* | Deferred constraint trigger: postings of a transaction must sum to zero, checked at COMMIT | `a transaction whose postings do not sum to zero cannot commit` | Closed |

| 19 | \*\*Balance driven negative by direct SQL\*\* | `CHECK` constraint on customer accounts | `a customer balance cannot be set below zero...` | Closed |

| 20 | \*\*Hiding refused attempts or authorisation failures\*\* | Refusals in `refused\_attempts` (append-only); authorisation denials in `audit\_log`, \*\*not\*\* the victim's statement, so an attacker cannot pollute someone else's statement | `denied attempts are written to the audit log` | Closed |



\## Access and operations threats



| # | Threat | Defence | Status |

|---|---|---|---|

| 22 | \*\*Login brute force\*\* | 10 attempts per minute per IP; dummy hash verified for unknown emails so timing does not reveal valid emails; failures audited | \*\*Mitigated\*\*: the limiter is in memory (resets on restart, per instance) and `trustProxy` is on, so a client able to forge `X-Forwarded-For` may evade the per-IP limit |

| 23 | \*\*Session theft or reuse\*\* | Random 256-bit tokens, stored only as SHA-256 hashes, 8-hour expiry, checked against the database on every request, so logout and role changes apply immediately | \*\*Mitigated\*\*: tokens are bearer tokens; no refresh, no device binding |

| 24 | \*\*Money endpoints abused for volume\*\* | Per-request cap | \*\*Open\*\*: no rate limit on money routes, no daily limit per account |

| 25 | \*\*Throughput as a weakness\*\* | All money movement is serialised by the EXTERNAL account row and the ledger-wide advisory lock that extends the hash chain. Correctness over speed | \*\*Accepted\*\*: under load, requests queue (safe, but slow). Observed in testing: 40 parallel transfers take tens of seconds against a remote database |

| 26 | \*\*Idempotency keys kept forever\*\* | Simple and safe; a very old key still returns its original answer | \*\*Accepted\*\*: storage grows without bound; no expiry job |

| 27 | \*\*Deposits create money\*\* | Deposits and withdrawals are the only external flows and are the stated exception to conservation. A holder can deposit into their own account (no real payment rail) | \*\*Accepted\*\*: a real system would require an external confirmation; this one demonstrates the ledger |

| 28 | \*\*Secrets\*\* | `.env` and `.env.test.local` are git-ignored; tests read only the test branch file | \*\*Mitigated\*\*: a database password was pasted into a chat twice and rotated each time (see PROMPTS.md) |

| 29 | \*\*Public demo credentials\*\* | Required by the brief; fake money only | Accepted |

| 30 | **App compromise** (SQL injection or a code bug) | All queries are parameterised. The app's database role cannot update, delete, truncate or alter ledger tables, so even full SQL control as the app cannot rewrite history, only append (`tests/role.test.ts`) | **Mitigated**: the app role can still INSERT into `postings`. The balance, chain and zero-sum triggers constrain it, but it could append a balanced, validly chained, fraudulent transaction |

| 31 | **UI-side risks**: script injection through statement data, token theft from the browser | The page builds every element from text, never from HTML strings; a content-security policy restricts it to its own origin; money forms reuse one Idempotency-Key per logical request, so a double-click or retry cannot pay twice | **Mitigated**: the session token is kept in `sessionStorage` (cleared when the tab closes) and is readable by script on the page, so an XSS bug would expose it. The CSP allows inline script, which weakens that protection |



\## Mutation checks I performed



I changed one line in `src/money.ts` at a time, ran the tests, and restored the file with `git checkout`.



| # | Mutation | Result |

|---|---|---|

| 1 | Remove `FOR UPDATE` from the account lock query | \*\*Caught\*\*: both withdrawal-race tests fail. The database CHECK still prevented a negative balance. The opposing-transfer and deposit-vs-withdrawal tests did \*not\* fail (the row UPDATE takes a lock anyway) |

| 2 | Disable the balance check (`from.balance < amount` becomes `false`) | \*\*Caught\*\* by 4 tests; the CHECK constraint still blocked negatives, so both layers must be removed to overdraw |

| 3 | Disable the membership check | \*\*Caught\*\* by 4 authorisation tests; the independent role check still blocked auditor/admin |

| 4 | Remove `ON CONFLICT (user\_id, key) DO NOTHING` | \*\*Caught\*\* by 4 idempotency tests; the unique constraint still prevented a double payment |

| 5 | Remove `ORDER BY id` from the lock query | \*\*Not caught\*\*: all tests passed. Gap recorded as threat 13 |



\## What I deliberately did not build



Multiple currencies, overdrafts, holds and authorisations, scheduled or batch transfers, reversals (the schema has `reverses\_txn\_id` and a `reversal` type, but no endpoint), per-account daily limits, password change and user disabling, adding a second member to an existing account through the API, and AI anomaly flagging. A smaller system whose balances are always right was the goal.

