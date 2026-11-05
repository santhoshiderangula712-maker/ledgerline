\# Decisions



\- \*\*Stack:\*\* Node 20 + TypeScript + Fastify, PostgreSQL (raw SQL via `pg` for all money paths).

\- \*\*Money:\*\* integer paise in BIGINT. No floats or decimals anywhere. Single currency (INR); multi-currency deliberately not built.

\- \*\*Ledger:\*\* double-entry. Each transaction has >= 2 postings summing to zero. Deposits/withdrawals post against a system EXTERNAL account.

\- \*\*Invariant:\*\* SUM(all postings) = 0; SUM(customer balances) = total deposits - total withdrawals.

\- \*\*Overdraft:\*\* none. Floor is 0, enforced in a locked transaction and by a DB CHECK.

\- \*\*Atomicity:\*\* one DB transaction per movement, SELECT ... FOR UPDATE on both accounts in ascending id order, balance checked after locking.

\- \*\*Idempotency:\*\* key per (user, key) with request hash, stored in a table with a UNIQUE constraint, claimed with INSERT ... ON CONFLICT.

\- \*\*Append-only:\*\* revoke UPDATE/DELETE for the app role + triggers that raise + hash chain.

\- \*\*Roles:\*\* admin, holder, auditor (read-only).

\- \*\*Not building:\*\* multi-currency, scheduled transfers, overdrafts.

