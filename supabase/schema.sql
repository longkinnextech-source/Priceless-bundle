-- ============================================================================
--  PRICELESS BUNDLE — DATABASE SCHEMA
--  VTU / mobile data reselling platform for Ghana
--  by LongKinnex Tech and Data
-- ----------------------------------------------------------------------------
--  Target: PostgreSQL 15+ (Supabase).
--  Apply order:  schema.sql  ->  functions.sql  ->  seed.sql
--
--  DESIGN RULES (the whole system depends on these):
--   1. Money lives in `numeric(14,2)`. Never float. Never negative.
--   2. Every balance change is performed by a plpgsql function inside ONE
--      transaction: the wallet row lock + balance update + ledger insert
--      either all happen or none do.
--   3. `wallet_ledger` is append-only and immutable (enforced by trigger).
--      Every row snapshots `balance_after`, so any balance can be
--      reconstructed / audited from the ledger alone.
--   4. The app never sends a price. The server resolves tier pricing from the
--      database. The app never writes a balance.
--   5. RLS is enabled with NO policies: anon/authenticated keys can read
--      nothing. Only the server (service role / direct connection) can.
-- ============================================================================

-- pgcrypto is present on Supabase and is used only for helpers such as
-- digest(); the schema itself stays portable so it can also run on a plain
-- PostgreSQL / PGlite instance (where the extension may be unavailable).
do $$ begin
  create extension if not exists "pgcrypto";
exception when others then
  raise notice 'pgcrypto unavailable (%): continuing without it', sqlerrm;
end $$;

