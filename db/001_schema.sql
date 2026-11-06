-- LedgerLine schema. All money is integer paise (BIGINT).

-- ---------- Users and accounts ----------
CREATE TABLE users (
  id            BIGSERIAL PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('admin','holder','auditor')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE accounts (
  id            BIGSERIAL PRIMARY KEY,
  owner_id      BIGINT REFERENCES users(id),
  name          TEXT NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'customer' CHECK (kind IN ('customer','external')),
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','frozen','closed')),
  balance_paise BIGINT NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Last line of defence: customer accounts can never go below zero.
  -- The EXTERNAL account goes negative by design (it mirrors net deposits).
  CONSTRAINT no_negative_customer_balance
    CHECK (kind = 'external' OR balance_paise >= 0)
);
CREATE UNIQUE INDEX only_one_external_account ON accounts (kind) WHERE kind = 'external';

INSERT INTO accounts (name, kind) VALUES ('EXTERNAL', 'external');

-- Per-account authorisation: who may do what on which account.
CREATE TABLE account_members (
  account_id   BIGINT NOT NULL REFERENCES accounts(id),
  user_id      BIGINT NOT NULL REFERENCES users(id),
  can_deposit  BOOLEAN NOT NULL DEFAULT TRUE,
  can_withdraw BOOLEAN NOT NULL DEFAULT TRUE,
  can_transfer BOOLEAN NOT NULL DEFAULT TRUE,
  PRIMARY KEY (account_id, user_id)
);

-- ---------- Idempotency ----------
CREATE TABLE idempotency_keys (
  id              BIGSERIAL PRIMARY KEY,
  user_id         BIGINT NOT NULL REFERENCES users(id),
  key             TEXT NOT NULL,
  request_hash    TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress','completed')),
  response_status INT,
  response_body   JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at    TIMESTAMPTZ,
  CONSTRAINT idempotency_unique_per_user UNIQUE (user_id, key)
);

-- ---------- Ledger (append-only) ----------
CREATE TABLE transactions (
  id                 BIGSERIAL PRIMARY KEY,
  type               TEXT NOT NULL CHECK (type IN ('deposit','withdrawal','transfer','adjustment','reversal')),
  initiated_by       BIGINT NOT NULL REFERENCES users(id),
  idempotency_key_id BIGINT REFERENCES idempotency_keys(id),
  reverses_txn_id    BIGINT REFERENCES transactions(id),
  memo               TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE postings (
  id                 BIGINT PRIMARY KEY,           -- assigned by trigger, in chain order
  txn_id             BIGINT NOT NULL REFERENCES transactions(id),
  account_id         BIGINT NOT NULL REFERENCES accounts(id),
  amount_paise       BIGINT NOT NULL CHECK (amount_paise <> 0),  -- signed: + credit, - debit
  balance_after_paise BIGINT NOT NULL,
  prev_hash          TEXT NOT NULL,
  hash               TEXT NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX postings_account_idx ON postings (account_id, id);
CREATE INDEX postings_txn_idx ON postings (txn_id);
CREATE SEQUENCE postings_id_seq;

CREATE TABLE refused_attempts (
  id                     BIGSERIAL PRIMARY KEY,
  account_id             BIGINT REFERENCES accounts(id),
  counterparty_account_id BIGINT REFERENCES accounts(id),
  initiated_by           BIGINT REFERENCES users(id),
  type                   TEXT NOT NULL,
  amount_paise           BIGINT,
  reason                 TEXT NOT NULL,
  idempotency_key        TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX refused_account_idx ON refused_attempts (account_id, id);

CREATE TABLE audit_log (
  id         BIGSERIAL PRIMARY KEY,
  actor_id   BIGINT REFERENCES users(id),
  action     TEXT NOT NULL,
  detail     JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- Append-only enforcement ----------
CREATE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% on % is not allowed: table is append-only', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'integrity_constraint_violation';
END $$;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['transactions','postings','refused_attempts','audit_log'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I
                    FOR EACH ROW EXECUTE FUNCTION forbid_mutation()', t || '_no_mutate', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I
                    FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation()', t || '_no_truncate', t);
  END LOOP;
END $$;

-- ---------- Every transaction must net to zero ----------
CREATE FUNCTION check_txn_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s BIGINT; n INT;
BEGIN
  SELECT COALESCE(SUM(amount_paise),0), COUNT(*) INTO s, n
  FROM postings WHERE txn_id = NEW.txn_id;
  IF s <> 0 OR n < 2 THEN
    RAISE EXCEPTION 'transaction % is unbalanced (sum=%, postings=%)', NEW.txn_id, s, n
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NULL;
END $$;

-- Deferred: checked at COMMIT, after all postings of the transaction exist.
CREATE CONSTRAINT TRIGGER postings_must_balance
  AFTER INSERT ON postings
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_txn_balanced();

-- ---------- Hash chain (computed by the database, not the app) ----------
CREATE FUNCTION posting_hash(prev TEXT, p_id BIGINT, p_txn BIGINT, p_acct BIGINT,
                             p_amt BIGINT, p_bal BIGINT, p_ts TIMESTAMPTZ)
RETURNS TEXT LANGUAGE sql STABLE AS $$
  SELECT encode(sha256(convert_to(
    prev || '|' || p_id || '|' || p_txn || '|' || p_acct || '|' || p_amt || '|' || p_bal || '|' ||
    to_char(p_ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'), 'UTF8')), 'hex')
$$;

CREATE FUNCTION postings_chain() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE last_hash TEXT;
BEGIN
  -- One writer at a time extends the chain. Lock BEFORE taking the id so
  -- ids are strictly increasing in chain order.
  PERFORM pg_advisory_xact_lock(727001);
  NEW.id := nextval('postings_id_seq');
  SELECT hash INTO last_hash FROM postings ORDER BY id DESC LIMIT 1;
  NEW.prev_hash := COALESCE(last_hash, 'GENESIS');
  NEW.hash := posting_hash(NEW.prev_hash, NEW.id, NEW.txn_id, NEW.account_id,
                           NEW.amount_paise, NEW.balance_after_paise, NEW.created_at);
  RETURN NEW;
END $$;

CREATE TRIGGER postings_chain_trg BEFORE INSERT ON postings
  FOR EACH ROW EXECUTE FUNCTION postings_chain();

-- ---------- Verification helpers ----------
-- Returns one row per broken posting. Empty result = chain intact.
CREATE FUNCTION verify_ledger() RETURNS TABLE (bad_posting_id BIGINT, reason TEXT)
LANGUAGE sql STABLE AS $$
  WITH o AS (
    SELECT p.*, lag(hash) OVER (ORDER BY id) AS expected_prev FROM postings p
  )
  SELECT id, 'prev_hash does not match previous row' FROM o
   WHERE prev_hash IS DISTINCT FROM COALESCE(expected_prev, 'GENESIS')
  UNION ALL
  SELECT id, 'hash does not match row contents' FROM o
   WHERE hash <> posting_hash(prev_hash, id, txn_id, account_id,
                              amount_paise, balance_after_paise, created_at)
$$;

-- Returns accounts whose stored balance differs from the sum of their postings.
CREATE FUNCTION reconcile_accounts() RETURNS TABLE (account_id BIGINT, stored BIGINT, computed BIGINT)
LANGUAGE sql STABLE AS $$
  SELECT a.id, a.balance_paise, COALESCE(SUM(p.amount_paise),0)::BIGINT
  FROM accounts a LEFT JOIN postings p ON p.account_id = a.id
  GROUP BY a.id, a.balance_paise
  HAVING a.balance_paise <> COALESCE(SUM(p.amount_paise),0)
$$;