CREATE TABLE idempotency_replays (
  id                 BIGSERIAL PRIMARY KEY,
  idempotency_key_id BIGINT NOT NULL REFERENCES idempotency_keys(id),
  user_id            BIGINT NOT NULL REFERENCES users(id),
  replayed_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idempotency_replays_key_idx ON idempotency_replays (idempotency_key_id);

CREATE TRIGGER idempotency_replays_no_mutate BEFORE UPDATE OR DELETE ON idempotency_replays
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER idempotency_replays_no_truncate BEFORE TRUNCATE ON idempotency_replays
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();