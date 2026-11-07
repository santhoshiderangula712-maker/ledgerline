-- Group role used by the running application. NOLOGIN: nobody connects as this directly.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ledgerline_app') THEN
    CREATE ROLE ledgerline_app NOLOGIN;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO ledgerline_app;
REVOKE CREATE ON SCHEMA public FROM ledgerline_app;

-- Append-only tables: read and insert, nothing else.
GRANT SELECT, INSERT ON transactions, postings, refused_attempts, audit_log, idempotency_replays TO ledgerline_app;

-- Other tables: only what the application actually does.
GRANT SELECT, INSERT ON users, accounts, account_members, idempotency_keys, sessions TO ledgerline_app;
GRANT UPDATE (balance_paise, status) ON accounts TO ledgerline_app;
GRANT UPDATE (can_deposit, can_withdraw, can_transfer) ON account_members TO ledgerline_app;
GRANT UPDATE (status, response_status, response_body, completed_at) ON idempotency_keys TO ledgerline_app;
GRANT UPDATE (revoked_at) ON sessions TO ledgerline_app;

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ledgerline_app;

-- Lets the owner run SET ROLE ledgerline_app, which the tests use to prove the limits.
GRANT ledgerline_app TO CURRENT_USER WITH SET TRUE;