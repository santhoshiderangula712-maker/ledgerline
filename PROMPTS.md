\# PROMPTS.md



Each entry: date | what I asked | what it produced | what was wrong | what I did instead | commit link.



\## 2026-11-05

\- Asked Claude for a 7-day plan and tonight's setup steps from the brief.

\- It gave Linux-style commands (`mkdir -p`, `git init` before cloning) that misbehaved on my Windows machine and created a stray `-p` folder. I deleted the folder and re-cloned the repo from GitHub.

\- (Money-integrity entries will come from the actual code, starting Friday.)


## 2026-11-05 (second entry): leaked database credential

- **What I asked:** Claude helped me set up a Neon Postgres database and a `.env` file, and told me to copy the connection string from Neon.
- **What went wrong (my mistake, not the AI's):** I pasted the full connection string, including the real password, into the chat while asking for help. That exposed the credential.
- **What the AI did:** It told me to treat the credential as compromised and to reset the password before doing anything else.
- **What I did instead:** I reset the `neondb_owner` password in Neon, put the new connection string only in my local `.env` file and in Render's environment settings, and confirmed `.env` is ignored by git (`git status` does not list it).
- **Rule going forward:** secrets go only in `.env` and the host's environment settings. Never in chat, README, PROMPTS.md or a commit. If I need help with an error, I share the error text only.
- **Commit:** https://github.com/santhoshiderangula712-maker/ledgerline/commit/4cdb699

## 2026-11-06: idempotent replay returned a different response shape (money/idempotency)

- **Asked:** Claude to write `moveMoney` with idempotent replays.
- **Produced:** the first call returned an in-memory object, while replays returned the `JSONB` copy read back from the database.
- **Wrong:** the two had different key order, so "the second call returns the first result" was only true in value, not in exact form. My smoke test (`replay: all answers identical`) caught it. The money itself moved only once.
- **Fixed:** both the success path and the refusal path now return `RETURNING response_body` from the stored row, so the first call and every replay come from the same source.
- **Commit:** https://github.com/santhoshiderangula712-maker/ledgerline/commit/3408b79


## 2026-11-07: statement order could contradict the real balance order (money/ledger)

- **Asked:** Claude to design the postings table and the per-account statement with a running balance.
- **Produced:** `created_at TIMESTAMPTZ DEFAULT now()` on postings and refused attempts, and a statement sorted by `created_at`.
- **Wrong:** in Postgres `now()` is the time the transaction **started**, not when the row was written. Two concurrent transfers can start in one order but acquire the account lock in the other, so the statement could show running balances out of sequence. It looks like a ledger inconsistency even though the money is right.
- **How I caught it:** I wrote a test first (40 concurrent transfers, then replay each account's postings in `created_at` order and compare with `balance_after_paise`). It failed before the fix: expected 99900, received 100000.
- **Fixed:** postings and refusals are now stamped with `clock_timestamp()` at insert time, which happens after the account lock, so timestamps follow the true balance order. The test passes; THREATS.md row 21 records it.
- **Commit:** https://github.com/santhoshiderangula712-maker/ledgerline/commit/COMMIT_ORDER

## 2026-11-07: AI's "hardening" broke the concurrency test (concurrency)

- **Asked:** Claude why `/admin/verify-ledger` returned a 500 once inside the full test run (it passed alone).
- **Produced:** a suggestion to harden `src/db.ts` with `connectionTimeoutMillis: 15000` plus an idle-client error handler.
- **Wrong:** the 15-second connection timeout made the 40-parallel-transfers test fail with `timeout exceeded when trying to connect`. The transfers are serialised by the account row locks and the ledger advisory lock, so later requests legitimately wait longer than 15 seconds for a pooled connection. The AI treated queueing as an error. The test had passed before the "fix".
- **Fixed:** removed the connection timeout, kept the idle-client error handler, re-ran all tests (green). I recorded the underlying property in THREATS.md row 25: all money movement is serialised by design, so correctness is traded for throughput. The original one-off 500 was never reproduced and I have not explained it.
- **Commit:** https://github.com/santhoshiderangula712-maker/ledgerline/commit/Harden pool: handle idle client errors

## 2026-11-07: a test that claimed to cover deadlock prevention did not (concurrency)

- **Asked:** Claude to write concurrency tests, including opposing transfers (A to B and B to A) to prove deadlock safety.
- **Produced:** the "opposing transfers, no deadlock, total conserved" test, presented as covering lock ordering.
- **Wrong:** I ran a mutation check, removing `ORDER BY id` from the lock query. The test still passed, so it does not prove that locks are taken in a fixed order. Postgres tends to return primary-key lookups in id order anyway, so the missing `ORDER BY` changes nothing in practice. I also found that removing `FOR UPDATE` entirely did not fail the opposing-transfer test either, because the row UPDATE takes its own lock.
- **Did instead:** I did not claim more than the test shows. THREATS.md row 13 lists deadlock prevention as an open test gap, and the mutation table records mutation 5 as "not caught". The other four mutations (remove `FOR UPDATE`, remove the balance check, remove the membership check, remove the idempotency claim) were each caught by the intended tests.
- **Commit:** https://github.com/santhoshiderangula712-maker/ledgerline/commit/Add THREATS.md with mutation check results

## 2026-11-07: AI-written test invalidated its own fixtures (testing)

- **Asked:** Claude to write the HTTP-level test suite (roles, 404 versus 403, statements).
- **Produced:** an "expired session is refused" test that ran `UPDATE sessions SET expires_at = ... WHERE user_id = <owner>`.
- **Wrong:** that expired **every** session for the shared test user, including the token the later tests relied on. Seven tests then failed with `401` for the wrong reason, which looked like seven authorisation bugs.
- **Fixed:** the expiry test now creates its own throwaway user, and first asserts the token works before expiring it. All API tests pass.
- **Commit:** https://github.com/santhoshiderangula712-maker/ledgerline/commit/Add Vitest suite

## 2026-11-06: AI misdiagnosed a module-system problem (engineering)

- **Asked:** Claude to write a migration runner, then why `npx tsx db/migrate.ts` failed with `ERR_MODULE_NOT_FOUND`.
- **Produced:** a confident claim that the project was an ES-module setup, so `__dirname` would crash, and a rewrite of the directory lookup to `process.cwd()`.
- **Wrong:** the real cause was that `db/migrate.ts` had never been saved (the file did not exist). `package.json` has no `"type": "module"` (Vite later warned that the file was being loaded as CommonJS), so the ESM claim was unfounded. The `process.cwd()` change was harmless and I kept it, but I should not have trusted the explanation.
- **Did instead:** checked the directory listing, created the file, and ran the migration. Lesson recorded: read the evidence (a `dir` listing) before accepting the AI's diagnosis.
- **Commit:** https://github.com/santhoshiderangula712-maker/ledgerline/commit/cb8bcc4

## Addendum, 2026-11-07: credential leaked twice more (security)

- After the first exposure (2026-11-05, entry above) I pasted a database connection string with its password into the chat again, twice on 2026-11-07: the test-branch string, then an owner string. Each time Claude told me to rotate immediately and I did.
- The repeated mistake led to a process change: connection strings live only in `.env`, `.env.test.local` and the host's environment settings, and when asking for help I replace the password with `xxxx`. The project now also uses three separate credentials (owner for migrations, a restricted `ledgerline_runtime` role for the running app, and a separate test branch), so one leak no longer exposes everything.