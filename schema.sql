DROP TABLE IF EXISTS tron_transfers;
DROP TABLE IF EXISTS payments;
DROP TABLE IF EXISTS referrals;
DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS settings;


-- =========================
-- USERS
-- =========================
CREATE TABLE users (
  tg_id       BIGINT PRIMARY KEY,
  username    TEXT,
  first_name  TEXT,
  ref_code    TEXT UNIQUE,
  referred_by BIGINT,
  is_deleted  BOOLEAN DEFAULT FALSE,
  pay_nonce   INT DEFAULT 0,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_users_ref_code ON users(ref_code);
CREATE INDEX idx_users_referred_by ON users(referred_by);

-- =========================
-- REFERRALS
-- =========================
CREATE TABLE referrals (
  id              BIGSERIAL PRIMARY KEY,
  referrer_tg_id  BIGINT NOT NULL,
  referred_tg_id  BIGINT NOT NULL UNIQUE,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_referrals_referrer ON referrals(referrer_tg_id);

-- =========================
-- PAYMENTS
-- =========================
CREATE TABLE payments (
  id              BIGSERIAL PRIMARY KEY,
  tg_id           BIGINT NOT NULL,
  expected_amount NUMERIC(12,6) NOT NULL,
  slot            INT,
  status          TEXT NOT NULL DEFAULT 'pending', -- pending|confirmed|expired
  tx_hash         TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  expires_at      TIMESTAMPTZ NOT NULL
);

CREATE INDEX idx_payments_tg_created ON payments(tg_id, created_at DESC);
CREATE INDEX idx_payments_status_expires ON payments(status, expires_at);
CREATE INDEX idx_payments_amount ON payments(expected_amount);

-- Anti spam: 1 pending actif par user
CREATE UNIQUE INDEX ux_one_pending_per_user
ON payments (tg_id)
WHERE status = 'pending';

-- Anti collision: un même montant ne peut être pending qu'une seule fois
CREATE UNIQUE INDEX ux_amount_pending_unique
ON payments (expected_amount)
WHERE status = 'pending';

-- Anti double tx
CREATE UNIQUE INDEX ux_payments_tx_hash
ON payments (tx_hash)
WHERE tx_hash IS NOT NULL;

-- =========================
-- SETTINGS
-- =========================
CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- =========================
-- TRON TRANSFERS (logs blockchain)
-- =========================
CREATE TABLE tron_transfers (
  tx_hash        TEXT PRIMARY KEY,
  token_contract TEXT NOT NULL,
  from_address   TEXT,
  to_address     TEXT NOT NULL,
  amount_sun     BIGINT NOT NULL,     -- USDT TRC20 = 6 decimals (sun)
  block_ts       BIGINT NOT NULL,     -- timestamp en ms
  raw            JSONB,               -- payload brut (debug)
  seen_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_tron_transfers_to_ts ON tron_transfers(to_address, block_ts DESC);
CREATE INDEX idx_tron_transfers_amount ON tron_transfers(amount_sun);
