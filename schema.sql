create table if not exists users (
  id bigserial primary key,
  tg_id bigint unique not null,
  username text,
  first_name text,
  created_at timestamptz not null default now(),
  ref_code text unique not null,
  referred_by bigint null,
  is_deleted boolean not null default false
);

create table if not exists referrals (
  id bigserial primary key,
  referrer_tg_id bigint not null,
  referred_tg_id bigint not null unique,
  created_at timestamptz not null default now()
);

create table if not exists payments (
  id bigserial primary key,
  tg_id bigint not null,
  expected_amount numeric(18,6) not null,
  status text not null check (status in ('pending','confirmed','expired')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  tx_hash text null
);

create table if not exists settings (
  key text primary key,
  value text not null
);

create index if not exists idx_payments_status on payments(status);
create index if not exists idx_users_ref_code on users(ref_code);