-- ---------------------------------------------------------------------------
-- ENUMERATED TYPES
-- ---------------------------------------------------------------------------
do $$ begin
  create type public.user_tier as enum ('customer', 'sub_agent', 'super_agent');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.order_status as enum ('pending', 'processing', 'delivered', 'failed', 'refunded');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.ledger_entry_type as enum (
    'deposit',
    'purchase',
    'commission',
    'commission_reinvest',
    'reinvest_bonus',
    'p2p_send',
    'p2p_receive',
    'withdrawal',
    'withdrawal_fee',
    'refund',
    'admin_adjustment',
    'squad_bonus'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.deposit_intent_status as enum ('pending_match', 'matched', 'credited', 'expired', 'cancelled');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.deposit_status as enum ('matched', 'credited', 'unmatched_review', 'rejected');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.withdrawal_mode as enum ('instant', 'free_friday_batch');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.withdrawal_status as enum ('pending', 'batched', 'processing', 'paid', 'rejected');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.bot_channel as enum ('telegram', 'whatsapp', 'web', 'api');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.commission_state as enum ('accrued', 'partly_consumed', 'reinvested', 'withdrawn');
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------------
-- SETTINGS — operator-tunable knobs (fees, rates, targets, collection numbers)
-- ---------------------------------------------------------------------------
create table if not exists public.settings (
  key         text primary key,
  value       jsonb       not null,
  description text,
  updated_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- USERS
-- ---------------------------------------------------------------------------
create table if not exists public.users (
  id                       uuid primary key default gen_random_uuid(),
  phone                    text not null unique,
  full_name                text,
  email                    text,
  tier                     public.user_tier not null default 'customer',
  squad_id                 uuid,                       -- FK added after squads exists
  pin_hash                 text,                       -- scrypt hash, set by the app
  is_admin                 boolean not null default false,
  -- Bot-in-a-Box credentials
  telegram_bot_token       text,
  telegram_bot_username    text,
  whatsapp_business_endpoint text,
  whatsapp_phone_number_id text,
  whatsapp_verify_token    text,
  bot_enabled              boolean not null default false,
  -- Super-agent unlock: GHS 500 wallet deposit commitment
  super_agent_unlocked_at  timestamptz,
  status                   text not null default 'active' check (status in ('active', 'suspended')),
  last_login_at            timestamptz,
  metadata                 jsonb not null default '{}'::jsonb,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  constraint users_phone_is_gh check (phone ~ '^0[0-9]{9}$'),
  constraint users_name_len    check (full_name is null or char_length(full_name) between 2 and 80)
);
create index if not exists users_squad_idx on public.users (squad_id);
create index if not exists users_tier_idx  on public.users (tier);
create unique index if not exists users_telegram_token_idx on public.users (telegram_bot_token) where telegram_bot_token is not null;
create unique index if not exists users_wa_phone_id_idx    on public.users (whatsapp_phone_number_id) where whatsapp_phone_number_id is not null;

-- ---------------------------------------------------------------------------
-- SQUADS — a Super Agent + the Sub-Agents they recruited
-- ---------------------------------------------------------------------------
create table if not exists public.squads (
  id                   uuid primary key default gen_random_uuid(),
  super_agent_id       uuid not null references public.users (id) on delete cascade,
  name                 text not null,
  invite_code          text not null unique,
  volume_target_ghs    numeric(14,2) not null default 5000 check (volume_target_ghs >= 0),
  current_period_start timestamptz not null default date_trunc('month', now()),
  current_volume_ghs   numeric(14,2) not null default 0 check (current_volume_ghs >= 0),
  tier_retained        boolean not null default true,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create unique index if not exists squads_super_agent_idx on public.squads (super_agent_id);
create index if not exists squads_invite_idx on public.squads (invite_code);

alter table public.users
  drop constraint if exists users_squad_fk;
alter table public.users
  add constraint users_squad_fk foreign key (squad_id) references public.squads (id) on delete set null;

-- ---------------------------------------------------------------------------
-- WALLETS — one per user. balance_ghs can never go negative.
-- ---------------------------------------------------------------------------
create table if not exists public.wallets (
  user_id                uuid primary key references public.users (id) on delete cascade,
  balance_ghs            numeric(14,2) not null default 0 check (balance_ghs >= 0),
  commission_balance_ghs numeric(14,2) not null default 0 check (commission_balance_ghs >= 0),
  total_deposited_ghs    numeric(14,2) not null default 0 check (total_deposited_ghs >= 0),
  total_spent_ghs        numeric(14,2) not null default 0 check (total_spent_ghs >= 0),
  total_withdrawn_ghs    numeric(14,2) not null default 0 check (total_withdrawn_ghs >= 0),
  currency               text not null default 'GHS',
  updated_at             timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- WALLET LEDGER — immutable, append-only, auditable.
--   amount_ghs             = signed effect on the MAIN wallet balance
--   commission_amount_ghs  = signed effect on the COMMISSION pot
--   balance_after          = main wallet balance immediately after this entry
--   commission_balance_after = commission pot immediately after this entry
-- ---------------------------------------------------------------------------
create table if not exists public.wallet_ledger (
  id                      bigserial primary key,
  user_id                 uuid not null references public.users (id) on delete cascade,
  entry_type              public.ledger_entry_type not null,
  amount_ghs              numeric(14,2) not null default 0,
  commission_amount_ghs   numeric(14,2) not null default 0,
  balance_after           numeric(14,2) not null check (balance_after >= 0),
  commission_balance_after numeric(14,2) not null default 0 check (commission_balance_after >= 0),
  description             text not null,
  reference               text,
  order_id                uuid,
  related_user_id         uuid references public.users (id) on delete set null,
  metadata                jsonb not null default '{}'::jsonb,
  created_at              timestamptz not null default now()
);
create index if not exists ledger_user_created_idx on public.wallet_ledger (user_id, created_at desc);
create index if not exists ledger_type_idx         on public.wallet_ledger (entry_type);
create index if not exists ledger_reference_idx    on public.wallet_ledger (reference);
create index if not exists ledger_created_idx      on public.wallet_ledger (created_at desc);

-- Append-only enforcement: no UPDATE, no DELETE, ever.
create or replace function public.fn_block_ledger_mutation() returns trigger
language plpgsql as $$
begin
  raise exception 'wallet_ledger is append-only (% blocked on id %)', tg_op, coalesce(old.id, 0)
    using errcode = 'restrict_violation';
end $$;

drop trigger if exists trg_ledger_immutable on public.wallet_ledger;
create trigger trg_ledger_immutable
  before update or delete on public.wallet_ledger
  for each row execute function public.fn_block_ledger_mutation();

-- ---------------------------------------------------------------------------
-- PLANS — admin-editable price list
-- ---------------------------------------------------------------------------
create table if not exists public.plans (
  id                    uuid primary key default gen_random_uuid(),
  network               text not null check (network in ('MTN', 'Telecel', 'AirtelTigo')),
  size_label            text not null,
  data_mb               integer not null check (data_mb > 0),
  validity_days         integer not null default 90 check (validity_days > 0),
  cost_price_ghs        numeric(14,2) not null check (cost_price_ghs >= 0),
  retail_price_ghs      numeric(14,2) not null check (retail_price_ghs >= 0),
  sub_agent_price_ghs   numeric(14,2) not null check (sub_agent_price_ghs >= 0),
  super_agent_price_ghs numeric(14,2) not null check (super_agent_price_ghs >= 0),
  active                boolean not null default true,
  sort_order            integer not null default 100,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (network, size_label),
  -- Guard rail: nobody may ever sell below cost by accident.
  constraint plans_retail_above_cost check (retail_price_ghs >= cost_price_ghs),
  constraint plans_sub_above_cost    check (sub_agent_price_ghs >= cost_price_ghs),
  constraint plans_super_above_cost  check (super_agent_price_ghs >= cost_price_ghs),
  constraint plans_tier_ordering     check (super_agent_price_ghs <= sub_agent_price_ghs and sub_agent_price_ghs <= retail_price_ghs)
);
create index if not exists plans_network_active_idx on public.plans (network, active, sort_order);

-- ---------------------------------------------------------------------------
-- ORDERS
-- ---------------------------------------------------------------------------
create table if not exists public.orders (
  id                         uuid primary key default gen_random_uuid(),
  buyer_id                   uuid not null references public.users (id) on delete restrict,
  plan_id                    uuid not null references public.plans (id) on delete restrict,
  recipient_phone            text not null,
  price_charged_ghs          numeric(14,2) not null check (price_charged_ghs >= 0),
  cost_price_ghs             numeric(14,2) not null default 0 check (cost_price_ghs >= 0),
  buyer_tier_at_purchase     public.user_tier not null,
  status                     public.order_status not null default 'pending',
  channel                    public.bot_channel not null default 'web',
  supplier                   text not null default 'mock_datamartgh',
  supplier_reference         text,
  supplier_response          jsonb not null default '{}'::jsonb,
  failure_reason             text,
  refund_ledger_id           bigint references public.wallet_ledger (id) on delete set null,
  attributed_super_agent_id  uuid references public.users (id) on delete set null,
  squad_id                   uuid references public.squads (id) on delete set null,
  network                    text not null,
  size_label                 text not null,
  data_mb                    integer not null default 0,
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now(),
  fulfilled_at               timestamptz,
  constraint orders_recipient_is_gh check (recipient_phone ~ '^0[0-9]{9}$')
);
create index if not exists orders_buyer_created_idx on public.orders (buyer_id, created_at desc);
create index if not exists orders_status_idx        on public.orders (status, created_at desc);
create index if not exists orders_squad_idx         on public.orders (squad_id, status, created_at);
create index if not exists orders_supplier_ref_idx  on public.orders (supplier_reference);
create index if not exists orders_created_idx       on public.orders (created_at desc);

alter table public.wallet_ledger
  drop constraint if exists wallet_ledger_order_fk;
alter table public.wallet_ledger
  add constraint wallet_ledger_order_fk foreign key (order_id) references public.orders (id) on delete set null;

-- ---------------------------------------------------------------------------
-- DEPOSITS — automatic payment collection (SMS-forwarder webhook)
-- ---------------------------------------------------------------------------
create table if not exists public.deposit_intents (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references public.users (id) on delete cascade,
  reference_code      text not null unique,
  expected_amount_ghs numeric(14,2) not null check (expected_amount_ghs > 0),
  status              public.deposit_intent_status not null default 'pending_match',
  collection_number   text,
  channel             text not null default 'momo',
  expires_at          timestamptz not null,
  matched_deposit_id  uuid,
  note                text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index if not exists deposit_intents_user_idx   on public.deposit_intents (user_id, created_at desc);
create index if not exists deposit_intents_status_idx on public.deposit_intents (status, created_at desc);
create index if not exists deposit_intents_amount_idx on public.deposit_intents (expected_amount_ghs, status, created_at desc);

create table if not exists public.deposits (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid references public.users (id) on delete set null,
  deposit_intent_id uuid references public.deposit_intents (id) on delete set null,
  amount_ghs        numeric(14,2) not null check (amount_ghs >= 0),
  sender_phone      text,
  provider          text,
  reference_code    text,
  raw_message       text not null,
  sms_hash          text not null unique,          -- idempotency: one credit per SMS
  status            public.deposit_status not null,
  match_strategy    text,                          -- reference | sender_phone | amount_window | unmatched
  match_confidence  numeric(4,3),
  hold_reason       text,
  credited_ledger_id bigint references public.wallet_ledger (id) on delete set null,
  resolved_by       text,
  resolved_at       timestamptz,
  resolution_note   text,
  metadata          jsonb not null default '{}'::jsonb,
  created_at        timestamptz not null default now()
);
create index if not exists deposits_user_idx     on public.deposits (user_id, created_at desc);
create index if not exists deposits_status_idx   on public.deposits (status, created_at desc);
create index if not exists deposits_created_idx  on public.deposits (created_at desc);

alter table public.deposit_intents
  drop constraint if exists deposit_intents_matched_fk;
alter table public.deposit_intents
  add constraint deposit_intents_matched_fk foreign key (matched_deposit_id) references public.deposits (id) on delete set null;

-- Raw webhook payloads. Written BEFORE parsing, always, no matter what.
create table if not exists public.webhook_events (
  id                bigserial primary key,
  source            text not null,
  raw_body          text,
  parsed_payload    jsonb,
  headers           jsonb not null default '{}'::jsonb,
  remote_ip         text,
  signature_ok      boolean not null default false,
  outcome           text,                 -- set after processing (credited / unmatched_review / ...)
  error             text,
  processing_ms     integer,
  created_at        timestamptz not null default now()
);
create index if not exists webhook_events_created_idx on public.webhook_events (created_at desc);
create index if not exists webhook_events_source_idx  on public.webhook_events (source, created_at desc);

-- ---------------------------------------------------------------------------
-- WITHDRAWALS
-- ---------------------------------------------------------------------------
create table if not exists public.withdrawals (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references public.users (id) on delete cascade,
  amount_ghs        numeric(14,2) not null check (amount_ghs > 0),
  fee_ghs           numeric(14,2) not null default 0 check (fee_ghs >= 0),
  net_amount_ghs    numeric(14,2) not null check (net_amount_ghs >= 0),
  mode              public.withdrawal_mode not null,
  status            public.withdrawal_status not null default 'pending',
  tier_at_request   public.user_tier not null,
  payout_method     text not null default 'momo',
  payout_details    jsonb not null default '{}'::jsonb,
  payout_reference  text,
  scheduled_for     timestamptz,
  note              text,
  processed_at      timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists withdrawals_user_idx   on public.withdrawals (user_id, created_at desc);
create index if not exists withdrawals_status_idx on public.withdrawals (status, created_at desc);

-- ---------------------------------------------------------------------------
-- COMMISSIONS — agent earnings pot (reinvestable for a 2–5% bonus)
-- ---------------------------------------------------------------------------
create table if not exists public.commissions (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references public.users (id) on delete cascade,
  source_order_id  uuid references public.orders (id) on delete set null,
  amount_ghs       numeric(14,2) not null check (amount_ghs > 0),
  consumed_ghs     numeric(14,2) not null default 0 check (consumed_ghs >= 0),
  rate             numeric(6,5) not null default 0,
  state            public.commission_state not null default 'accrued',
  description      text not null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint commissions_not_over_consumed check (consumed_ghs <= amount_ghs)
);
create index if not exists commissions_user_idx on public.commissions (user_id, created_at desc);
create index if not exists commissions_state_idx on public.commissions (user_id, state);

-- ---------------------------------------------------------------------------
-- BOT ORDERS — Bot-in-a-Box attribution
-- ---------------------------------------------------------------------------
create table if not exists public.bot_orders (
  id                 uuid primary key default gen_random_uuid(),
  order_id           uuid not null references public.orders (id) on delete cascade,
  super_agent_id     uuid not null references public.users (id) on delete cascade,
  channel            public.bot_channel not null,
  end_customer_phone text not null,
  external_user_ref  text,
  raw_command        text,
  network            text,
  size_label         text,
  price_charged_ghs  numeric(14,2) not null default 0,
  created_at         timestamptz not null default now()
);
create index if not exists bot_orders_agent_idx on public.bot_orders (super_agent_id, created_at desc);
create index if not exists bot_orders_order_idx on public.bot_orders (order_id);

-- ---------------------------------------------------------------------------
-- NOTIFICATIONS — in-app bell
-- ---------------------------------------------------------------------------
create table if not exists public.notifications (
  id         bigserial primary key,
  user_id    uuid not null references public.users (id) on delete cascade,
  title      text not null,
  body       text not null,
  kind       text not null default 'info' check (kind in ('info', 'success', 'warning', 'error')),
  read_at    timestamptz,
  metadata   jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists notifications_user_idx on public.notifications (user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- ADMIN AUDIT TRAIL
-- ---------------------------------------------------------------------------
create table if not exists public.admin_actions (
  id          bigserial primary key,
  actor       text not null,
  action      text not null,
  target_type text,
  target_id   text,
  payload     jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);
create index if not exists admin_actions_created_idx on public.admin_actions (created_at desc);

-- ---------------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------------
create or replace function public.fn_touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

do $$
declare t text;
begin
  foreach t in array array['users','squads','wallets','plans','orders','deposit_intents','withdrawals','commissions','settings']
  loop
    execute format('drop trigger if exists trg_touch_updated_at on public.%I', t);
    execute format('create trigger trg_touch_updated_at before update on public.%I for each row execute function public.fn_touch_updated_at()', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- SUPABASE ROW LEVEL SECURITY
--   RLS is ENABLED with ZERO POLICIES on every table, so the anon and
--   authenticated keys can read and write nothing at all. All access flows
--   through the server (service role / direct connection) calling the
--   SECURITY DEFINER functions in functions.sql.
--
--   Note: RLS is deliberately NOT forced. FORCE ROW LEVEL SECURITY would also
--   apply to the table owner, which would lock the application out when the
--   schema is applied by a non-superuser role. The server connects as the
--   owner (or with a BYPASSRLS role), so it keeps working either way.
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'users','squads','wallets','wallet_ledger','plans','orders','deposit_intents',
    'deposits','webhook_events','withdrawals','commissions','bot_orders',
    'notifications','admin_actions','settings'
  ]
  loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;

-- If the Supabase roles exist, make the intent explicit: no anon access at all,
-- service_role gets everything (it bypasses RLS by design anyway).
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated']
  loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on all tables in schema public from %I', r);
      execute format('revoke all on all sequences in schema public from %I', r);
      execute format('revoke all on schema public from %I', r);
    end if;
  end loop;

  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant usage on schema public to service_role';
    execute 'grant all on all tables in schema public to service_role';
    execute 'grant all on all sequences in schema public to service_role';
  end if;
end $$;
