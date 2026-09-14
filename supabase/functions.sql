-- ============================================================================
--  PRICELESS BUNDLE — DATABASE FUNCTIONS
--  by LongKinnex Tech and Data
-- ----------------------------------------------------------------------------
--  Every function here is SECURITY DEFINER and callable only by the server
--  (service role / direct connection). The application layer NEVER writes a
--  balance and NEVER computes a price — it calls these functions and renders
--  what comes back.
--
--  Contract for every public RPC:
--     * returns jsonb
--     * named arguments (p_*) so both the Supabase JS client and a plain
--       Postgres driver can call the exact same signature
--     * raises only on programmer/plumbing errors; business failures are
--       returned as {"ok": false, "error": "CODE"} so the API can map them
--       to sensible HTTP status codes
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 0. INTERNAL HELPERS
-- ---------------------------------------------------------------------------

-- Ghana phone normalisation: +233XXXXXXXXX / 233XXXXXXXXX / 0XXXXXXXXX -> 0XXXXXXXXX
create or replace function public.fn_normalize_phone(p_phone text) returns text
language plpgsql immutable as $$
declare v text;
begin
  if p_phone is null then return null; end if;
  v := regexp_replace(p_phone, '[^0-9]', '', 'g');
  if v like '233%' and length(v) >= 12 then
    v := '0' || substr(v, 4);
  end if;
  if v ~ '^[0-9]{9}$' then
    v := '0' || v;
  end if;
  return v;
end $$;

-- Ghana mobile prefixes currently in service (MTN, Telecel, AirtelTigo)
create or replace function public.fn_is_valid_gh_phone(p_phone text) returns boolean
language sql immutable as $$
  select p_phone ~ '^0(20|23|24|25|26|27|28|29|50|53|54|55|56|57|58|59)[0-9]{7}$';
$$;

-- Premier network guesses from a Ghanaian prefix — used for smart defaults only.
create or replace function public.fn_network_for_phone(p_phone text) returns text
language sql immutable as $$
  select case
    when p_phone ~ '^0(24|25|53|54|55|59)' then 'MTN'
    when p_phone ~ '^0(20|50)'            then 'Telecel'
    when p_phone ~ '^0(26|27|56|57)'      then 'AirtelTigo'
    else null
  end;
$$;

-- Calendar-month period boundaries in Africa/Accra (the business timezone).
create or replace function public.fn_period_start(p_at timestamptz default now()) returns timestamptz
language sql stable as $$
  select date_trunc('month', p_at at time zone 'Africa/Accra') at time zone 'Africa/Accra';
$$;

create or replace function public.fn_period_end(p_at timestamptz default now()) returns timestamptz
language sql stable as $$
  select (date_trunc('month', p_at at time zone 'Africa/Accra') + interval '1 month') at time zone 'Africa/Accra';
$$;

-- Next Friday 18:00 Accra — the Free Friday payout run.
create or replace function public.fn_next_free_friday(p_at timestamptz default now()) returns timestamptz
language sql stable as $$
  select date_trunc('day', (p_at at time zone 'Africa/Accra') + interval '1 day' * ((5 - extract(dow from p_at at time zone 'Africa/Accra')::int + 7) % 7)) at time zone 'Africa/Accra' + interval '18 hours';
$$;

create or replace function public.fn_setting(p_key text, p_default jsonb default 'null'::jsonb) returns jsonb
language sql stable as $$
  select coalesce((select value from public.settings where key = p_key), p_default);
$$;

create or replace function public.fn_setting_num(p_key text, p_default numeric) returns numeric
language sql stable as $$
  select coalesce(nullif(regexp_replace((select value #>> '{}' from public.settings where key = p_key), '[^0-9.\-]', '', 'g'), '')::numeric, p_default);
$$;

create or replace function public.fn_setting_text(p_key text, p_default text) returns text
language sql stable as $$
  select coalesce((select value #>> '{}' from public.settings where key = p_key), p_default);
$$;

-- Human-friendly codes with no look-alike characters (no I/O/0/1).
create or replace function public.fn_random_code(p_prefix text, p_len integer default 4) returns text
language plpgsql volatile as $$
declare
  v_alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  v_out text := '';
  i integer;
begin
  for i in 1..p_len loop
    v_out := v_out || substr(v_alphabet, 1 + floor(random() * length(v_alphabet))::int, 1);
  end loop;
  return p_prefix || v_out;
end $$;

-- ---------------------------------------------------------------------------
-- 1. MONEY PRIMITIVES — the ONLY code allowed to touch a balance or the ledger
-- ---------------------------------------------------------------------------

-- Apply a signed delta to a wallet. Callers MUST hold the row lock
-- (select ... from wallets where user_id = X for update) before calling.
create or replace function public.fn_wallet_apply(
  p_user_id uuid,
  p_delta numeric,
  p_commission_delta numeric default 0,
  p_deposited_delta numeric default 0,
  p_spent_delta numeric default 0,
  p_withdrawn_delta numeric default 0
) returns public.wallets
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_wallet public.wallets;
begin
  update public.wallets
     set balance_ghs            = balance_ghs + coalesce(p_delta, 0),
         commission_balance_ghs = commission_balance_ghs + coalesce(p_commission_delta, 0),
         total_deposited_ghs    = total_deposited_ghs + coalesce(p_deposited_delta, 0),
         total_spent_ghs        = total_spent_ghs + coalesce(p_spent_delta, 0),
         total_withdrawn_ghs    = total_withdrawn_ghs + coalesce(p_withdrawn_delta, 0),
         updated_at             = now()
   where user_id = p_user_id
  returning * into v_wallet;

  if v_wallet.user_id is null then
    raise exception 'wallet not found for user %', p_user_id using errcode = 'no_data_found';
  end if;

  return v_wallet;
end $$;

-- Append to the immutable ledger. Nothing else may INSERT into wallet_ledger.
create or replace function public.fn_ledger_append(
  p_user_id uuid,
  p_type public.ledger_entry_type,
  p_amount numeric,
  p_description text,
  p_balance_after numeric,
  p_commission_amount numeric default 0,
  p_commission_after numeric default 0,
  p_reference text default null,
  p_order_id uuid default null,
  p_related_user_id uuid default null,
  p_metadata jsonb default '{}'::jsonb
) returns bigint
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id bigint;
begin
  insert into public.wallet_ledger (
    user_id, entry_type, amount_ghs, commission_amount_ghs,
    balance_after, commission_balance_after, description,
    reference, order_id, related_user_id, metadata
  ) values (
    p_user_id, p_type, coalesce(p_amount, 0), coalesce(p_commission_amount, 0),
    p_balance_after, coalesce(p_commission_after, 0), p_description,
    p_reference, p_order_id, p_related_user_id, coalesce(p_metadata, '{}'::jsonb)
  ) returning id into v_id;
  return v_id;
end $$;

create or replace function public.fn_notify(
  p_user_id uuid, p_title text, p_body text, p_kind text default 'info', p_metadata jsonb default '{}'::jsonb
) returns bigint
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id bigint;
begin
  insert into public.notifications (user_id, title, body, kind, metadata)
  values (p_user_id, p_title, p_body, coalesce(p_kind, 'info'), coalesce(p_metadata, '{}'::jsonb))
  returning id into v_id;
  return v_id;
end $$;

-- ---------------------------------------------------------------------------
-- 2. PLATFORM HEALTH + TIER / PRICING RESOLUTION
-- ---------------------------------------------------------------------------

create or replace function public.fn_health() returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'ok', true,
    'brand', 'Priceless Bundle',
    'by', 'LongKinnex Tech and Data',
    'server_time', now(),
    'db_version', current_setting('server_version'),
    'plans', (select count(*) from public.plans where active),
    'users', (select count(*) from public.users),
    'migrations', jsonb_build_object(
      'schema', to_regclass('public.wallets') is not null,
      'functions', to_regprocedure('public.fn_purchase_data(uuid,uuid,text,public.bot_channel,text,text,text)') is not null
    )
  );
$$;

-- Tier-aware price for one plan. The single source of truth for pricing.
create or replace function public.fn_price_for_user(p_user_id uuid, p_plan public.plans)
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_user public.users;
  v_squad public.squads;
  v_retained boolean := true;
  v_price numeric(14,2);
  v_reason text;
  v_effective text;
begin
  select * into v_user from public.users where id = p_user_id;
  if v_user.id is null then
    return jsonb_build_object('ok', false, 'error', 'USER_NOT_FOUND');
  end if;

  if v_user.squad_id is not null then
    select * into v_squad from public.squads where id = v_user.squad_id;
    v_retained := coalesce(v_squad.tier_retained, true);
  end if;

  if v_user.tier = 'super_agent' and v_user.super_agent_unlocked_at is not null then
    v_price := p_plan.super_agent_price_ghs;
    v_effective := 'super_agent';
    v_reason := 'VIP wholesale pricing (Super Agent)';
  elsif v_user.tier = 'sub_agent' and (v_user.squad_id is null or v_retained) then
    v_price := p_plan.sub_agent_price_ghs;
    v_effective := 'sub_agent';
    v_reason := case when v_user.squad_id is null
                     then 'Sub-Agent pricing'
                     else 'Sub-Agent pricing (Squad target retained)' end;
  elsif v_user.tier = 'sub_agent' and not v_retained then
    v_price := p_plan.retail_price_ghs;
    v_effective := 'customer';
    v_reason := 'Squad missed its monthly volume target — retail pricing until the target is hit';
  else
    v_price := p_plan.retail_price_ghs;
    v_effective := 'customer';
    v_reason := 'Retail pricing';
  end if;

  return jsonb_build_object(
    'ok', true,
    'price_ghs', v_price,
    'list_price_ghs', p_plan.retail_price_ghs,
    'tier', v_user.tier,
    'effective_tier', v_effective,
    'squad_tier_retained', v_retained,
    'savings_ghs', greatest(p_plan.retail_price_ghs - v_price, 0),
    'reason', v_reason
  );
end $$;

create or replace function public.fn_resolve_price(p_user_id uuid, p_plan_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_plan public.plans; v_res jsonb;
begin
  select * into v_plan from public.plans where id = p_plan_id and active;
  if v_plan.id is null then
    return jsonb_build_object('ok', false, 'error', 'PLAN_UNAVAILABLE');
  end if;
  v_res := public.fn_price_for_user(p_user_id, v_plan);
  if not (v_res->>'ok')::boolean then return v_res; end if;
  return v_res || jsonb_build_object('plan_id', v_plan.id, 'network', v_plan.network, 'size_label', v_plan.size_label);
end $$;

-- Catalogue with per-user prices already resolved — the buy page renders this.
-- Cost prices never appear in the output, for any tier.
create or replace function public.fn_list_plans(p_user_id uuid default null) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_plan public.plans;
  v_items jsonb := '[]'::jsonb;
  v_pricing jsonb;
  v_retail jsonb;
begin
  for v_plan in
    select * from public.plans where active order by sort_order, network, data_mb
  loop
    v_retail := jsonb_build_object(
      'price_ghs', v_plan.retail_price_ghs,
      'list_price_ghs', v_plan.retail_price_ghs,
      'tier', 'customer',
      'effective_tier', 'customer',
      'squad_tier_retained', true,
      'savings_ghs', 0,
      'reason', 'Retail pricing'
    );

    if p_user_id is null then
      v_pricing := v_retail;
    else
      v_pricing := public.fn_price_for_user(p_user_id, v_plan);
      if not coalesce((v_pricing->>'ok')::boolean, false) then
        v_pricing := v_retail;
      end if;
    end if;

    v_items := v_items || jsonb_build_array(
      jsonb_build_object(
        'id', v_plan.id,
        'network', v_plan.network,
        'size_label', v_plan.size_label,
        'data_mb', v_plan.data_mb,
        'validity_days', v_plan.validity_days,
        'sort_order', v_plan.sort_order,
        'active', v_plan.active
      ) || (v_pricing - 'ok')
    );
  end loop;

  return jsonb_build_object('ok', true, 'plans', v_items);
end $$;

-- ---------------------------------------------------------------------------
-- 3. USERS / AUTH SUPPORT
-- ---------------------------------------------------------------------------

-- Registration. If the phone already exists WITHOUT a pin (e.g. a Super Agent
-- pre-added them to a Squad) this "activates" that record instead of failing.
create or replace function public.fn_register_user(
  p_phone text,
  p_full_name text,
  p_pin_hash text,
  p_email text default null,
  p_squad_invite_code text default null,
  p_accept_tier public.user_tier default 'customer'
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_phone text := public.fn_normalize_phone(p_phone);
  v_user public.users;
  v_squad public.squads;
  v_created boolean := false;
  v_activated boolean := false;
  v_tier public.user_tier := coalesce(p_accept_tier, 'customer');
begin
  if not public.fn_is_valid_gh_phone(v_phone) then
    return jsonb_build_object('ok', false, 'error', 'INVALID_PHONE', 'message', 'Enter a valid Ghana mobile number, e.g. 0244123456.');
  end if;
  if p_full_name is null or char_length(trim(p_full_name)) < 2 then
    return jsonb_build_object('ok', false, 'error', 'INVALID_NAME', 'message', 'Enter your full name.');
  end if;
  if p_pin_hash is null or char_length(p_pin_hash) < 16 then
    return jsonb_build_object('ok', false, 'error', 'INVALID_PIN', 'message', 'PIN must be 4–6 digits.');
  end if;

  select * into v_user from public.users where phone = v_phone for update;

  if v_user.id is not null then
    if v_user.pin_hash is not null then
      return jsonb_build_object('ok', false, 'error', 'PHONE_TAKEN', 'message', 'That number is already registered. Please sign in.');
    end if;
    -- Activation of a pre-created (recruited) account: keep tier + squad.
    update public.users
       set pin_hash = p_pin_hash,
           full_name = coalesce(nullif(trim(p_full_name), ''), full_name),
           email = coalesce(p_email, email),
           updated_at = now()
     where id = v_user.id
     returning * into v_user;
    v_activated := true;
  else
    insert into public.users (phone, full_name, email, pin_hash, tier)
    values (v_phone, trim(p_full_name), p_email, p_pin_hash, v_tier)
    returning * into v_user;
    v_created := true;
  end if;

  insert into public.wallets (user_id) values (v_user.id)
  on conflict (user_id) do nothing;

  -- Optional: arrive through a Super Agent's recruit link.
  if p_squad_invite_code is not null then
    v_squad := null;
    select * into v_squad from public.squads where upper(invite_code) = upper(trim(p_squad_invite_code));
    if v_squad.id is not null and v_squad.super_agent_id <> v_user.id then
      update public.users
         set squad_id = v_squad.id,
             tier = case when tier = 'customer' then 'sub_agent'::public.user_tier else tier end,
             updated_at = now()
       where id = v_user.id
       returning * into v_user;
      perform public.fn_squad_recompute(v_squad.id);
      perform public.fn_notify(
        v_squad.super_agent_id,
        'New Sub-Agent in your Squad',
        coalesce(v_user.full_name, v_user.phone) || ' joined your squad via your recruit link.',
        'success',
        jsonb_build_object('user_id', v_user.id)
      );
    end if;
  end if;

  return jsonb_build_object(
    'ok', true,
    'created', v_created,
    'activated', v_activated,
    'user', public.fn_user_public(v_user.id)
  );
end $$;

create or replace function public.fn_user_public(p_user_id uuid) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'id', u.id,
    'phone', u.phone,
    'full_name', u.full_name,
    'email', u.email,
    'tier', u.tier,
    'status', u.status,
    'is_admin', u.is_admin,
    'squad_id', u.squad_id,
    'super_agent_unlocked_at', u.super_agent_unlocked_at,
    'bot_enabled', u.bot_enabled,
    'telegram_bot_username', u.telegram_bot_username,
    'has_telegram_bot', u.telegram_bot_token is not null,
    'has_whatsapp_endpoint', u.whatsapp_business_endpoint is not null,
    'whatsapp_phone_number_id', u.whatsapp_phone_number_id,
    'created_at', u.created_at,
    'wallet', jsonb_build_object(
      'balance_ghs', coalesce(w.balance_ghs, 0),
      'commission_balance_ghs', coalesce(w.commission_balance_ghs, 0),
      'total_deposited_ghs', coalesce(w.total_deposited_ghs, 0),
      'total_spent_ghs', coalesce(w.total_spent_ghs, 0),
      'total_withdrawn_ghs', coalesce(w.total_withdrawn_ghs, 0),
      'currency', coalesce(w.currency, 'GHS')
    )
  )
  from public.users u
  left join public.wallets w on w.user_id = u.id
  where u.id = p_user_id;
$$;

-- Login lookup. Returns the stored scrypt hash so the app can verify it and
-- only ever hands back a safe payload once verification succeeds.
create or replace function public.fn_auth_lookup(p_phone text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_user public.users;
begin
  select * into v_user from public.users where phone = public.fn_normalize_phone(p_phone);
  if v_user.id is null then
    return jsonb_build_object('ok', false, 'error', 'NOT_FOUND');
  end if;
  if v_user.pin_hash is null then
    return jsonb_build_object('ok', false, 'error', 'NOT_ACTIVATED', 'user_id', v_user.id,
                              'message', 'This account was created for you by an agent. Set your PIN to activate it.');
  end if;
  return jsonb_build_object(
    'ok', true,
    'user_id', v_user.id,
    'pin_hash', v_user.pin_hash,
    'status', v_user.status,
    'phone', v_user.phone,
    'full_name', v_user.full_name,
    'tier', v_user.tier
  );
end $$;

create or replace function public.fn_touch_login(p_user_id uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update public.users set last_login_at = now() where id = p_user_id;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.fn_get_me(p_user_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v jsonb;
begin
  v := public.fn_user_public(p_user_id);
  if v is null then return jsonb_build_object('ok', false, 'error', 'USER_NOT_FOUND'); end if;
  return jsonb_build_object('ok', true, 'user', v,
    'unread_notifications', (select count(*) from public.notifications where user_id = p_user_id and read_at is null));
end $$;

-- ---------------------------------------------------------------------------
-- 4. AUTOMATIC PAYMENT COLLECTION
--    Flow: user asks for a top-up -> deposit_intent with a short reference code
--          -> user sends MoMo to the collection number with that reference
--          -> Android SMS forwarder POSTs the raw SMS to /api/webhook/sms-deposit
--          -> fn_process_sms_deposit matches + credits ATOMICALLY.
-- ---------------------------------------------------------------------------

create or replace function public.fn_deposit_intent_expiry() returns interval
language sql stable as $$
  select make_interval(mins => public.fn_setting_num('deposit_intent_ttl_minutes', 60)::int);
$$;

-- Create (or refresh) a top-up request and hand back the reference + number.
create or replace function public.fn_create_deposit_intent(
  p_user_id uuid,
  p_amount numeric,
  p_channel text default 'momo'
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_user public.users;
  v_amount numeric(14,2);
  v_code text;
  v_intent public.deposit_intents;
  v_tries integer := 0;
  v_min numeric := public.fn_setting_num('min_deposit_ghs', 1);
  v_max numeric := public.fn_setting_num('max_deposit_ghs', 20000);
  v_number text;
begin
  select * into v_user from public.users where id = p_user_id;
  if v_user.id is null then
    return jsonb_build_object('ok', false, 'error', 'USER_NOT_FOUND');
  end if;
  if v_user.status <> 'active' then
    return jsonb_build_object('ok', false, 'error', 'ACCOUNT_SUSPENDED', 'message', 'This account is suspended.');
  end if;

  v_amount := round(coalesce(p_amount, 0)::numeric, 2);
  if v_amount <= 0 then
    return jsonb_build_object('ok', false, 'error', 'INVALID_AMOUNT', 'message', 'Enter the amount you want to top up.');
  end if;
  if v_amount < v_min then
    return jsonb_build_object('ok', false, 'error', 'AMOUNT_BELOW_MIN', 'message', format('Minimum top-up is GHS %s.', v_min));
  end if;
  if v_amount > v_max then
    return jsonb_build_object('ok', false, 'error', 'AMOUNT_ABOVE_MAX', 'message', format('Maximum single top-up is GHS %s. Contact support for larger amounts.', v_max));
  end if;

  -- Expire this user's stale pending intents so they never create ambiguity.
  update public.deposit_intents
     set status = 'expired', updated_at = now()
   where user_id = p_user_id and status = 'pending_match' and expires_at < now();

  -- Re-use a live intent for the same amount instead of spamming new codes.
  select * into v_intent
    from public.deposit_intents
   where user_id = p_user_id and status = 'pending_match'
     and expected_amount_ghs = v_amount and expires_at > now()
   order by created_at desc limit 1;

  if v_intent.id is not null then
    return jsonb_build_object('ok', true, 'reused', true, 'intent', to_jsonb(v_intent));
  end if;

  loop
    v_code := public.fn_random_code('PB-', 4);
    exit when not exists (select 1 from public.deposit_intents where reference_code = v_code);
    v_tries := v_tries + 1;
    if v_tries > 25 then
      return jsonb_build_object('ok', false, 'error', 'CODE_GENERATION_FAILED');
    end if;
  end loop;

  v_number := case when lower(coalesce(p_channel, 'momo')) in ('telecel', 'telecel_cash', 'vodafone')
                   then public.fn_setting_text('collection_number_telecel', public.fn_setting_text('collection_number_momo', '0240000000'))
                   else public.fn_setting_text('collection_number_momo', '0240000000') end;

  insert into public.deposit_intents (user_id, reference_code, expected_amount_ghs, status, collection_number, channel, expires_at)
  values (p_user_id, v_code, v_amount, 'pending_match', v_number, lower(coalesce(p_channel, 'momo')), now() + public.fn_deposit_intent_expiry())
  returning * into v_intent;

  return jsonb_build_object('ok', true, 'reused', false, 'intent', to_jsonb(v_intent));
end $$;

create or replace function public.fn_get_deposit_intent(p_intent_id uuid, p_user_id uuid) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('ok', true, 'intent', to_jsonb(di), 'deposits', coalesce((
    select jsonb_agg(to_jsonb(d) order by d.created_at desc)
    from public.deposits d where d.deposit_intent_id = di.id
  ), '[]'::jsonb))
  from public.deposit_intents di
  where di.id = p_intent_id and di.user_id = p_user_id;
$$;

create or replace function public.fn_active_deposit_intents(p_user_id uuid) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('ok', true, 'intents', coalesce(jsonb_agg(to_jsonb(di) order by di.created_at desc), '[]'::jsonb))
  from public.deposit_intents di
  where di.user_id = p_user_id and di.status = 'pending_match' and di.expires_at > now();
$$;

-- Log the raw webhook payload BEFORE anything else happens. Always succeeds.
create or replace function public.fn_log_webhook_event(
  p_source text,
  p_raw_body text,
  p_payload jsonb,
  p_headers jsonb default '{}'::jsonb,
  p_remote_ip text default null,
  p_signature_ok boolean default false
) returns bigint
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id bigint;
begin
  insert into public.webhook_events (source, raw_body, parsed_payload, headers, remote_ip, signature_ok)
  values (p_source, left(coalesce(p_raw_body, ''), 8000), coalesce(p_payload, '{}'::jsonb), coalesce(p_headers, '{}'::jsonb), p_remote_ip, coalesce(p_signature_ok, false))
  returning id into v_id;
  return v_id;
end $$;

create or replace function public.fn_finish_webhook_event(
  p_id bigint, p_outcome text, p_error text default null, p_processing_ms integer default null
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update public.webhook_events
     set outcome = p_outcome, error = p_error, processing_ms = p_processing_ms
   where id = p_id;
  return jsonb_build_object('ok', true);
end $$;

-- THE MONEY ENTRY POINT for deposits.
--   p_reference_code : parsed from SMS if present (best signal)
--   p_sender_phone   : the MoMo number that sent the money
--   p_amount         : parsed GHS amount (null when unparseable)
--   p_sms_hash       : stable hash of the raw SMS -> idempotency
-- Returns {status: credited | unmatched_review | duplicate | rejected, ...}
-- Adding an argument changes the signature, so retire the old one first
-- (otherwise a call that omits it would be ambiguous between the two).
drop function if exists public.fn_process_sms_deposit(text, numeric, text, text, text, text, bigint);

create or replace function public.fn_process_sms_deposit(
  p_raw_message text,
  p_amount numeric,
  p_sender_phone text,
  p_reference_code text default null,
  p_provider text default null,
  p_sms_hash text default null,
  p_webhook_event_id bigint default null,
  p_direction text default null
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_hash text;
  v_existing public.deposits;
  v_sender text := public.fn_normalize_phone(p_sender_phone);
  v_ref text;
  v_intent public.deposit_intents;
  v_user_id uuid;
  v_amount numeric(14,2);
  v_strategy text;
  v_confidence numeric(4,3);
  v_tolerance numeric;
  v_window integer;
  v_candidates uuid[];
  v_deposit public.deposits;
  v_wallet public.wallets;
  v_ledger_id bigint;
  v_note text;
  v_direction text := lower(coalesce(nullif(trim(p_direction), ''), 'unknown'));
begin
  -- 1. Idempotency: the same SMS can never be credited twice.
  -- md5() is core PostgreSQL, so this works everywhere (the app sends sha256).
  v_hash := coalesce(p_sms_hash, md5(coalesce(p_raw_message, '')));
  select * into v_existing from public.deposits where sms_hash = v_hash;
  if v_existing.id is not null then
    return jsonb_build_object(
      'ok', true, 'status', 'duplicate', 'duplicate_of', v_existing.id,
      'deposit_status', v_existing.status, 'message', 'This SMS was already processed.'
    );
  end if;

  v_amount := case when p_amount is null then null else round(p_amount::numeric, 2) end;
  if v_amount is not null and v_amount <= 0 then v_amount := null; end if;

  -- 2. Normalise the reference code: "pb 4x7q" -> "PB-4X7Q"
  v_ref := upper(coalesce(nullif(trim(p_reference_code), ''), ''));
  if v_ref = '' and p_raw_message ~* '\mPB[ \-]?[A-Z0-9]{4}\M' then
    v_ref := upper(substring(p_raw_message from '(?i)\mPB[ \-]?([A-Z0-9]{4})\M'));
  end if;
  v_ref := regexp_replace(coalesce(v_ref, ''), '[^A-Z0-9]', '', 'g');
  if v_ref like 'PB%' and length(v_ref) = 6 then
    v_ref := 'PB-' || substr(v_ref, 3);
  elsif v_ref <> '' and v_ref not like 'PB-%' then
    if length(v_ref) = 4 then v_ref := 'PB-' || v_ref; else v_ref := ''; end if;
  end if;

  -- 3. Match. Reference first, then sender phone, then amount+window.
  v_strategy := null; v_confidence := null; v_user_id := null; v_intent := null;

  if v_ref <> '' then
    select * into v_intent
      from public.deposit_intents
     where reference_code = v_ref and status = 'pending_match' and expires_at > now() - interval '12 hours'
     order by created_at desc limit 1;
    if v_intent.id is not null then
      v_user_id := v_intent.user_id;
      v_strategy := 'reference';
      v_confidence := 1.000;
    end if;
  end if;

  if v_user_id is null and v_sender is not null and public.fn_is_valid_gh_phone(v_sender) then
    select id into v_user_id from public.users where phone = v_sender and status = 'active';
    if v_user_id is not null then
      v_strategy := 'sender_phone';
      v_confidence := 0.900;
    end if;
  end if;

  if v_user_id is null and v_amount is not null then
    v_window := public.fn_setting_num('deposit_amount_match_window_minutes', 240)::int;
    select array_agg(di.id) into v_candidates
      from public.deposit_intents di
     where di.status = 'pending_match'
       and di.expected_amount_ghs = v_amount
       and di.created_at > now() - make_interval(mins => v_window)
       and di.expires_at > now() - interval '6 hours'
       and exists (select 1 from public.users u where u.id = di.user_id and u.status = 'active');
    if v_candidates is not null and array_length(v_candidates, 1) = 1 then
      select * into v_intent from public.deposit_intents where id = v_candidates[1];
      v_user_id := v_intent.user_id;
      v_strategy := 'amount_window';
      v_confidence := 0.700;
    end if;
  end if;

  -- 3b. DIRECTION GUARD. The collection phone also receives debit alerts
  --     (cash-outs, airtime purchases, transfers out). Those must never be
  --     credited:
  --       debit                        -> always held for a human
  --       unknown + sender_phone only  -> held: that is the weakest signal
  --                                       (any SMS mentioning the number) and
  --                                       it is not enough to create money
  --     A reference-code or amount-window match is corroborated by the user's
  --     own pending intent, so those are still credited.
  if v_user_id is not null
     and (v_direction = 'debit' or (v_direction = 'unknown' and v_strategy = 'sender_phone')) then
    insert into public.deposits (
      user_id, deposit_intent_id, amount_ghs, sender_phone, provider, reference_code,
      raw_message, sms_hash, status, match_strategy, match_confidence, hold_reason, metadata
    ) values (
      v_user_id, v_intent.id, coalesce(v_amount, 0), v_sender, p_provider, nullif(v_ref, ''),
      coalesce(p_raw_message, ''), v_hash, 'unmatched_review', v_strategy, v_confidence,
      case when v_direction = 'debit' then 'DEBIT_MESSAGE' else 'DIRECTION_UNVERIFIED' end,
      jsonb_build_object('webhook_event_id', p_webhook_event_id, 'direction', v_direction,
                         'matched_user_id', v_user_id)
    ) returning * into v_deposit;

    return jsonb_build_object(
      'ok', true, 'status', 'unmatched_review', 'deposit_id', v_deposit.id,
      'hold_reason', v_deposit.hold_reason, 'direction', v_direction,
      'amount_ghs', v_amount, 'user_id', v_user_id,
      'message', case when v_direction = 'debit'
                      then 'This looks like a debit alert, not an incoming payment. Held for review.'
                      else 'Held for review - could not confirm this was an incoming payment.' end
    );
  end if;

  -- 4. No confident match -> human review. Never guess with money.
  if v_user_id is null then
    insert into public.deposits (
      user_id, deposit_intent_id, amount_ghs, sender_phone, provider, reference_code,
      raw_message, sms_hash, status, match_strategy, match_confidence, hold_reason, metadata
    ) values (
      null, null, coalesce(v_amount, 0), v_sender, p_provider, nullif(v_ref, ''),
      coalesce(p_raw_message, ''), v_hash, 'unmatched_review', 'unmatched', 0,
      case
        when v_amount is null then 'AMOUNT_UNPARSED'
        when v_candidates is not null and array_length(v_candidates, 1) > 1 then 'AMBIGUOUS_AMOUNT_MATCH'
        else 'NO_MATCHING_INTENT'
      end,
      jsonb_build_object(
        'webhook_event_id', p_webhook_event_id,
        'candidate_intents', coalesce(to_jsonb(v_candidates), '[]'::jsonb),
        'raw_reference', nullif(v_ref, '')
      )
    ) returning * into v_deposit;

    return jsonb_build_object(
      'ok', true, 'status', 'unmatched_review', 'deposit_id', v_deposit.id,
      'hold_reason', v_deposit.hold_reason, 'amount_ghs', v_amount, 'sender_phone', v_sender,
      'message', 'Held for manual review — no confident match.'
    );
  end if;

  -- 5. Confidence guard for the amount+window route: a single fuzzy match is
  --    still only accepted if the parsed amount is exact (it is, by definition
  --    of the query) — anything else already fell through to review above.
  if v_amount is null then
    insert into public.deposits (
      user_id, deposit_intent_id, amount_ghs, sender_phone, provider, reference_code,
      raw_message, sms_hash, status, match_strategy, match_confidence, hold_reason, metadata
    ) values (
      v_user_id, v_intent.id, 0, v_sender, p_provider, nullif(v_ref, ''),
      coalesce(p_raw_message, ''), v_hash, 'unmatched_review', v_strategy, v_confidence,
      'AMOUNT_UNPARSED',
      jsonb_build_object('webhook_event_id', p_webhook_event_id)
    ) returning * into v_deposit;
    return jsonb_build_object('ok', true, 'status', 'unmatched_review', 'deposit_id', v_deposit.id,
                              'hold_reason', 'AMOUNT_UNPARSED', 'user_id', v_user_id);
  end if;

  -- 6. Amount sanity vs the intent (reference matches can legitimately differ —
  --    we credit what actually arrived and flag the difference).
  v_note := null;
  if v_intent.id is not null then
    v_tolerance := greatest(1.00, round(v_intent.expected_amount_ghs * 0.02, 2));
    if abs(v_intent.expected_amount_ghs - v_amount) > v_tolerance then
      v_note := format('Intent expected GHS %s but GHS %s arrived; credited the actual amount.',
                       v_intent.expected_amount_ghs, v_amount);
      v_confidence := least(v_confidence, 0.850);
    end if;
  end if;

  -- 7. ATOMIC CREDIT: deposit row + wallet + ledger + intent, one transaction.
  insert into public.deposits (
    user_id, deposit_intent_id, amount_ghs, sender_phone, provider, reference_code,
    raw_message, sms_hash, status, match_strategy, match_confidence, metadata
  ) values (
    v_user_id, v_intent.id, v_amount, v_sender, p_provider, nullif(v_ref, ''),
    coalesce(p_raw_message, ''), v_hash, 'credited', v_strategy, v_confidence,
    jsonb_build_object('webhook_event_id', p_webhook_event_id, 'note', v_note, 'direction', v_direction)
  ) returning * into v_deposit;

  perform 1 from public.wallets where user_id = v_user_id for update;  -- lock
  v_wallet := public.fn_wallet_apply(v_user_id, v_amount, 0, v_amount, 0, 0);

  v_ledger_id := public.fn_ledger_append(
    v_user_id,
    'deposit',
    v_amount,
    format('Wallet top-up received via %s (%s)', coalesce(p_provider, 'Mobile Money'), v_strategy),
    v_wallet.balance_ghs,
    0, v_wallet.commission_balance_ghs,
    coalesce(v_deposit.reference_code, 'DEP-' || substr(v_hash, 1, 8)),
    null, null,
    jsonb_build_object('deposit_id', v_deposit.id, 'intent_id', v_intent.id,
                       'match_strategy', v_strategy, 'confidence', v_confidence,
                       'sender_phone', v_sender, 'webhook_event_id', p_webhook_event_id)
  );

  update public.deposits set credited_ledger_id = v_ledger_id where id = v_deposit.id;

  if v_intent.id is not null then
    update public.deposit_intents
       set status = 'matched', matched_deposit_id = v_deposit.id, note = coalesce(v_note, note), updated_at = now()
     where id = v_intent.id;
  end if;

  perform public.fn_notify(
    v_user_id, 'Top-up successful',
    format('GHS %s has been added to your Priceless Bundle wallet. New balance: GHS %s.',
           to_char(v_amount, 'FM999999990.00'), to_char(v_wallet.balance_ghs, 'FM999999990.00')),
    'success',
    jsonb_build_object('deposit_id', v_deposit.id, 'amount_ghs', v_amount, 'match_strategy', v_strategy)
  );

  return jsonb_build_object(
    'ok', true, 'status', 'credited', 'deposit_id', v_deposit.id, 'intent_id', v_intent.id,
    'user_id', v_user_id, 'amount_ghs', v_amount, 'new_balance_ghs', v_wallet.balance_ghs,
    'match_strategy', v_strategy, 'confidence', v_confidence, 'ledger_id', v_ledger_id,
    'direction', v_direction, 'note', v_note, 'message', 'Wallet credited.'
  );
end $$;

-- ---------------------------------------------------------------------------
-- 5. BUY DATA — atomic debit + order creation, tier pricing, auto-refund
-- ---------------------------------------------------------------------------

create or replace function public.fn_purchase_data(
  p_user_id uuid,
  p_plan_id uuid,
  p_recipient_phone text,
  p_channel public.bot_channel default 'web',
  p_end_customer_phone text default null,
  p_external_user_ref text default null,
  p_raw_command text default null
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_user public.users;
  v_plan public.plans;
  v_wallet public.wallets;
  v_pricing jsonb;
  v_price numeric(14,2);
  v_recipient text;
  v_order public.orders;
  v_ledger_id bigint;
  v_attributed uuid;
  v_squad_id uuid;
  v_bot public.bot_orders;
begin
  -- Lock the buyer row: serialises a user's own concurrent purchases.
  select * into v_user from public.users where id = p_user_id for update;
  if v_user.id is null then
    return jsonb_build_object('ok', false, 'error', 'USER_NOT_FOUND');
  end if;
  if v_user.status <> 'active' then
    return jsonb_build_object('ok', false, 'error', 'ACCOUNT_SUSPENDED', 'message', 'This account is suspended. Contact support.');
  end if;

  -- Roll the squad period over first so pricing uses the correct tier state.
  if v_user.squad_id is not null then
    perform public.fn_ensure_squad_period(v_user.squad_id);
    select * into v_user from public.users where id = p_user_id;
  end if;

  select * into v_plan from public.plans where id = p_plan_id and active;
  if v_plan.id is null then
    return jsonb_build_object('ok', false, 'error', 'PLAN_UNAVAILABLE', 'message', 'That bundle is no longer available.');
  end if;

  -- Price is resolved SERVER-SIDE from the buyer's own record. A client-sent
  -- price is never read, so it can never be trusted.
  v_pricing := public.fn_price_for_user(p_user_id, v_plan);
  if not (v_pricing->>'ok')::boolean then return v_pricing; end if;
  v_price := (v_pricing->>'price_ghs')::numeric;

  v_recipient := public.fn_normalize_phone(coalesce(nullif(p_end_customer_phone, ''), p_recipient_phone));
  if not public.fn_is_valid_gh_phone(v_recipient) then
    return jsonb_build_object('ok', false, 'error', 'INVALID_RECIPIENT', 'message', 'Enter a valid Ghana number for the recipient, e.g. 0244123456.');
  end if;

  -- Wallet row lock + balance gate. Nothing partial: no debit, no order.
  select * into v_wallet from public.wallets where user_id = p_user_id for update;
  if v_wallet.user_id is null then
    insert into public.wallets (user_id) values (p_user_id) returning * into v_wallet;
  end if;
  if v_wallet.balance_ghs < v_price then
    return jsonb_build_object(
      'ok', false, 'error', 'INSUFFICIENT_FUNDS',
      'message', format('Insufficient wallet balance. You need GHS %s but have GHS %s. Top up to continue.',
                        to_char(v_price, 'FM999999990.00'), to_char(v_wallet.balance_ghs, 'FM999999990.00')),
      'required_ghs', v_price, 'balance_ghs', v_wallet.balance_ghs,
      'shortfall_ghs', round(v_price - v_wallet.balance_ghs, 2)
    );
  end if;

  -- Squad attribution: sales by a squad member roll up to that squad's Super Agent.
  v_attributed := null; v_squad_id := v_user.squad_id;
  if v_squad_id is not null then
    select super_agent_id into v_attributed from public.squads where id = v_squad_id;
  end if;

  v_wallet := public.fn_wallet_apply(p_user_id, -v_price, 0, 0, v_price, 0);

  insert into public.orders (
    buyer_id, plan_id, recipient_phone, price_charged_ghs, cost_price_ghs,
    buyer_tier_at_purchase, status, channel, supplier, attributed_super_agent_id,
    squad_id, network, size_label, data_mb
  ) values (
    p_user_id, v_plan.id, v_recipient, v_price, v_plan.cost_price_ghs,
    v_user.tier, 'pending', coalesce(p_channel, 'web'), 'mock_datamartgh', v_attributed,
    v_squad_id, v_plan.network, v_plan.size_label, v_plan.data_mb
  ) returning * into v_order;

  v_ledger_id := public.fn_ledger_append(
    p_user_id, 'purchase', -v_price,
    format('%s %s to %s', v_plan.network, v_plan.size_label, v_recipient),
    v_wallet.balance_ghs, 0, v_wallet.commission_balance_ghs,
    'ORD-' || upper(substr(replace(v_order.id::text, '-', ''), 1, 10)),
    v_order.id, null,
    jsonb_build_object('plan_id', v_plan.id, 'network', v_plan.network, 'size_label', v_plan.size_label,
                       'recipient_phone', v_recipient, 'tier', v_user.tier,
                       'effective_tier', v_pricing->>'effective_tier', 'channel', coalesce(p_channel, 'web'))
  );

  -- Bot-in-a-Box attribution row (the Super Agent's own bot sale).
  if coalesce(p_channel, 'web') in ('telegram', 'whatsapp') then
    insert into public.bot_orders (
      order_id, super_agent_id, channel, end_customer_phone, external_user_ref,
      raw_command, network, size_label, price_charged_ghs
    ) values (
      v_order.id, p_user_id, p_channel, v_recipient, p_external_user_ref,
      left(p_raw_command, 500), v_plan.network, v_plan.size_label, v_price
    ) returning * into v_bot;
  end if;

  return jsonb_build_object(
    'ok', true,
    'order', jsonb_build_object(
      'id', v_order.id, 'status', v_order.status, 'network', v_plan.network,
      'size_label', v_plan.size_label, 'recipient_phone', v_recipient,
      'price_charged_ghs', v_price, 'buyer_tier_at_purchase', v_user.tier,
      'created_at', v_order.created_at, 'channel', v_order.channel,
      'attributed_super_agent_id', v_attributed, 'squad_id', v_squad_id
    ),
    'pricing', v_pricing,
    'wallet', jsonb_build_object('balance_ghs', v_wallet.balance_ghs,
                                 'commission_balance_ghs', v_wallet.commission_balance_ghs),
    'ledger_id', v_ledger_id,
    'message', format('%s %s queued for %s', v_plan.network, v_plan.size_label, v_recipient)
  );
end $$;

-- Supplier result -> final order state. Success: deliver + squad volume +
-- commission. Failure: refund the wallet in the SAME transaction.
create or replace function public.fn_fulfill_order(
  p_order_id uuid,
  p_success boolean,
  p_supplier_reference text default null,
  p_supplier_response jsonb default '{}'::jsonb,
  p_failure_reason text default null
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_order public.orders;
  v_wallet public.wallets;
  v_ledger_id bigint;
  v_commission numeric(14,2) := 0;
  v_rate numeric;
  v_commission_id uuid;
begin
  select * into v_order from public.orders where id = p_order_id for update;
  if v_order.id is null then
    return jsonb_build_object('ok', false, 'error', 'ORDER_NOT_FOUND');
  end if;
  if v_order.status in ('delivered', 'failed', 'refunded') then
    return jsonb_build_object('ok', false, 'error', 'ALREADY_FINAL', 'status', v_order.status,
                              'message', 'This order already reached a final state.');
  end if;

  if p_success then
    update public.orders
       set status = 'delivered',
           supplier_reference = coalesce(p_supplier_reference, supplier_reference),
           supplier_response = coalesce(p_supplier_response, '{}'::jsonb),
           fulfilled_at = now(),
           updated_at = now()
     where id = p_order_id
     returning * into v_order;

    -- Squad volume rolls up only for delivered orders.
    if v_order.squad_id is not null then
      perform public.fn_squad_recompute(v_order.squad_id);
    end if;

    -- Super Agent earns a commission when a squad member's sale is delivered.
    if v_order.attributed_super_agent_id is not null and v_order.attributed_super_agent_id <> v_order.buyer_id then
      v_rate := public.fn_setting_num('commission_rate_squad_sale', 0.03);
      v_commission := round(v_order.price_charged_ghs * v_rate, 2);
      if v_commission >= 0.01 then
        insert into public.commissions (user_id, source_order_id, amount_ghs, rate, description)
        values (v_order.attributed_super_agent_id, v_order.id, v_commission, v_rate,
                format('Commission on %s %s sold to %s', v_order.network, v_order.size_label, v_order.recipient_phone))
        returning id into v_commission_id;

        select * into v_wallet from public.wallets where user_id = v_order.attributed_super_agent_id for update;
        v_wallet := public.fn_wallet_apply(v_order.attributed_super_agent_id, 0, v_commission);

        perform public.fn_ledger_append(
          v_order.attributed_super_agent_id, 'commission', 0,
          format('Commission (GHS %s) from squad sale to %s', to_char(v_commission, 'FM999999990.00'), v_order.recipient_phone),
          v_wallet.balance_ghs, v_commission, v_wallet.commission_balance_ghs,
          'COM-' || upper(substr(replace(v_order.id::text, '-', ''), 1, 10)),
          v_order.id, v_order.buyer_id,
          jsonb_build_object('rate', v_rate, 'commission_id', v_commission_id)
        );

        perform public.fn_notify(
          v_order.attributed_super_agent_id, 'Commission earned',
          format('GHS %s commission from a squad sale of %s %s. Reinvest it from your wallet for a bonus.',
                 to_char(v_commission, 'FM999999990.00'), v_order.network, v_order.size_label),
          'success', jsonb_build_object('order_id', v_order.id, 'amount_ghs', v_commission)
        );
      end if;
    end if;

    perform public.fn_notify(
      v_order.buyer_id, 'Data delivered',
      format('%s %s delivered to %s.', v_order.network, v_order.size_label, v_order.recipient_phone),
      'success', jsonb_build_object('order_id', v_order.id)
    );

    return jsonb_build_object('ok', true, 'status', 'delivered', 'order_id', v_order.id,
                              'supplier_reference', v_order.supplier_reference,
                              'commission_ghs', v_commission);
  end if;

  -- ---- Failure path: refund, never leave the buyer out of pocket. ----
  update public.orders
     set status = 'failed',
         failure_reason = coalesce(p_failure_reason, 'Supplier rejected the request'),
         supplier_response = coalesce(p_supplier_response, '{}'::jsonb),
         updated_at = now()
   where id = p_order_id
   returning * into v_order;

  select * into v_wallet from public.wallets where user_id = v_order.buyer_id for update;
  v_wallet := public.fn_wallet_apply(v_order.buyer_id, v_order.price_charged_ghs, 0, 0, -v_order.price_charged_ghs, 0);

  v_ledger_id := public.fn_ledger_append(
    v_order.buyer_id, 'refund', v_order.price_charged_ghs,
    format('Refund — %s %s to %s failed: %s', v_order.network, v_order.size_label, v_order.recipient_phone,
           coalesce(p_failure_reason, 'supplier error')),
    v_wallet.balance_ghs, 0, v_wallet.commission_balance_ghs,
    'RFD-' || upper(substr(replace(v_order.id::text, '-', ''), 1, 10)),
    v_order.id, null,
    jsonb_build_object('reason', p_failure_reason, 'supplier_response', coalesce(p_supplier_response, '{}'::jsonb))
  );

  update public.orders
     set status = 'refunded', refund_ledger_id = v_ledger_id, updated_at = now()
   where id = p_order_id
   returning * into v_order;

  perform public.fn_notify(
    v_order.buyer_id, 'Order refunded',
    format('%s %s to %s could not be delivered, so GHS %s was refunded to your wallet.',
           v_order.network, v_order.size_label, v_order.recipient_phone,
           to_char(v_order.price_charged_ghs, 'FM999999990.00')),
    'warning', jsonb_build_object('order_id', v_order.id, 'reason', p_failure_reason)
  );

  return jsonb_build_object('ok', true, 'status', 'refunded', 'order_id', v_order.id,
                            'refunded_ghs', v_order.price_charged_ghs,
                            'new_balance_ghs', v_wallet.balance_ghs,
                            'ledger_id', v_ledger_id, 'reason', p_failure_reason);
end $$;

-- Mark an order as "processing" while the supplier call is in flight.
create or replace function public.fn_mark_order_processing(p_order_id uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_order public.orders;
begin
  update public.orders set status = 'processing', updated_at = now()
   where id = p_order_id and status = 'pending'
  returning * into v_order;
  if v_order.id is null then
    return jsonb_build_object('ok', false, 'error', 'NOT_PENDING');
  end if;
  return jsonb_build_object('ok', true, 'order_id', v_order.id, 'status', v_order.status);
end $$;

-- ---------------------------------------------------------------------------
-- 6. AGENT TIERS & THE SQUAD MECHANIC
-- ---------------------------------------------------------------------------

-- Free registration as a Sub-Agent.
create or replace function public.fn_upgrade_to_sub_agent(p_user_id uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_user public.users;
begin
  select * into v_user from public.users where id = p_user_id for update;
  if v_user.id is null then return jsonb_build_object('ok', false, 'error', 'USER_NOT_FOUND'); end if;
  if v_user.tier = 'super_agent' then
    return jsonb_build_object('ok', false, 'error', 'ALREADY_SUPER_AGENT', 'message', 'You are already a Super Agent.');
  end if;
  if v_user.tier = 'sub_agent' then
    return jsonb_build_object('ok', true, 'tier', 'sub_agent', 'already', true, 'user', public.fn_user_public(p_user_id));
  end if;

  update public.users set tier = 'sub_agent', updated_at = now() where id = p_user_id;
  perform public.fn_notify(p_user_id, 'You are now a Sub-Agent',
    'Sub-Agent pricing is live on your account. Join a Squad to help your team keep its discount tier.', 'success');

  return jsonb_build_object('ok', true, 'tier', 'sub_agent', 'already', false, 'user', public.fn_user_public(p_user_id));
end $$;

-- Super Agent: unlocked by a GHS 500 lifetime wallet deposit commitment.
create or replace function public.fn_upgrade_eligibility(p_user_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_user public.users;
  v_deposited numeric := 0;
  v_commitment numeric := public.fn_setting_num('super_agent_commitment_ghs', 500);
begin
  select * into v_user from public.users where id = p_user_id;
  if v_user.id is null then return jsonb_build_object('ok', false, 'error', 'USER_NOT_FOUND'); end if;
  select total_deposited_ghs into v_deposited from public.wallets where user_id = p_user_id;
  v_deposited := coalesce(v_deposited, 0);
  return jsonb_build_object(
    'ok', true,
    'tier', v_user.tier,
    'commitment_ghs', v_commitment,
    'deposited_lifetime_ghs', v_deposited,
    'eligible', v_deposited >= v_commitment,
    'remaining_ghs', greatest(v_commitment - v_deposited, 0),
    'progress_pct', least(round(v_deposited / nullif(v_commitment, 0) * 100, 1), 100),
    'instant_withdrawal_fee_ghs', public.fn_setting_num('instant_withdrawal_fee_ghs', 1.5),
    'reinvest_bonus_min_pct', public.fn_setting_num('reinvest_bonus_min_pct', 2),
    'reinvest_bonus_max_pct', public.fn_setting_num('reinvest_bonus_max_pct', 5)
  );
end $$;

create or replace function public.fn_upgrade_to_super_agent(p_user_id uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_user public.users;
  v_elig jsonb;
  v_squad public.squads;
  v_code text;
  v_tries integer := 0;
begin
  select * into v_user from public.users where id = p_user_id for update;
  if v_user.id is null then return jsonb_build_object('ok', false, 'error', 'USER_NOT_FOUND'); end if;
  if v_user.tier = 'super_agent' then
    return jsonb_build_object('ok', true, 'tier', 'super_agent', 'already', true, 'user', public.fn_user_public(p_user_id));
  end if;

  v_elig := public.fn_upgrade_eligibility(p_user_id);
  if not (v_elig->>'eligible')::boolean then
    return jsonb_build_object(
      'ok', false, 'error', 'COMMITMENT_NOT_MET',
      'message', format('Super Agent unlocks at GHS %s of lifetime wallet deposits. You are GHS %s away.',
                        to_char((v_elig->>'commitment_ghs')::numeric, 'FM999999990.00'),
                        to_char((v_elig->>'remaining_ghs')::numeric, 'FM999999990.00')),
      'eligibility', v_elig
    );
  end if;

  update public.users
     set tier = 'super_agent', super_agent_unlocked_at = coalesce(super_agent_unlocked_at, now()), updated_at = now()
   where id = p_user_id;

  select * into v_squad from public.squads where super_agent_id = p_user_id;
  if v_squad.id is null then
    loop
      v_code := public.fn_random_code('SQL-', 5);  -- squad invite code, not SQL :)
      exit when not exists (select 1 from public.squads where invite_code = v_code);
      v_tries := v_tries + 1;
      if v_tries > 25 then return jsonb_build_object('ok', false, 'error', 'CODE_GENERATION_FAILED'); end if;
    end loop;
    insert into public.squads (super_agent_id, name, invite_code, volume_target_ghs, current_period_start)
    values (p_user_id,
            coalesce(nullif(trim(coalesce(v_user.full_name, '')), ''), 'Super Agent') || ' Squad',
            v_code,
            public.fn_setting_num('squad_volume_target_ghs', 5000),
            public.fn_period_start())
    returning * into v_squad;
  end if;

  perform public.fn_notify(p_user_id, 'Super Agent unlocked',
    format('Welcome to VIP wholesale pricing. Your Squad "%s" is ready — invite Sub-Agents with code %s.',
           v_squad.name, v_squad.invite_code), 'success', jsonb_build_object('squad_id', v_squad.id));

  return jsonb_build_object('ok', true, 'tier', 'super_agent', 'already', false,
                            'squad', to_jsonb(v_squad), 'user', public.fn_user_public(p_user_id));
end $$;

-- Period rollover: closes the last month, decides tier retention, opens a new one.
create or replace function public.fn_ensure_squad_period(p_squad_id uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_squad public.squads;
  v_period_start timestamptz := public.fn_period_start();
  v_prev_volume numeric := 0;
  v_volume numeric := 0;
  v_retained boolean;
begin
  select * into v_squad from public.squads where id = p_squad_id for update;
  if v_squad.id is null then return jsonb_build_object('ok', false, 'error', 'SQUAD_NOT_FOUND'); end if;
  if v_squad.current_period_start >= v_period_start then
    return jsonb_build_object('ok', true, 'rolled_over', false, 'current_volume_ghs', v_squad.current_volume_ghs);
  end if;

  -- Volume actually delivered during the period that just ended.
  select coalesce(sum(price_charged_ghs), 0) into v_prev_volume
    from public.orders
   where squad_id = p_squad_id and status = 'delivered'
     and created_at >= v_squad.current_period_start and created_at < v_period_start;

  v_retained := v_prev_volume >= v_squad.volume_target_ghs;

  -- Volume already accrued in the new period (sales since midnight on the 1st).
  select coalesce(sum(price_charged_ghs), 0) into v_volume
    from public.orders
   where squad_id = p_squad_id and status = 'delivered' and created_at >= v_period_start;

  update public.squads
     set current_period_start = v_period_start,
         current_volume_ghs = v_volume,
         tier_retained = v_retained,
         updated_at = now()
   where id = p_squad_id;

  perform public.fn_notify(
    v_squad.super_agent_id,
    case when v_retained then 'Squad target met — tier retained' else 'Squad tier missed the monthly target' end,
    format('Last period closed at GHS %s against a GHS %s target. Squad pricing is now at %s.',
           to_char(v_prev_volume, 'FM999999990.00'), to_char(v_squad.volume_target_ghs, 'FM999999990.00'),
           case when v_retained then 'Sub-Agent level' else 'retail level until the target is hit' end),
    case when v_retained then 'success' else 'warning' end,
    jsonb_build_object('squad_id', p_squad_id, 'prev_volume_ghs', v_prev_volume, 'retained', v_retained)
  );

  return jsonb_build_object('ok', true, 'rolled_over', true, 'prev_volume_ghs', v_prev_volume,
                            'tier_retained', v_retained, 'current_volume_ghs', v_volume);
end $$;

-- Recompute a squad's current-period volume + retention. Called after every
-- delivered purchase by a squad member.
create or replace function public.fn_squad_recompute(p_squad_id uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_squad public.squads;
  v_volume numeric := 0;
  v_retained boolean;
  v_members integer := 0;
begin
  if p_squad_id is null then return jsonb_build_object('ok', false, 'error', 'NO_SQUAD'); end if;
  perform public.fn_ensure_squad_period(p_squad_id);
  select * into v_squad from public.squads where id = p_squad_id;
  if v_squad.id is null then return jsonb_build_object('ok', false, 'error', 'SQUAD_NOT_FOUND'); end if;

  select coalesce(sum(price_charged_ghs), 0) into v_volume
    from public.orders
   where squad_id = p_squad_id and status = 'delivered' and created_at >= v_squad.current_period_start;

  -- Retention rule: a squad LOSES its discount tier only when a period closes
  -- below target (handled by fn_ensure_squad_period). During an open period the
  -- tier stays — and is earned back the moment the target is hit.
  v_retained := v_squad.tier_retained or v_volume >= v_squad.volume_target_ghs;
  select count(*) into v_members from public.users where squad_id = p_squad_id and tier <> 'super_agent' and status = 'active';

  update public.squads
     set current_volume_ghs = v_volume, tier_retained = v_retained, updated_at = now()
   where id = p_squad_id;

  return jsonb_build_object('ok', true, 'squad_id', p_squad_id, 'current_volume_ghs', v_volume,
                            'volume_target_ghs', v_squad.volume_target_ghs, 'tier_retained', v_retained,
                            'members', v_members,
                            'progress_pct', least(round(v_volume / nullif(v_squad.volume_target_ghs, 0) * 100, 1), 100));
end $$;

create or replace function public.fn_rollover_squads() returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid; v_count integer := 0; v_r jsonb;
begin
  for v_id in select id from public.squads loop
    v_r := public.fn_ensure_squad_period(v_id);
    if (v_r->>'rolled_over')::boolean then v_count := v_count + 1; end if;
  end loop;
  return jsonb_build_object('ok', true, 'rolled_over', v_count);
end $$;

create or replace function public.fn_squad_dashboard(p_user_id uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_user public.users;
  v_squad public.squads;
  v_owner public.users;
  v_recompute jsonb;
  v_members jsonb := '[]'::jsonb;
  v_top jsonb := '[]'::jsonb;
  v_daily jsonb := '[]'::jsonb;
  v_my_volume numeric := 0;
begin
  select * into v_user from public.users where id = p_user_id;
  if v_user.id is null then return jsonb_build_object('ok', false, 'error', 'USER_NOT_FOUND'); end if;

  -- A Sub-Agent belongs to a squad through users.squad_id; a Super Agent OWNS
  -- one through squads.super_agent_id. Both land on the same dashboard.
  if v_user.squad_id is not null then
    select * into v_squad from public.squads where id = v_user.squad_id;
  end if;
  if v_squad.id is null then
    select * into v_squad from public.squads where super_agent_id = p_user_id;
  end if;
  if v_squad.id is null then
    return jsonb_build_object('ok', true, 'squad', null, 'member_of_squad', false,
                              'is_super_agent', v_user.tier = 'super_agent',
                              'members', '[]'::jsonb, 'member_count', 0,
                              'daily', '[]'::jsonb, 'by_network', '[]'::jsonb);
  end if;

  v_recompute := public.fn_squad_recompute(v_squad.id);
  select * into v_squad from public.squads where id = v_squad.id;
  select * into v_owner from public.users where id = v_squad.super_agent_id;

  select coalesce(jsonb_agg(t.m order by (t.m->>'volume_ghs')::numeric desc), '[]'::jsonb) into v_members
  from (
    select jsonb_build_object(
      'user_id', u.id, 'phone', u.phone, 'full_name', u.full_name, 'tier', u.tier,
      'joined_at', u.created_at, 'activated', u.pin_hash is not null,
      'volume_ghs', coalesce((select sum(o.price_charged_ghs) from public.orders o
                               where o.buyer_id = u.id and o.squad_id = v_squad.id
                                 and o.status = 'delivered' and o.created_at >= v_squad.current_period_start), 0),
      'orders', coalesce((select count(*) from public.orders o
                           where o.buyer_id = u.id and o.squad_id = v_squad.id
                             and o.status = 'delivered' and o.created_at >= v_squad.current_period_start), 0)
    ) as m
    from public.users u
    where u.squad_id = v_squad.id and u.status = 'active'
  ) t;

  select coalesce(jsonb_agg(jsonb_build_object('day', d.day, 'volume_ghs', d.volume, 'orders', d.cnt) order by d.day), '[]'::jsonb)
    into v_daily
  from (
    select (o.created_at at time zone 'Africa/Accra')::date as day,
           sum(o.price_charged_ghs) as volume, count(*) as cnt
      from public.orders o
     where o.squad_id = v_squad.id and o.status = 'delivered'
       and o.created_at >= v_squad.current_period_start
     group by 1
  ) d;

  select coalesce(jsonb_agg(jsonb_build_object('network', n.network, 'volume_ghs', n.volume, 'orders', n.cnt) order by n.volume desc), '[]'::jsonb)
    into v_top
  from (
    select o.network, sum(o.price_charged_ghs) as volume, count(*) as cnt
      from public.orders o
     where o.squad_id = v_squad.id and o.status = 'delivered'
       and o.created_at >= v_squad.current_period_start
     group by 1
  ) n;

  select coalesce(sum(o.price_charged_ghs), 0) into v_my_volume
    from public.orders o
   where o.buyer_id = p_user_id and o.squad_id = v_squad.id
     and o.status = 'delivered' and o.created_at >= v_squad.current_period_start;

  return jsonb_build_object(
    'ok', true,
    'member_of_squad', true,
    'is_super_agent', v_squad.super_agent_id = p_user_id,
    'is_squad_owner', v_squad.super_agent_id = p_user_id,
    'squad', to_jsonb(v_squad) || jsonb_build_object(
      'super_agent', jsonb_build_object('id', v_owner.id, 'phone', v_owner.phone, 'full_name', v_owner.full_name),
      'period_end', public.fn_period_end(v_squad.current_period_start),
      'progress_pct', least(round(v_squad.current_volume_ghs / nullif(v_squad.volume_target_ghs, 0) * 100, 1), 100),
      'remaining_ghs', greatest(v_squad.volume_target_ghs - v_squad.current_volume_ghs, 0)
    ),
    'members', coalesce(v_members, '[]'::jsonb),
    'member_count', jsonb_array_length(coalesce(v_members, '[]'::jsonb)),
    'daily', coalesce(v_daily, '[]'::jsonb),
    'by_network', coalesce(v_top, '[]'::jsonb),
    'recompute', v_recompute,
    'my_volume_ghs', v_my_volume
  );
end $$;

create or replace function public.fn_join_squad(p_user_id uuid, p_invite_code text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_user public.users;
  v_squad public.squads;
begin
  select * into v_user from public.users where id = p_user_id for update;
  if v_user.id is null then return jsonb_build_object('ok', false, 'error', 'USER_NOT_FOUND'); end if;

  select * into v_squad from public.squads where upper(invite_code) = upper(trim(p_invite_code));
  if v_squad.id is null then
    return jsonb_build_object('ok', false, 'error', 'INVALID_INVITE', 'message', 'That squad code was not found.');
  end if;
  if v_squad.super_agent_id = p_user_id then
    return jsonb_build_object('ok', false, 'error', 'OWN_SQUAD', 'message', 'You already own this squad.');
  end if;
  if v_user.squad_id = v_squad.id then
    return jsonb_build_object('ok', true, 'already_member', true, 'squad', to_jsonb(v_squad));
  end if;

  update public.users
     set squad_id = v_squad.id,
         tier = case when tier = 'customer' then 'sub_agent'::public.user_tier else tier end,
         updated_at = now()
   where id = p_user_id;

  perform public.fn_squad_recompute(v_squad.id);
  perform public.fn_notify(v_squad.super_agent_id, 'New squad member',
    coalesce(v_user.full_name, v_user.phone) || ' joined your squad ' || v_squad.name || '.', 'success');

  return jsonb_build_object('ok', true, 'already_member', false, 'squad', to_jsonb(v_squad),
                            'user', public.fn_user_public(p_user_id));
end $$;

-- A Super Agent adds a Sub-Agent by phone. Creates a pin-less "pending
-- activation" account that the recruit activates on first sign-in.
create or replace function public.fn_recruit_sub_agent(
  p_super_agent_id uuid, p_phone text, p_full_name text default null
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_sa public.users;
  v_squad public.squads;
  v_phone text := public.fn_normalize_phone(p_phone);
  v_user public.users;
  v_created boolean := false;
begin
  select * into v_sa from public.users where id = p_super_agent_id;
  if v_sa.id is null or v_sa.tier <> 'super_agent' then
    return jsonb_build_object('ok', false, 'error', 'NOT_SUPER_AGENT', 'message', 'Only Super Agents can recruit Sub-Agents.');
  end if;
  if not public.fn_is_valid_gh_phone(v_phone) then
    return jsonb_build_object('ok', false, 'error', 'INVALID_PHONE', 'message', 'Enter a valid Ghana mobile number.');
  end if;
  if v_phone = v_sa.phone then
    return jsonb_build_object('ok', false, 'error', 'SELF_RECRUIT', 'message', 'You cannot recruit yourself.');
  end if;

  select * into v_squad from public.squads where super_agent_id = p_super_agent_id;
  if v_squad.id is null then return jsonb_build_object('ok', false, 'error', 'NO_SQUAD'); end if;

  select * into v_user from public.users where phone = v_phone;
  if v_user.id is not null then
    if v_user.squad_id = v_squad.id then
      return jsonb_build_object('ok', true, 'already_member', true, 'recruited', to_jsonb(v_user) - 'pin_hash');
    end if;
    update public.users
       set squad_id = v_squad.id,
           tier = case when tier = 'customer' then 'sub_agent'::public.user_tier else tier end,
           updated_at = now()
     where id = v_user.id;
    v_created := false;
  else
    insert into public.users (phone, full_name, tier, squad_id)
    values (v_phone, nullif(trim(coalesce(p_full_name, '')), ''), 'sub_agent', v_squad.id)
    returning * into v_user;
    insert into public.wallets (user_id) values (v_user.id) on conflict do nothing;
    v_created := true;
  end if;

  perform public.fn_squad_recompute(v_squad.id);
  perform public.fn_notify(p_super_agent_id, 'Sub-Agent added',
    v_phone || ' was added to ' || v_squad.name || case when v_created then '. They activate by signing up with that number.' else '.' end,
    'success', jsonb_build_object('user_id', v_user.id));

  return jsonb_build_object('ok', true, 'already_member', false, 'created', v_created,
                            'recruited', jsonb_build_object('id', v_user.id, 'phone', v_user.phone,
                                                            'full_name', v_user.full_name, 'tier', v_user.tier));
end $$;

create or replace function public.fn_list_recruits(p_super_agent_id uuid) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'ok', true,
    'invite_code', (select invite_code from public.squads where super_agent_id = p_super_agent_id),
    'recruits', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', u.id, 'phone', u.phone, 'full_name', u.full_name, 'tier', u.tier,
        'activated', u.pin_hash is not null, 'joined_at', u.created_at
      ) order by u.created_at desc)
      from public.users u
      join public.squads s on s.id = u.squad_id
      where s.super_agent_id = p_super_agent_id
    ), '[]'::jsonb)
  );
$$;

-- ---------------------------------------------------------------------------
-- 7. WITHDRAWALS
-- ---------------------------------------------------------------------------

create or replace function public.fn_withdrawal_quote(p_user_id uuid, p_amount numeric, p_mode public.withdrawal_mode)
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_user public.users;
  v_wallet public.wallets;
  v_amount numeric(14,2) := round(coalesce(p_amount, 0)::numeric, 2);
  v_fee numeric(14,2) := 0;
  v_mode public.withdrawal_mode := coalesce(p_mode, 'instant');
begin
  select * into v_user from public.users where id = p_user_id;
  if v_user.id is null then return jsonb_build_object('ok', false, 'error', 'USER_NOT_FOUND'); end if;
  select * into v_wallet from public.wallets where user_id = p_user_id;

  -- Super Agents withdraw instantly, unlimited, free.
  if v_user.tier = 'super_agent' then
    v_fee := 0;
  elsif v_mode = 'instant' then
    v_fee := public.fn_setting_num('instant_withdrawal_fee_ghs', 1.5);
  else
    v_fee := 0;
  end if;

  return jsonb_build_object(
    'ok', true,
    'amount_ghs', v_amount,
    'fee_ghs', v_fee,
    'net_amount_ghs', greatest(v_amount - v_fee, 0),
    'mode', v_mode,
    'tier', v_user.tier,
    'free_instant', v_user.tier = 'super_agent',
    'min_withdrawal_ghs', public.fn_setting_num('min_withdrawal_ghs', 5),
    'max_instant_ghs', public.fn_setting_num('max_instant_withdrawal_ghs', 2000),
    'free_friday_payout_at', public.fn_next_free_friday(),
    'balance_ghs', coalesce(v_wallet.balance_ghs, 0),
    'commission_balance_ghs', coalesce(v_wallet.commission_balance_ghs, 0)
  );
end $$;

create or replace function public.fn_withdrawal_request(
  p_user_id uuid,
  p_amount numeric,
  p_mode public.withdrawal_mode default 'instant',
  p_payout_details jsonb default '{}'::jsonb,
  p_payout_method text default 'momo'
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_user public.users;
  v_wallet public.wallets;
  v_amount numeric(14,2) := round(coalesce(p_amount, 0)::numeric, 2);
  v_fee numeric(14,2) := 0;
  v_net numeric(14,2);
  v_wd public.withdrawals;
  v_min numeric := public.fn_setting_num('min_withdrawal_ghs', 5);
  v_max_instant numeric := public.fn_setting_num('max_instant_withdrawal_ghs', 2000);
  v_status public.withdrawal_status;
  v_scheduled timestamptz;
  v_ref text;
begin
  select * into v_user from public.users where id = p_user_id for update;
  if v_user.id is null then return jsonb_build_object('ok', false, 'error', 'USER_NOT_FOUND'); end if;
  if v_user.status <> 'active' then
    return jsonb_build_object('ok', false, 'error', 'ACCOUNT_SUSPENDED', 'message', 'This account is suspended.');
  end if;
  if v_amount < v_min then
    return jsonb_build_object('ok', false, 'error', 'AMOUNT_BELOW_MIN',
                              'message', format('Minimum withdrawal is GHS %s.', to_char(v_min, 'FM999999990.00')));
  end if;

  v_fee := case when v_user.tier = 'super_agent' then 0
                when coalesce(p_mode, 'instant') = 'instant' then public.fn_setting_num('instant_withdrawal_fee_ghs', 1.5)
                else 0 end;
  if v_fee >= v_amount then
    return jsonb_build_object('ok', false, 'error', 'AMOUNT_TOO_SMALL',
                              'message', format('Amount must be greater than the GHS %s instant payout fee.', to_char(v_fee, 'FM999999990.00')));
  end if;
  if coalesce(p_mode, 'instant') = 'instant' and v_user.tier <> 'super_agent' and v_amount > v_max_instant then
    return jsonb_build_object('ok', false, 'error', 'ABOVE_INSTANT_LIMIT',
                              'message', format('Instant withdrawals are capped at GHS %s. Use Free Friday for larger amounts.', to_char(v_max_instant, 'FM999999990.00')));
  end if;

  select * into v_wallet from public.wallets where user_id = p_user_id for update;
  if v_wallet.balance_ghs < v_amount then
    return jsonb_build_object('ok', false, 'error', 'INSUFFICIENT_FUNDS',
                              'message', format('You have GHS %s available.', to_char(v_wallet.balance_ghs, 'FM999999990.00')),
                              'balance_ghs', v_wallet.balance_ghs, 'required_ghs', v_amount);
  end if;

  v_net := v_amount - v_fee;
  v_status := case when coalesce(p_mode, 'instant') = 'free_friday_batch' then 'batched'::public.withdrawal_status
                   else 'processing'::public.withdrawal_status end;
  v_scheduled := case when coalesce(p_mode, 'instant') = 'free_friday_batch' then public.fn_next_free_friday() else now() end;
  v_ref := public.fn_random_code('WD-', 6);

  -- Debit the wallet in full (net + fee) inside this transaction.
  v_wallet := public.fn_wallet_apply(p_user_id, -v_amount, 0, 0, 0, v_amount);

  insert into public.withdrawals (
    user_id, amount_ghs, fee_ghs, net_amount_ghs, mode, status, tier_at_request,
    payout_method, payout_details, payout_reference, scheduled_for
  ) values (
    p_user_id, v_amount, v_fee, v_net, coalesce(p_mode, 'instant'), v_status, v_user.tier,
    coalesce(p_payout_method, 'momo'), coalesce(p_payout_details, '{}'::jsonb), v_ref, v_scheduled
  ) returning * into v_wd;

  -- Two ledger rows so the payout and the platform fee are separately auditable.
  perform public.fn_ledger_append(
    p_user_id, 'withdrawal', -v_net,
    format('Withdrawal %s (%s payout to %s)', v_ref, replace(coalesce(p_mode, 'instant')::text, '_', ' '), coalesce(p_payout_method, 'momo')),
    v_wallet.balance_ghs + v_fee, 0, v_wallet.commission_balance_ghs, v_ref, null, null,
    jsonb_build_object('withdrawal_id', v_wd.id, 'fee_ghs', v_fee, 'net_ghs', v_net, 'mode', p_mode)
  );

  if v_fee > 0 then
    perform public.fn_ledger_append(
      p_user_id, 'withdrawal_fee', -v_fee,
      format('Instant payout fee for %s', v_ref),
      v_wallet.balance_ghs, 0, v_wallet.commission_balance_ghs, v_ref, null, null,
      jsonb_build_object('withdrawal_id', v_wd.id)
    );
  end if;

  perform public.fn_notify(
    p_user_id,
    case when v_status = 'batched' then 'Free Friday payout scheduled' else 'Withdrawal submitted' end,
    case when v_status = 'batched'
         then format('GHS %s is queued for the Free Friday payout run (%s). No fee charged.',
                     to_char(v_net, 'FM999999990.00'), to_char(v_scheduled at time zone 'Africa/Accra', 'Dy DD Mon, HH24:MI'))
         else format('GHS %s is on its way to your %s number. Fee: GHS %s.',
                     to_char(v_net, 'FM999999990.00'), coalesce(p_payout_method, 'momo'), to_char(v_fee, 'FM999999990.00')) end,
    'info', jsonb_build_object('withdrawal_id', v_wd.id, 'amount_ghs', v_amount, 'fee_ghs', v_fee)
  );

  return jsonb_build_object('ok', true, 'withdrawal', to_jsonb(v_wd),
                            'wallet', jsonb_build_object('balance_ghs', v_wallet.balance_ghs),
                            'message', format('Withdrawal %s submitted.', v_ref));
end $$;

create or replace function public.fn_list_withdrawals(p_user_id uuid, p_limit integer default 50) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('ok', true, 'withdrawals', coalesce(jsonb_agg(to_jsonb(w) order by w.created_at desc), '[]'::jsonb))
  from (
    select * from public.withdrawals where user_id = p_user_id order by created_at desc limit least(coalesce(p_limit, 50), 200)
  ) w;
$$;

-- ---------------------------------------------------------------------------
-- 8. P2P TRANSFERS
-- ---------------------------------------------------------------------------

create or replace function public.fn_p2p_transfer(
  p_from_user_id uuid, p_recipient text, p_amount numeric, p_note text default null
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_from public.users;
  v_to public.users;
  v_amount numeric(14,2) := round(coalesce(p_amount, 0)::numeric, 2);
  v_min numeric := public.fn_setting_num('min_p2p_ghs', 1);
  v_w_from public.wallets;
  v_w_to public.wallets;
  v_ref text := public.fn_random_code('P2P-', 8);
  v_low uuid;
  v_high uuid;
begin
  select * into v_from from public.users where id = p_from_user_id;
  if v_from.id is null then return jsonb_build_object('ok', false, 'error', 'USER_NOT_FOUND'); end if;

  -- Recipient by phone (normalised) or by user id.
  if trim(coalesce(p_recipient, '')) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    select * into v_to from public.users where id = trim(p_recipient)::uuid;
  else
    select * into v_to from public.users where phone = public.fn_normalize_phone(p_recipient);
  end if;

  if v_to.id is null then
    return jsonb_build_object('ok', false, 'error', 'RECIPIENT_NOT_FOUND',
                              'message', 'No Priceless Bundle account matches that number. They must sign up first.');
  end if;
  if v_to.id = v_from.id then
    return jsonb_build_object('ok', false, 'error', 'SELF_TRANSFER', 'message', 'You cannot send money to yourself.');
  end if;
  if v_to.status <> 'active' then
    return jsonb_build_object('ok', false, 'error', 'RECIPIENT_INACTIVE', 'message', 'That account is suspended.');
  end if;
  if v_amount < v_min then
    return jsonb_build_object('ok', false, 'error', 'AMOUNT_BELOW_MIN',
                              'message', format('Minimum transfer is GHS %s.', to_char(v_min, 'FM999999990.00')));
  end if;

  -- Deterministic lock order prevents deadlocks between simultaneous transfers.
  if v_from.id < v_to.id then v_low := v_from.id; v_high := v_to.id; else v_low := v_to.id; v_high := v_from.id; end if;
  perform 1 from public.wallets where user_id = v_low for update;
  perform 1 from public.wallets where user_id = v_high for update;

  select * into v_w_from from public.wallets where user_id = v_from.id;
  if v_w_from.balance_ghs < v_amount then
    return jsonb_build_object('ok', false, 'error', 'INSUFFICIENT_FUNDS',
                              'message', format('You have GHS %s in your wallet.', to_char(v_w_from.balance_ghs, 'FM999999990.00')),
                              'balance_ghs', v_w_from.balance_ghs, 'required_ghs', v_amount);
  end if;

  v_w_from := public.fn_wallet_apply(v_from.id, -v_amount);
  v_w_to   := public.fn_wallet_apply(v_to.id,   v_amount);

  perform public.fn_ledger_append(
    v_from.id, 'p2p_send', -v_amount,
    format('Sent to %s (%s)%s', coalesce(v_to.full_name, v_to.phone), v_to.phone,
           case when nullif(trim(coalesce(p_note, '')), '') is null then '' else ' — ' || left(p_note, 120) end),
    v_w_from.balance_ghs, 0, v_w_from.commission_balance_ghs, v_ref, null, v_to.id,
    jsonb_build_object('recipient_phone', v_to.phone, 'note', p_note)
  );

  perform public.fn_ledger_append(
    v_to.id, 'p2p_receive', v_amount,
    format('Received from %s (%s)%s', coalesce(v_from.full_name, v_from.phone), v_from.phone,
           case when nullif(trim(coalesce(p_note, '')), '') is null then '' else ' — ' || left(p_note, 120) end),
    v_w_to.balance_ghs, 0, v_w_to.commission_balance_ghs, v_ref, null, v_from.id,
    jsonb_build_object('sender_phone', v_from.phone, 'note', p_note)
  );

  perform public.fn_notify(v_to.id, 'Money received',
    format('GHS %s from %s. New balance: GHS %s.', to_char(v_amount, 'FM999999990.00'),
           coalesce(v_from.full_name, v_from.phone), to_char(v_w_to.balance_ghs, 'FM999999990.00')),
    'success', jsonb_build_object('reference', v_ref, 'amount_ghs', v_amount));

  return jsonb_build_object('ok', true, 'reference', v_ref, 'amount_ghs', v_amount,
                            'recipient', jsonb_build_object('phone', v_to.phone, 'full_name', v_to.full_name),
                            'balance_ghs', v_w_from.balance_ghs,
                            'message', format('GHS %s sent to %s.', to_char(v_amount, 'FM999999990.00'), v_to.phone));
end $$;

-- ---------------------------------------------------------------------------
-- 9. COMMISSIONS + REINVESTMENT BONUS (2% -> 5%, sliding by amount)
-- ---------------------------------------------------------------------------

create or replace function public.fn_reinvest_rate(p_amount numeric) returns numeric
language plpgsql stable as $$
declare
  v_min numeric := public.fn_setting_num('reinvest_bonus_min_pct', 2) / 100.0;
  v_max numeric := public.fn_setting_num('reinvest_bonus_max_pct', 5) / 100.0;
  v_tiers jsonb := public.fn_setting('reinvest_bonus_tiers', '[{"min":0,"rate":0.02},{"min":100,"rate":0.03},{"min":500,"rate":0.04},{"min":2000,"rate":0.05}]'::jsonb);
  v_rate numeric;
begin
  select coalesce(max((t->>'rate')::numeric), v_min) into v_rate
    from jsonb_array_elements(v_tiers) t
   where (t->>'min')::numeric <= p_amount;
  v_rate := coalesce(v_rate, v_min);
  return greatest(v_min, least(v_rate, v_max));
end $$;

create or replace function public.fn_commission_summary(p_user_id uuid) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'ok', true,
    'available_ghs', coalesce((select commission_balance_ghs from public.wallets where user_id = p_user_id), 0),
    'lifetime_ghs', coalesce((select sum(amount_ghs) from public.commissions where user_id = p_user_id), 0),
    'reinvested_ghs', coalesce((select sum(consumed_ghs) from public.commissions where user_id = p_user_id), 0),
    'accrued_ghs', coalesce((select sum(amount_ghs - consumed_ghs) from public.commissions where user_id = p_user_id), 0),
    'bonus_tiers', public.fn_setting('reinvest_bonus_tiers', '[{"min":0,"rate":0.02},{"min":100,"rate":0.03},{"min":500,"rate":0.04},{"min":2000,"rate":0.05}]'::jsonb),
    'min_pct', public.fn_setting_num('reinvest_bonus_min_pct', 2),
    'max_pct', public.fn_setting_num('reinvest_bonus_max_pct', 5),
    'next_rate', public.fn_reinvest_rate(coalesce((select commission_balance_ghs from public.wallets where user_id = p_user_id), 0)),
    'recent', coalesce((select jsonb_agg(jsonb_build_object(
        'id', c.id, 'amount_ghs', c.amount_ghs, 'consumed_ghs', c.consumed_ghs, 'state', c.state,
        'description', c.description, 'created_at', c.created_at, 'order_id', c.source_order_id
      ) order by c.created_at desc)
      from (select * from public.commissions where user_id = p_user_id order by created_at desc limit 25) c), '[]'::jsonb)
  );
$$;

create or replace function public.fn_commission_reinvest(p_user_id uuid, p_amount numeric default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_wallet public.wallets;
  v_amount numeric(14,2);
  v_rate numeric;
  v_bonus numeric(14,2);
  v_remaining numeric(14,2);
  v_take numeric(14,2);
  v_row public.commissions;
begin
  perform 1 from public.wallets where user_id = p_user_id for update;
  select * into v_wallet from public.wallets where user_id = p_user_id;
  if v_wallet.user_id is null then return jsonb_build_object('ok', false, 'error', 'WALLET_NOT_FOUND'); end if;

  v_amount := round(coalesce(p_amount, v_wallet.commission_balance_ghs)::numeric, 2);
  if v_amount <= 0 then
    return jsonb_build_object('ok', false, 'error', 'NOTHING_TO_REINVEST',
                              'message', 'You have no commission available to reinvest yet.');
  end if;
  if v_amount > v_wallet.commission_balance_ghs then
    return jsonb_build_object('ok', false, 'error', 'INSUFFICIENT_COMMISSION',
                              'message', format('You have GHS %s of commission available.',
                                                to_char(v_wallet.commission_balance_ghs, 'FM999999990.00')),
                              'available_ghs', v_wallet.commission_balance_ghs);
  end if;

  v_rate := public.fn_reinvest_rate(v_amount);
  v_bonus := round(v_amount * v_rate, 2);

  -- FIFO consumption so every commission row stays traceable.
  v_remaining := v_amount;
  for v_row in
    select * from public.commissions
     where user_id = p_user_id and consumed_ghs < amount_ghs
     order by created_at asc
     for update
  loop
    exit when v_remaining <= 0;
    v_take := least(v_remaining, v_row.amount_ghs - v_row.consumed_ghs);
    update public.commissions
       set consumed_ghs = consumed_ghs + v_take,
           state = case when consumed_ghs + v_take >= amount_ghs then 'reinvested'::public.commission_state
                        else 'partly_consumed'::public.commission_state end,
           updated_at = now()
     where id = v_row.id;
    v_remaining := v_remaining - v_take;
  end loop;

  v_wallet := public.fn_wallet_apply(p_user_id, v_amount + v_bonus, -v_amount);

  perform public.fn_ledger_append(
    p_user_id, 'commission_reinvest', v_amount,
    format('Commission reinvested into main wallet (GHS %s)', to_char(v_amount, 'FM999999990.00')),
    v_wallet.balance_ghs - v_bonus, -v_amount, v_wallet.commission_balance_ghs,
    public.fn_random_code('REI-', 6), null, null,
    jsonb_build_object('rate', v_rate, 'bonus_ghs', v_bonus)
  );

  perform public.fn_ledger_append(
    p_user_id, 'reinvest_bonus', v_bonus,
    format('Reinvestment bonus (%s%% of GHS %s)', to_char(v_rate * 100, 'FM990.0'), to_char(v_amount, 'FM999999990.00')),
    v_wallet.balance_ghs, 0, v_wallet.commission_balance_ghs,
    public.fn_random_code('BON-', 6), null, null,
    jsonb_build_object('rate', v_rate, 'reinvested_ghs', v_amount)
  );

  perform public.fn_notify(
    p_user_id, 'Commission reinvested',
    format('GHS %s moved into your wallet with a GHS %s bonus (%s%%). New balance: GHS %s.',
           to_char(v_amount, 'FM999999990.00'), to_char(v_bonus, 'FM999999990.00'),
           to_char(v_rate * 100, 'FM990.0'), to_char(v_wallet.balance_ghs, 'FM999999990.00')),
    'success', jsonb_build_object('amount_ghs', v_amount, 'bonus_ghs', v_bonus, 'rate', v_rate)
  );

  return jsonb_build_object('ok', true, 'reinvested_ghs', v_amount, 'bonus_ghs', v_bonus,
                            'bonus_rate', v_rate, 'balance_ghs', v_wallet.balance_ghs,
                            'commission_balance_ghs', v_wallet.commission_balance_ghs,
                            'message', format('Reinvested GHS %s and earned a GHS %s bonus.',
                                              to_char(v_amount, 'FM999999990.00'), to_char(v_bonus, 'FM999999990.00')));
end $$;

-- ---------------------------------------------------------------------------
-- 10. BOT-IN-A-BOX — Super Agents link their own Telegram bot / WhatsApp API
-- ---------------------------------------------------------------------------

create or replace function public.fn_set_bot_config(
  p_user_id uuid,
  p_channel public.bot_channel,
  p_token text default null,
  p_endpoint text default null,
  p_phone_number_id text default null,
  p_verify_token text default null,
  p_enabled boolean default true
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_user public.users; v_conflict uuid;
begin
  select * into v_user from public.users where id = p_user_id for update;
  if v_user.id is null then return jsonb_build_object('ok', false, 'error', 'USER_NOT_FOUND'); end if;
  if v_user.tier <> 'super_agent' then
    return jsonb_build_object('ok', false, 'error', 'NOT_SUPER_AGENT',
                              'message', 'Bot-in-a-Box is available on the Super Agent plan.');
  end if;

  if p_channel = 'telegram' then
    if nullif(trim(coalesce(p_token, '')), '') is null then
      -- Disabling / clearing.
      update public.users set telegram_bot_token = null, bot_enabled = false, updated_at = now() where id = p_user_id;
      return jsonb_build_object('ok', true, 'linked', false, 'channel', 'telegram');
    end if;
    if p_token !~ '^[0-9]{6,}:[A-Za-z0-9_-]{30,}$' then
      return jsonb_build_object('ok', false, 'error', 'INVALID_TOKEN',
                                'message', 'That does not look like a Telegram bot token (expected 123456:ABC-DEF...).');
    end if;
    select id into v_conflict from public.users where telegram_bot_token = p_token and id <> p_user_id;
    if v_conflict is not null then
      return jsonb_build_object('ok', false, 'error', 'TOKEN_IN_USE', 'message', 'That bot token is already linked to another account.');
    end if;
    update public.users
       set telegram_bot_token = p_token, bot_enabled = coalesce(p_enabled, true), updated_at = now()
     where id = p_user_id;
  elsif p_channel = 'whatsapp' then
    if nullif(trim(coalesce(p_endpoint, '')), '') is null then
      update public.users set whatsapp_business_endpoint = null, bot_enabled = false, updated_at = now() where id = p_user_id;
      return jsonb_build_object('ok', true, 'linked', false, 'channel', 'whatsapp');
    end if;
    if p_endpoint !~* '^https?://' then
      return jsonb_build_object('ok', false, 'error', 'INVALID_ENDPOINT', 'message', 'The WhatsApp endpoint must be a full https:// URL.');
    end if;
    if nullif(trim(coalesce(p_phone_number_id, '')), '') is not null then
      select id into v_conflict from public.users where whatsapp_phone_number_id = trim(p_phone_number_id) and id <> p_user_id;
      if v_conflict is not null then
        return jsonb_build_object('ok', false, 'error', 'PHONE_NUMBER_ID_IN_USE', 'message', 'That WhatsApp phone number ID is already linked.');
      end if;
    end if;
    update public.users
       set whatsapp_business_endpoint = trim(p_endpoint),
           whatsapp_phone_number_id = nullif(trim(coalesce(p_phone_number_id, '')), ''),
           whatsapp_verify_token = coalesce(nullif(trim(coalesce(p_verify_token, '')), ''), whatsapp_verify_token),
           bot_enabled = coalesce(p_enabled, true),
           updated_at = now()
     where id = p_user_id;
  else
    return jsonb_build_object('ok', false, 'error', 'UNSUPPORTED_CHANNEL');
  end if;

  perform public.fn_notify(p_user_id, 'Bot linked',
    format('Your %s bot is now connected to Priceless Bundle. It sells at your wholesale tier and counts toward your Squad volume.', p_channel),
    'success');

  return jsonb_build_object('ok', true, 'linked', true, 'channel', p_channel, 'user', public.fn_user_public(p_user_id));
end $$;

-- Resolve which Super Agent owns an inbound bot message.
create or replace function public.fn_resolve_bot_owner(p_channel public.bot_channel, p_token text, p_phone_number_id text default null)
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_user public.users;
begin
  if p_channel = 'telegram' then
    select * into v_user from public.users where telegram_bot_token = p_token and bot_enabled;
  elsif p_channel = 'whatsapp' then
    select * into v_user
      from public.users
     where bot_enabled
       and (whatsapp_phone_number_id = p_phone_number_id
            or (p_phone_number_id is null and whatsapp_business_endpoint is not null and whatsapp_business_endpoint = p_token));
  else
    return jsonb_build_object('ok', false, 'error', 'UNSUPPORTED_CHANNEL');
  end if;

  if v_user.id is null then return jsonb_build_object('ok', false, 'error', 'BOT_NOT_LINKED'); end if;
  return jsonb_build_object('ok', true, 'user_id', v_user.id, 'tier', v_user.tier,
                            'name', coalesce(v_user.full_name, v_user.phone), 'phone', v_user.phone);
end $$;

-- Execute a chat command. Returns a reply string plus, for a vend, the created
-- order so the route can hit the supplier and finalise it.
create or replace function public.fn_bot_command(
  p_super_agent_id uuid,
  p_channel public.bot_channel,
  p_text text,
  p_external_user_ref text default null
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_user public.users;
  v_wallet public.wallets;
  v_cmd text;
  v_args text[];
  v_network text;
  v_size text;
  v_phone text;
  v_plan public.plans;
  v_purchase jsonb;
  v_plans jsonb;
  v_lines text := '';
  v_row jsonb;
  v_balance text;
begin
  select * into v_user from public.users where id = p_super_agent_id;
  if v_user.id is null then return jsonb_build_object('ok', false, 'error', 'USER_NOT_FOUND'); end if;
  if v_user.tier <> 'super_agent' then
    return jsonb_build_object('ok', false, 'error', 'NOT_SUPER_AGENT',
      'reply', 'Bot-in-a-Box is a Super Agent feature. Upgrade to VIP wholesale pricing to link your own bot.');
  end if;

  select * into v_wallet from public.wallets where user_id = p_super_agent_id;
  v_balance := to_char(coalesce(v_wallet.balance_ghs, 0), 'FM999999990.00');

  v_cmd := lower(trim(coalesce(p_text, '')));
  v_cmd := regexp_replace(v_cmd, '^/[a-z]+(@[a-z0-9_]+)?\s*', '', 'i');   -- strip /start@mybot
  v_cmd := trim(regexp_replace(v_cmd, '\s+', ' ', 'g'));

  -- help / greeting
  if v_cmd = '' or v_cmd in ('help', 'start', 'menu', 'hi', 'hello') then
    return jsonb_build_object('ok', true, 'action', 'help', 'reply', format(
      E'Priceless Bundle — %s\n\n' ||
      E'balance                  check your wallet\n' ||
      E'prices                   today''s wholesale price list\n' ||
      E'buy <network> <size> <phone>\n' ||
      E'     e.g. buy mtn 5gb 0244123456\n' ||
      E'orders                   your last 5 orders\n\n' ||
      'Wallet: GHS %s', coalesce(v_user.full_name, 'Agent'), v_balance));
  end if;

  if v_cmd in ('balance', 'wallet', 'bal', 'my balance') then
    return jsonb_build_object('ok', true, 'action', 'balance', 'reply', format(
      E'Priceless Bundle wallet\nBalance: GHS %s\nCommission: GHS %s\n\nTop up in your dashboard to keep selling.',
      v_balance, to_char(coalesce(v_wallet.commission_balance_ghs, 0), 'FM999999990.00')));
  end if;

  if v_cmd in ('prices', 'price', 'plans', 'list', 'price list') then
    v_plans := (public.fn_list_plans(p_super_agent_id) -> 'plans');
    for v_row in select * from jsonb_array_elements(v_plans) loop
      v_lines := v_lines || format(E'\n%-10s %-8s GHS %s',
        v_row->>'network', v_row->>'size_label', to_char((v_row->>'price_ghs')::numeric, 'FM999999990.00'));
    end loop;
    return jsonb_build_object('ok', true, 'action', 'prices', 'plans', v_plans,
      'reply', format(E'Priceless Bundle wholesale prices%s\n\nBuy with: buy <network> <size> <phone>', v_lines));
  end if;

  if v_cmd in ('orders', 'my orders', 'history') then
    v_lines := '';
    for v_row in
      select to_jsonb(o) from public.orders o
       where o.buyer_id = p_super_agent_id order by o.created_at desc limit 5
    loop
      v_lines := v_lines || format(E'\n%s %s -> %s [%s]',
        v_row->>'network', v_row->>'size_label', v_row->>'recipient_phone', v_row->>'status');
    end loop;
    if v_lines = '' then v_lines := E'\nNo orders yet.'; end if;
    return jsonb_build_object('ok', true, 'action', 'orders', 'reply', 'Your last 5 orders:' || v_lines);
  end if;

  -- buy / vend
  v_args := string_to_array(v_cmd, ' ');
  if v_args[1] in ('buy', 'vend', 'sell', 'send') or (array_length(v_args, 1) >= 3 and v_args[1] in ('mtn', 'telecel', 'airteltigo', 'at', 'airtel', 'tigo')) then
    if v_args[1] in ('buy', 'vend', 'sell', 'send') then
      v_network := v_args[2]; v_size := v_args[3]; v_phone := v_args[4];
    else
      v_network := v_args[1]; v_size := v_args[2]; v_phone := v_args[3];
    end if;

    v_network := case lower(coalesce(v_network, ''))
                   when 'mtn' then 'MTN'
                   when 'telecel' then 'Telecel' when 'vodafone' then 'Telecel'
                   when 'airteltigo' then 'AirtelTigo' when 'at' then 'AirtelTigo'
                   when 'airtel' then 'AirtelTigo' when 'tigo' then 'AirtelTigo'
                   else null end;
    if v_network is null then
      return jsonb_build_object('ok', true, 'action', 'error',
        'reply', 'Unknown network. Use mtn, telecel or airteltigo. Example: buy mtn 5gb 0244123456');
    end if;

    v_phone := public.fn_normalize_phone(v_phone);
    if not public.fn_is_valid_gh_phone(v_phone) then
      return jsonb_build_object('ok', true, 'action', 'error',
        'reply', 'That phone number looks wrong. Example: buy mtn 5gb 0244123456');
    end if;

    -- Accept 5gb / 5 gb / 500mb / just "5"
    v_size := lower(regexp_replace(coalesce(v_size, ''), '\s', '', 'g'));
    select * into v_plan from public.plans
     where active
       and network = v_network
       and (lower(replace(size_label, ' ', '')) = v_size
            or (v_size ~ '^[0-9]+$' and data_mb = v_size::int * 1024)
            or lower(replace(size_label, ' ', '')) = v_size || 'gb'
            or lower(replace(size_label, ' ', '')) = v_size || 'mb')
     order by sort_order limit 1;

    if v_plan.id is null then
      return jsonb_build_object('ok', true, 'action', 'error',
        'reply', format('No %s bundle matches "%s". Send "prices" to see the full list.', v_network, v_size));
    end if;

    v_purchase := public.fn_purchase_data(
      p_user_id => p_super_agent_id,
      p_plan_id => v_plan.id,
      p_recipient_phone => v_phone,
      p_channel => p_channel,
      p_end_customer_phone => v_phone,
      p_external_user_ref => p_external_user_ref,
      p_raw_command => left(p_text, 500)
    );

    if not (v_purchase->>'ok')::boolean then
      return jsonb_build_object('ok', true, 'action', 'error', 'error_code', v_purchase->>'error',
        'reply', coalesce(v_purchase->>'message', 'That purchase could not be completed.'));
    end if;

    return jsonb_build_object('ok', true, 'action', 'vend', 'purchase', v_purchase,
      'pending_reply', format('Vending %s %s to %s for GHS %s...',
        v_plan.network, v_plan.size_label, v_phone,
        to_char((v_purchase->'order'->>'price_charged_ghs')::numeric, 'FM999999990.00')));
  end if;

  return jsonb_build_object('ok', true, 'action', 'unknown',
    'reply', 'I did not understand that. Send "help" for the command list.');
end $$;

-- ---------------------------------------------------------------------------
-- 11. CUSTOMER-FACING READS: wallet, ledger, orders
-- ---------------------------------------------------------------------------

create or replace function public.fn_wallet_summary(p_user_id uuid) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'ok', true,
    'wallet', jsonb_build_object(
      'balance_ghs', coalesce(w.balance_ghs, 0),
      'commission_balance_ghs', coalesce(w.commission_balance_ghs, 0),
      'total_deposited_ghs', coalesce(w.total_deposited_ghs, 0),
      'total_spent_ghs', coalesce(w.total_spent_ghs, 0),
      'total_withdrawn_ghs', coalesce(w.total_withdrawn_ghs, 0),
      'currency', coalesce(w.currency, 'GHS')
    ),
    'tier', u.tier,
    'this_month', jsonb_build_object(
      'deposits_ghs', coalesce((select sum(amount_ghs) from public.wallet_ledger l
                                 where l.user_id = p_user_id and l.entry_type = 'deposit'
                                   and l.created_at >= public.fn_period_start()), 0),
      'spent_ghs', coalesce((select -sum(amount_ghs) from public.wallet_ledger l
                              where l.user_id = p_user_id and l.entry_type = 'purchase'
                                and l.created_at >= public.fn_period_start()), 0),
      'orders', coalesce((select count(*) from public.orders o
                           where o.buyer_id = p_user_id and o.created_at >= public.fn_period_start()), 0)
    ),
    'lifetime', jsonb_build_object(
      'deposits_ghs', coalesce(w.total_deposited_ghs, 0),
      'orders', coalesce((select count(*) from public.orders o where o.buyer_id = p_user_id), 0)
    ),
    'active_intents', coalesce((
      select jsonb_agg(to_jsonb(di) order by di.created_at desc)
      from public.deposit_intents di
      where di.user_id = p_user_id and di.status = 'pending_match' and di.expires_at > now()
    ), '[]'::jsonb)
  )
  from public.users u
  left join public.wallets w on w.user_id = u.id
  where u.id = p_user_id;
$$;

create or replace function public.fn_ledger_list(
  p_user_id uuid, p_limit integer default 50, p_offset integer default 0, p_type public.ledger_entry_type default null
) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'ok', true,
    'entries', coalesce(jsonb_agg(to_jsonb(l) order by l.created_at desc), '[]'::jsonb),
    'count', count(*)
  )
  from (
    select * from public.wallet_ledger
     where user_id = p_user_id
       and (p_type is null or entry_type = p_type)
     order by created_at desc
     limit least(coalesce(p_limit, 50), 200) offset greatest(coalesce(p_offset, 0), 0)
  ) l;
$$;

create or replace function public.fn_order_public(p_order uuid) returns jsonb
language sql stable as $$
  select jsonb_build_object(
    'id', o.id, 'status', o.status, 'network', o.network, 'size_label', o.size_label,
    'data_mb', o.data_mb, 'recipient_phone', o.recipient_phone,
    'price_charged_ghs', o.price_charged_ghs, 'buyer_tier_at_purchase', o.buyer_tier_at_purchase,
    'channel', o.channel, 'supplier_reference', o.supplier_reference,
    'failure_reason', o.failure_reason, 'created_at', o.created_at, 'fulfilled_at', o.fulfilled_at
  ) from public.orders o where o.id = p_order;
$$;

create or replace function public.fn_list_orders(p_user_id uuid, p_limit integer default 50, p_offset integer default 0, p_status public.order_status default null)
returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'ok', true,
    'orders', coalesce(jsonb_agg(public.fn_order_public(o.id) order by o.created_at desc), '[]'::jsonb),
    'count', count(*)
  )
  from (
    select * from public.orders
     where buyer_id = p_user_id and (p_status is null or status = p_status)
     order by created_at desc
     limit least(coalesce(p_limit, 50), 200) offset greatest(coalesce(p_offset, 0), 0)
  ) o;
$$;

create or replace function public.fn_notifications_list(p_user_id uuid, p_limit integer default 30) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'ok', true,
    'notifications', coalesce(jsonb_agg(to_jsonb(n) order by n.created_at desc), '[]'::jsonb),
    'unread', (select count(*) from public.notifications x where x.user_id = p_user_id and x.read_at is null)
  )
  from (
    select * from public.notifications where user_id = p_user_id order by created_at desc limit least(coalesce(p_limit, 30), 100)
  ) n;
$$;

create or replace function public.fn_notifications_mark_read(p_user_id uuid, p_id bigint default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update public.notifications set read_at = now()
   where user_id = p_user_id and read_at is null and (p_id is null or id = p_id);
  return jsonb_build_object('ok', true);
end $$;

-- Recent system-wide activity on the landing page (privacy-safe aggregate only).
create or replace function public.fn_public_stats() returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'ok', true,
    'plans', (select count(*) from public.plans where active),
    'networks', (select count(distinct network) from public.plans where active),
    'orders_delivered', (select count(*) from public.orders where status = 'delivered'),
    'gb_delivered', coalesce((select round(sum(data_mb) / 1024.0, 0) from public.orders where status = 'delivered'), 0),
    'agents', (select count(*) from public.users where tier in ('sub_agent', 'super_agent')),
    'squads', (select count(*) from public.squads)
  );
$$;

-- ---------------------------------------------------------------------------
-- 12. ADMIN PANEL (server-side only — every entry here is called from a
--     session-guarded API route, and every mutation is audited)
-- ---------------------------------------------------------------------------

create or replace function public.fn_admin_audit(p_actor text, p_action text, p_target_type text default null, p_target_id text default null, p_payload jsonb default '{}'::jsonb)
returns bigint
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id bigint;
begin
  insert into public.admin_actions (actor, action, target_type, target_id, payload)
  values (p_actor, p_action, p_target_type, p_target_id, coalesce(p_payload, '{}'::jsonb))
  returning id into v_id;
  return v_id;
end $$;

create or replace function public.fn_admin_metrics() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_month timestamptz := public.fn_period_start();
  v_today timestamptz := (now() at time zone 'Africa/Accra')::date::timestamp at time zone 'Africa/Accra';
  v jsonb;
begin
  select jsonb_build_object(
    'ok', true,
    'generated_at', now(),
    'timezone', 'Africa/Accra',
    'revenue', jsonb_build_object(
      'gross_all_time_ghs',  coalesce((select sum(price_charged_ghs) from public.orders where status = 'delivered'), 0),
      'gross_month_ghs',     coalesce((select sum(price_charged_ghs) from public.orders where status = 'delivered' and created_at >= v_month), 0),
      'gross_today_ghs',     coalesce((select sum(price_charged_ghs) from public.orders where status = 'delivered' and created_at >= v_today), 0),
      'cost_all_time_ghs',   coalesce((select sum(cost_price_ghs) from public.orders where status = 'delivered'), 0),
      'margin_all_time_ghs', coalesce((select sum(price_charged_ghs - cost_price_ghs) from public.orders where status = 'delivered'), 0),
      'margin_month_ghs',    coalesce((select sum(price_charged_ghs - cost_price_ghs) from public.orders where status = 'delivered' and created_at >= v_month), 0),
      'margin_today_ghs',    coalesce((select sum(price_charged_ghs - cost_price_ghs) from public.orders where status = 'delivered' and created_at >= v_today), 0),
      'commission_paid_ghs', coalesce((select sum(amount_ghs) from public.commissions), 0),
      'reinvest_bonus_ghs',  coalesce((select sum(amount_ghs) from public.wallet_ledger where entry_type = 'reinvest_bonus'), 0),
      'withdrawal_fees_ghs', coalesce((select -sum(amount_ghs) from public.wallet_ledger where entry_type = 'withdrawal_fee'), 0),
      'avg_order_ghs',       coalesce((select round(avg(price_charged_ghs), 2) from public.orders where status = 'delivered'), 0)
    ),
    'orders', jsonb_build_object(
      'total', (select count(*) from public.orders),
      'today', (select count(*) from public.orders where created_at >= v_today),
      'month', (select count(*) from public.orders where created_at >= v_month),
      'pending', (select count(*) from public.orders where status = 'pending'),
      'processing', (select count(*) from public.orders where status = 'processing'),
      'delivered', (select count(*) from public.orders where status = 'delivered'),
      'failed', (select count(*) from public.orders where status = 'failed'),
      'refunded', (select count(*) from public.orders where status = 'refunded'),
      'refunded_value_ghs', coalesce((select sum(price_charged_ghs) from public.orders where status = 'refunded'), 0),
      'success_rate_pct', coalesce(round(
        (select count(*) from public.orders where status = 'delivered')::numeric
        / nullif((select count(*) from public.orders where status in ('delivered','failed','refunded')), 0) * 100, 1), 100)
    ),
    'deposits', jsonb_build_object(
      'credited_today_ghs', coalesce((select sum(amount_ghs) from public.deposits where status = 'credited' and created_at >= v_today), 0),
      'credited_month_ghs', coalesce((select sum(amount_ghs) from public.deposits where status = 'credited' and created_at >= v_month), 0),
      'credited_all_time_ghs', coalesce((select sum(amount_ghs) from public.deposits where status = 'credited'), 0),
      'unmatched_count', (select count(*) from public.deposits where status = 'unmatched_review'),
      'unmatched_value_ghs', coalesce((select sum(amount_ghs) from public.deposits where status = 'unmatched_review'), 0),
      'matched_by_reference', (select count(*) from public.deposits where status = 'credited' and match_strategy = 'reference'),
      'matched_by_sender', (select count(*) from public.deposits where status = 'credited' and match_strategy = 'sender_phone'),
      'matched_by_amount', (select count(*) from public.deposits where status = 'credited' and match_strategy = 'amount_window'),
      'pending_intents', (select count(*) from public.deposit_intents where status = 'pending_match' and expires_at > now())
    ),
    'wallets', jsonb_build_object(
      'total_balance_ghs', coalesce((select sum(balance_ghs) from public.wallets), 0),
      'commission_pot_ghs', coalesce((select sum(commission_balance_ghs) from public.wallets), 0),
      'lifetime_deposited_ghs', coalesce((select sum(total_deposited_ghs) from public.wallets), 0),
      'lifetime_spent_ghs', coalesce((select sum(total_spent_ghs) from public.wallets), 0),
      'lifetime_withdrawn_ghs', coalesce((select sum(total_withdrawn_ghs) from public.wallets), 0)
    ),
    'users', jsonb_build_object(
      'total', (select count(*) from public.users),
      'customers', (select count(*) from public.users where tier = 'customer'),
      'sub_agents', (select count(*) from public.users where tier = 'sub_agent'),
      'super_agents', (select count(*) from public.users where tier = 'super_agent'),
      'new_today', (select count(*) from public.users where created_at >= v_today),
      'new_month', (select count(*) from public.users where created_at >= v_month),
      'with_bots', (select count(*) from public.users where bot_enabled)
    ),
    'squads', jsonb_build_object(
      'count', (select count(*) from public.squads),
      'volume_this_period_ghs', coalesce((select sum(current_volume_ghs) from public.squads), 0),
      'targets_met', (select count(*) from public.squads where current_volume_ghs >= volume_target_ghs),
      'targets_missed', (select count(*) from public.squads where current_volume_ghs < volume_target_ghs)
    ),
    'withdrawals', jsonb_build_object(
      'pending_count', (select count(*) from public.withdrawals where status in ('pending','processing')),
      'pending_value_ghs', coalesce((select sum(net_amount_ghs) from public.withdrawals where status in ('pending','processing')), 0),
      'batched_count', (select count(*) from public.withdrawals where status = 'batched'),
      'batched_value_ghs', coalesce((select sum(net_amount_ghs) from public.withdrawals where status = 'batched'), 0),
      'paid_month_ghs', coalesce((select sum(amount_ghs) from public.withdrawals where status = 'paid' and created_at >= v_month), 0),
      'fees_month_ghs', coalesce((select sum(fee_ghs) from public.withdrawals where created_at >= v_month), 0)
    ),
    'networks', coalesce((
      select jsonb_agg(jsonb_build_object(
        'network', t.network, 'orders', t.cnt, 'gross_ghs', t.gross, 'margin_ghs', t.margin
      ) order by t.gross desc)
      from (
        select network, count(*) as cnt, sum(price_charged_ghs) as gross,
               sum(price_charged_ghs - cost_price_ghs) as margin
          from public.orders group by network
      ) t
    ), '[]'::jsonb),
    'daily', coalesce((
      select jsonb_agg(jsonb_build_object('day', d.day, 'orders', d.cnt, 'gross_ghs', d.gross,
                                          'margin_ghs', d.margin, 'deposits_ghs', d.deposits) order by d.day)
      from (
        select gs.day::date as day,
               coalesce((select count(*) from public.orders o
                          where (o.created_at at time zone 'Africa/Accra')::date = gs.day::date), 0) as cnt,
               coalesce((select sum(price_charged_ghs) from public.orders o
                          where o.status = 'delivered' and (o.created_at at time zone 'Africa/Accra')::date = gs.day::date), 0) as gross,
               coalesce((select sum(price_charged_ghs - cost_price_ghs) from public.orders o
                          where o.status = 'delivered' and (o.created_at at time zone 'Africa/Accra')::date = gs.day::date), 0) as margin,
               coalesce((select sum(amount_ghs) from public.deposits d
                          where d.status = 'credited' and (d.created_at at time zone 'Africa/Accra')::date = gs.day::date), 0) as deposits
          from generate_series((now() at time zone 'Africa/Accra')::date - 13, (now() at time zone 'Africa/Accra')::date, '1 day') gs(day)
      ) d
    ), '[]'::jsonb),
    'recent_activity', coalesce((
      select jsonb_agg(jsonb_build_object('action', a.action, 'actor', a.actor, 'target_type', a.target_type,
                                          'target_id', a.target_id, 'created_at', a.created_at, 'payload', a.payload)
                        order by a.created_at desc)
      from (select * from public.admin_actions order by created_at desc limit 10) a
    ), '[]'::jsonb)
  ) into v;
  return v;
end $$;

create or replace function public.fn_admin_orders(
  p_status text default null, p_search text default null, p_limit integer default 50, p_offset integer default 0
) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'ok', true,
    'orders', coalesce(jsonb_agg(row order by created_at desc), '[]'::jsonb),
    'count', count(*)
  )
  from (
    select jsonb_build_object(
      'id', o.id, 'status', o.status, 'network', o.network, 'size_label', o.size_label,
      'data_mb', o.data_mb, 'recipient_phone', o.recipient_phone,
      'price_charged_ghs', o.price_charged_ghs, 'cost_price_ghs', o.cost_price_ghs,
      'margin_ghs', o.price_charged_ghs - o.cost_price_ghs,
      'buyer_tier_at_purchase', o.buyer_tier_at_purchase, 'channel', o.channel,
      'supplier_reference', o.supplier_reference, 'failure_reason', o.failure_reason,
      'created_at', o.created_at, 'fulfilled_at', o.fulfilled_at,
      'buyer', jsonb_build_object('id', u.id, 'phone', u.phone, 'name', u.full_name, 'tier', u.tier),
      'agent', case when sa.id is null then null else jsonb_build_object('id', sa.id, 'phone', sa.phone, 'name', sa.full_name) end
    ) as row,
    o.created_at
    from public.orders o
    join public.users u on u.id = o.buyer_id
    left join public.users sa on sa.id = o.attributed_super_agent_id
    where (p_status is null or p_status = '' or o.status::text = p_status)
      and (p_search is null or p_search = '' or
           o.recipient_phone like '%' || p_search || '%' or
           u.phone like '%' || p_search || '%' or
           coalesce(o.supplier_reference, '') ilike '%' || p_search || '%' or
           o.id::text = p_search)
    order by o.created_at desc
    limit least(coalesce(p_limit, 50), 500) offset greatest(coalesce(p_offset, 0), 0)
  ) t;
$$;

create or replace function public.fn_admin_deposits(p_status text default null, p_limit integer default 50, p_offset integer default 0)
returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'ok', true,
    'deposits', coalesce(jsonb_agg(row order by created_at desc), '[]'::jsonb),
    'count', count(*)
  )
  from (
    select jsonb_build_object(
      'id', d.id, 'status', d.status, 'amount_ghs', d.amount_ghs, 'sender_phone', d.sender_phone,
      'provider', d.provider, 'reference_code', d.reference_code, 'match_strategy', d.match_strategy,
      'match_confidence', d.match_confidence, 'hold_reason', d.hold_reason,
      'raw_message', d.raw_message, 'created_at', d.created_at,
      'resolved_by', d.resolved_by, 'resolved_at', d.resolved_at, 'resolution_note', d.resolution_note,
      'user', case when u.id is null then null else jsonb_build_object('id', u.id, 'phone', u.phone, 'name', u.full_name) end,
      'intent', case when di.id is null then null else jsonb_build_object(
        'id', di.id, 'reference_code', di.reference_code, 'expected_amount_ghs', di.expected_amount_ghs,
        'status', di.status, 'created_at', di.created_at) end
    ) as row,
    d.created_at
    from public.deposits d
    left join public.users u on u.id = d.user_id
    left join public.deposit_intents di on di.id = d.deposit_intent_id
    where (p_status is null or p_status = '' or d.status::text = p_status)
    order by d.created_at desc
    limit least(coalesce(p_limit, 50), 500) offset greatest(coalesce(p_offset, 0), 0)
  ) t;
$$;

-- Unmatched deposits + ranked candidate intents for one-click resolution.
create or replace function public.fn_admin_unmatched_deposits(p_limit integer default 50) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('ok', true, 'deposits', coalesce(jsonb_agg(row order by created_at desc), '[]'::jsonb), 'count', count(*))
  from (
    select jsonb_build_object(
      'id', d.id, 'amount_ghs', d.amount_ghs, 'sender_phone', d.sender_phone,
      'provider', d.provider, 'reference_code', d.reference_code, 'hold_reason', d.hold_reason,
      'raw_message', left(d.raw_message, 400), 'created_at', d.created_at,
      'match_confidence', d.match_confidence, 'match_strategy', d.match_strategy,
      'metadata', d.metadata,
      -- Which account the SMS was attributed to, if any. Holds such as
      -- DEBIT_MESSAGE / DIRECTION_UNVERIFIED are parked against a user so the
      -- operator can see immediately whose number was involved.
      'user_id', d.user_id,
      'user', case when mu.id is null then null
                   else jsonb_build_object('id', mu.id, 'phone', mu.phone, 'name', mu.full_name) end,
      'deposit_intent_id', d.deposit_intent_id,
      'candidates', coalesce((
        select jsonb_agg(jsonb_build_object(
          'intent_id', c.id, 'user_id', c.user_id, 'phone', c.phone, 'name', c.name,
          'reference_code', c.reference_code, 'expected_amount_ghs', c.expected_amount_ghs,
          'created_at', c.created_at, 'age_minutes', round(extract(epoch from (now() - c.created_at)) / 60),
          'score', c.score
        ) order by c.score desc)
        from (
          select di.id, di.user_id, u.phone, u.full_name as name, di.reference_code,
                 di.expected_amount_ghs, di.created_at,
                 (case when public.fn_normalize_phone(d.sender_phone) = u.phone then 50 else 0 end
                  + case when di.expected_amount_ghs = d.amount_ghs then 30 else 0 end
                  + greatest(0, 20 - extract(epoch from (now() - di.created_at)) / 3600))::numeric as score
            from public.deposit_intents di
            join public.users u on u.id = di.user_id
           where di.status = 'pending_match'
             and (di.expected_amount_ghs = d.amount_ghs or public.fn_normalize_phone(d.sender_phone) = u.phone)
           order by score desc
           limit 5
        ) c
      ), '[]'::jsonb),
      'all_users', coalesce((
        select jsonb_agg(jsonb_build_object('id', su.id, 'phone', su.phone, 'name', su.full_name) order by su.phone)
        from (select * from public.users where status = 'active' order by created_at desc limit 200) su
      ), '[]'::jsonb)
    ) as row,
    d.created_at
    from public.deposits d
    left join public.users mu on mu.id = d.user_id
    where d.status = 'unmatched_review'
    order by d.created_at desc
    limit least(coalesce(p_limit, 50), 200)
  ) t;
$$;

create or replace function public.fn_admin_resolve_deposit(
  p_deposit_id uuid,
  p_user_id uuid,
  p_action text,                       -- 'credit' | 'reject'
  p_note text default null,
  p_actor text default 'admin',
  p_amount_override numeric default null
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_dep public.deposits;
  v_user public.users;
  v_wallet public.wallets;
  v_ledger_id bigint;
  v_amount numeric(14,2);
begin
  select * into v_dep from public.deposits where id = p_deposit_id for update;
  if v_dep.id is null then return jsonb_build_object('ok', false, 'error', 'DEPOSIT_NOT_FOUND'); end if;
  if v_dep.status in ('credited', 'rejected') then
    return jsonb_build_object('ok', false, 'error', 'ALREADY_RESOLVED', 'status', v_dep.status,
                              'message', 'That deposit was already resolved.');
  end if;

  if p_action = 'reject' then
    update public.deposits
       set status = 'rejected', resolved_by = p_actor, resolved_at = now(), resolution_note = p_note
     where id = p_deposit_id;
    perform public.fn_admin_audit(p_actor, 'deposit.reject', 'deposit', p_deposit_id::text,
                                  jsonb_build_object('note', p_note, 'amount_ghs', v_dep.amount_ghs));
    return jsonb_build_object('ok', true, 'status', 'rejected', 'deposit_id', p_deposit_id);
  end if;

  if p_action <> 'credit' then
    return jsonb_build_object('ok', false, 'error', 'INVALID_ACTION');
  end if;
  if p_user_id is null then
    return jsonb_build_object('ok', false, 'error', 'USER_REQUIRED', 'message', 'Choose the account to credit.');
  end if;

  select * into v_user from public.users where id = p_user_id;
  if v_user.id is null then return jsonb_build_object('ok', false, 'error', 'USER_NOT_FOUND'); end if;

  v_amount := round(coalesce(p_amount_override, v_dep.amount_ghs)::numeric, 2);
  if v_amount <= 0 then
    return jsonb_build_object('ok', false, 'error', 'INVALID_AMOUNT', 'message', 'Enter the amount to credit.');
  end if;

  perform 1 from public.wallets where user_id = p_user_id for update;
  v_wallet := public.fn_wallet_apply(p_user_id, v_amount, 0, v_amount);

  v_ledger_id := public.fn_ledger_append(
    p_user_id, 'deposit', v_amount,
    format('Manual deposit credit resolved by %s%s', p_actor,
           case when nullif(trim(coalesce(p_note, '')), '') is null then '' else ' — ' || left(p_note, 160) end),
    v_wallet.balance_ghs, 0, v_wallet.commission_balance_ghs,
    coalesce(v_dep.reference_code, 'MAN-' || substr(replace(p_deposit_id::text, '-', ''), 1, 8)),
    null, null,
    jsonb_build_object('deposit_id', p_deposit_id, 'sms_hash', v_dep.sms_hash, 'actor', p_actor,
                       'original_amount_ghs', v_dep.amount_ghs)
  );

  update public.deposits
     set status = 'credited', user_id = p_user_id, amount_ghs = v_amount,
         credited_ledger_id = v_ledger_id, resolved_by = p_actor, resolved_at = now(),
         resolution_note = p_note
   where id = p_deposit_id;

  if v_dep.deposit_intent_id is not null then
    update public.deposit_intents
       set status = 'matched', matched_deposit_id = p_deposit_id, updated_at = now()
     where id = v_dep.deposit_intent_id and status <> 'matched';
  end if;

  perform public.fn_notify(p_user_id, 'Top-up credited',
    format('GHS %s was credited to your wallet by support. New balance: GHS %s.',
           to_char(v_amount, 'FM999999990.00'), to_char(v_wallet.balance_ghs, 'FM999999990.00')),
    'success', jsonb_build_object('deposit_id', p_deposit_id, 'manual', true));

  perform public.fn_admin_audit(p_actor, 'deposit.credit', 'deposit', p_deposit_id::text,
                                jsonb_build_object('user_id', p_user_id, 'amount_ghs', v_amount, 'note', p_note));

  return jsonb_build_object('ok', true, 'status', 'credited', 'deposit_id', p_deposit_id,
                            'user_id', p_user_id, 'amount_ghs', v_amount,
                            'new_balance_ghs', v_wallet.balance_ghs,
                            'message', format('Credited GHS %s to %s.', to_char(v_amount, 'FM999999990.00'), v_user.phone));
end $$;

create or replace function public.fn_admin_withdrawals(p_status text default null, p_limit integer default 100, p_offset integer default 0)
returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'ok', true,
    'withdrawals', coalesce(jsonb_agg(row order by created_at desc), '[]'::jsonb),
    'count', count(*),
    'totals', jsonb_build_object(
      'pending_ghs', coalesce((select sum(net_amount_ghs) from public.withdrawals where status in ('pending','processing')), 0),
      'batched_ghs', coalesce((select sum(net_amount_ghs) from public.withdrawals where status = 'batched'), 0),
      'paid_ghs', coalesce((select sum(amount_ghs) from public.withdrawals where status = 'paid'), 0),
      'fees_ghs', coalesce((select sum(fee_ghs) from public.withdrawals), 0)
    )
  )
  from (
    select jsonb_build_object(
      'id', w.id, 'amount_ghs', w.amount_ghs, 'fee_ghs', w.fee_ghs, 'net_amount_ghs', w.net_amount_ghs,
      'mode', w.mode, 'status', w.status, 'tier_at_request', w.tier_at_request,
      'payout_method', w.payout_method, 'payout_details', w.payout_details,
      'payout_reference', w.payout_reference, 'scheduled_for', w.scheduled_for,
      'created_at', w.created_at, 'processed_at', w.processed_at, 'note', w.note,
      'user', jsonb_build_object('id', u.id, 'phone', u.phone, 'name', u.full_name, 'tier', u.tier,
                                 'balance_ghs', coalesce(uw.balance_ghs, 0))
    ) as row,
    w.created_at
    from public.withdrawals w
    join public.users u on u.id = w.user_id
    left join public.wallets uw on uw.user_id = w.user_id
    where (p_status is null or p_status = '' or w.status::text = p_status)
    order by w.created_at desc
    limit least(coalesce(p_limit, 100), 500) offset greatest(coalesce(p_offset, 0), 0)
  ) t;
$$;

create or replace function public.fn_admin_mark_withdrawal(
  p_withdrawal_id uuid, p_status public.withdrawal_status, p_payout_reference text default null,
  p_note text default null, p_actor text default 'admin'
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_w public.withdrawals;
  v_wallet public.wallets;
  v_ledger_id bigint;
begin
  select * into v_w from public.withdrawals where id = p_withdrawal_id for update;
  if v_w.id is null then return jsonb_build_object('ok', false, 'error', 'WITHDRAWAL_NOT_FOUND'); end if;
  if v_w.status in ('paid', 'rejected') then
    return jsonb_build_object('ok', false, 'error', 'ALREADY_FINAL', 'status', v_w.status);
  end if;

  if p_status = 'rejected' then
    -- Return the debited funds (net + fee) to the wallet.
    perform 1 from public.wallets where user_id = v_w.user_id for update;
    v_wallet := public.fn_wallet_apply(v_w.user_id, v_w.amount_ghs, 0, 0, 0, -v_w.amount_ghs);
    v_ledger_id := public.fn_ledger_append(
      v_w.user_id, 'refund', v_w.amount_ghs,
      format('Withdrawal %s rejected — funds returned%s', coalesce(v_w.payout_reference, v_w.id::text),
             case when nullif(trim(coalesce(p_note, '')), '') is null then '' else ': ' || left(p_note, 140) end),
      v_wallet.balance_ghs, 0, v_wallet.commission_balance_ghs,
      'WRF-' || upper(substr(replace(v_w.id::text, '-', ''), 1, 8)),
      null, null, jsonb_build_object('withdrawal_id', v_w.id, 'actor', p_actor)
    );
    perform public.fn_notify(v_w.user_id, 'Withdrawal rejected',
      format('GHS %s was returned to your wallet.%s', to_char(v_w.amount_ghs, 'FM999999990.00'),
             case when nullif(trim(coalesce(p_note, '')), '') is null then '' else ' Reason: ' || left(p_note, 160) end),
      'warning', jsonb_build_object('withdrawal_id', v_w.id));

    update public.withdrawals
       set status = 'rejected', note = coalesce(p_note, note), updated_at = now(), processed_at = now()
     where id = p_withdrawal_id;

    perform public.fn_admin_audit(p_actor, 'withdrawal.reject', 'withdrawal', p_withdrawal_id::text,
                                  jsonb_build_object('amount_ghs', v_w.amount_ghs, 'note', p_note));
    return jsonb_build_object('ok', true, 'status', 'rejected', 'refunded_ghs', v_w.amount_ghs,
                              'new_balance_ghs', v_wallet.balance_ghs, 'ledger_id', v_ledger_id);
  end if;

  update public.withdrawals
     set status = p_status,
         payout_reference = coalesce(nullif(trim(coalesce(p_payout_reference, '')), ''), payout_reference),
         note = coalesce(p_note, note),
         processed_at = case when p_status in ('paid', 'rejected') then now() else processed_at end,
         updated_at = now()
   where id = p_withdrawal_id
  returning * into v_w;

  if p_status = 'paid' then
    perform public.fn_notify(v_w.user_id, 'Withdrawal paid',
      format('GHS %s has been sent to your %s number. Reference: %s.',
             to_char(v_w.net_amount_ghs, 'FM999999990.00'), v_w.payout_method,
             coalesce(v_w.payout_reference, '—')),
      'success', jsonb_build_object('withdrawal_id', v_w.id, 'net_ghs', v_w.net_amount_ghs));
  end if;

  perform public.fn_admin_audit(p_actor, 'withdrawal.' || p_status::text, 'withdrawal', p_withdrawal_id::text,
                                jsonb_build_object('payout_reference', p_payout_reference, 'note', p_note));

  return jsonb_build_object('ok', true, 'status', v_w.status, 'withdrawal', to_jsonb(v_w));
end $$;

-- Free Friday run: queue every batched payout for processing.
create or replace function public.fn_admin_process_free_friday(p_actor text default 'admin') returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_count integer := 0; v_total numeric := 0; v_rows jsonb;
begin
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', w.id, 'user_id', w.user_id, 'phone', u.phone, 'name', u.full_name,
           'net_amount_ghs', w.net_amount_ghs, 'payout_method', w.payout_method,
           'payout_details', w.payout_details)), '[]'::jsonb),
         count(*), coalesce(sum(w.net_amount_ghs), 0)
    into v_rows, v_count, v_total
    from public.withdrawals w join public.users u on u.id = w.user_id
   where w.status = 'batched';

  update public.withdrawals set status = 'processing', updated_at = now() where status = 'batched';

  perform public.fn_admin_audit(p_actor, 'withdrawal.free_friday_run', 'withdrawal', null,
                                jsonb_build_object('count', v_count, 'total_ghs', v_total));

  return jsonb_build_object('ok', true, 'count', v_count, 'total_ghs', v_total,
                            'scheduled_for', public.fn_next_free_friday(), 'payouts', v_rows,
                            'message', format('Queued %s Free Friday payout(s) worth GHS %s.',
                                              v_count, to_char(v_total, 'FM999999990.00')));
end $$;

-- Pricing table writes straight to `plans`.
create or replace function public.fn_admin_upsert_plan(
  p_network text,
  p_size_label text,
  p_data_mb integer,
  p_cost_price_ghs numeric,
  p_retail_price_ghs numeric,
  p_sub_agent_price_ghs numeric,
  p_super_agent_price_ghs numeric,
  p_validity_days integer default 90,
  p_active boolean default true,
  p_sort_order integer default 100,
  p_plan_id uuid default null,
  p_actor text default 'admin'
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_plan public.plans; v_err text;
begin
  if p_network not in ('MTN', 'Telecel', 'AirtelTigo') then
    return jsonb_build_object('ok', false, 'error', 'INVALID_NETWORK');
  end if;
  if coalesce(p_data_mb, 0) <= 0 then
    return jsonb_build_object('ok', false, 'error', 'INVALID_SIZE', 'message', 'Enter the bundle size in MB.');
  end if;
  if least(p_cost_price_ghs, p_retail_price_ghs, p_sub_agent_price_ghs, p_super_agent_price_ghs) < 0 then
    return jsonb_build_object('ok', false, 'error', 'NEGATIVE_PRICE', 'message', 'Prices cannot be negative.');
  end if;
  if p_retail_price_ghs < p_cost_price_ghs or p_sub_agent_price_ghs < p_cost_price_ghs or p_super_agent_price_ghs < p_cost_price_ghs then
    return jsonb_build_object('ok', false, 'error', 'BELOW_COST', 'message', 'No tier price may sit below cost price.');
  end if;
  if not (p_super_agent_price_ghs <= p_sub_agent_price_ghs and p_sub_agent_price_ghs <= p_retail_price_ghs) then
    return jsonb_build_object('ok', false, 'error', 'TIER_ORDER', 'message', 'Pricing must increase from Super Agent → Sub-Agent → Customer.');
  end if;

  if p_plan_id is null then
    insert into public.plans (network, size_label, data_mb, validity_days, cost_price_ghs, retail_price_ghs,
                              sub_agent_price_ghs, super_agent_price_ghs, active, sort_order)
    values (p_network, trim(p_size_label), p_data_mb, coalesce(p_validity_days, 90), p_cost_price_ghs,
            p_retail_price_ghs, p_sub_agent_price_ghs, p_super_agent_price_ghs, coalesce(p_active, true), coalesce(p_sort_order, 100))
    returning * into v_plan;
  else
    update public.plans
       set network = p_network, size_label = trim(p_size_label), data_mb = p_data_mb,
           validity_days = coalesce(p_validity_days, 90), cost_price_ghs = p_cost_price_ghs,
           retail_price_ghs = p_retail_price_ghs, sub_agent_price_ghs = p_sub_agent_price_ghs,
           super_agent_price_ghs = p_super_agent_price_ghs, active = coalesce(p_active, true),
           sort_order = coalesce(p_sort_order, 100), updated_at = now()
     where id = p_plan_id
    returning * into v_plan;
    if v_plan.id is null then
      return jsonb_build_object('ok', false, 'error', 'PLAN_NOT_FOUND');
    end if;
  end if;

  perform public.fn_admin_audit(p_actor, case when p_plan_id is null then 'plan.create' else 'plan.update' end,
                                'plan', v_plan.id::text, to_jsonb(v_plan));
  return jsonb_build_object('ok', true, 'plan', to_jsonb(v_plan));
exception
  when unique_violation then
    return jsonb_build_object('ok', false, 'error', 'DUPLICATE_PLAN',
                              'message', 'A bundle with that network and size already exists.');
  when check_violation then
    get stacked diagnostics v_err = message_text;
    return jsonb_build_object('ok', false, 'error', 'INVALID_PRICING', 'message', v_err);
end $$;

create or replace function public.fn_admin_plans() returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('ok', true, 'plans', coalesce(jsonb_agg(to_jsonb(p) order by p.network, p.data_mb), '[]'::jsonb))
  from public.plans p;
$$;

create or replace function public.fn_admin_users(p_search text default null, p_limit integer default 50, p_offset integer default 0)
returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('ok', true, 'users', coalesce(jsonb_agg(row order by created_at desc), '[]'::jsonb), 'count', count(*))
  from (
    select jsonb_build_object(
      'id', u.id, 'phone', u.phone, 'full_name', u.full_name, 'tier', u.tier, 'status', u.status,
      'squad_id', u.squad_id, 'squad_name', s.name, 'super_agent', sa.phone,
      'created_at', u.created_at, 'last_login_at', u.last_login_at,
      'bot_enabled', u.bot_enabled, 'has_telegram', u.telegram_bot_token is not null,
      'super_agent_unlocked_at', u.super_agent_unlocked_at,
      'balance_ghs', coalesce(w.balance_ghs, 0), 'commission_ghs', coalesce(w.commission_balance_ghs, 0),
      'deposited_ghs', coalesce(w.total_deposited_ghs, 0), 'spent_ghs', coalesce(w.total_spent_ghs, 0),
      'orders', coalesce((select count(*) from public.orders o where o.buyer_id = u.id), 0)
    ) as row,
    u.created_at
    from public.users u
    left join public.wallets w on w.user_id = u.id
    left join public.squads s on s.id = u.squad_id
    left join public.users sa on sa.id = s.super_agent_id
    where p_search is null or p_search = '' or u.phone like '%' || p_search || '%'
       or coalesce(u.full_name, '') ilike '%' || p_search || '%'
    order by u.created_at desc
    limit least(coalesce(p_limit, 50), 500) offset greatest(coalesce(p_offset, 0), 0)
  ) t;
$$;

create or replace function public.fn_admin_ledger(p_type text default null, p_search text default null, p_limit integer default 100, p_offset integer default 0)
returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('ok', true, 'entries', coalesce(jsonb_agg(row order by created_at desc), '[]'::jsonb), 'count', count(*))
  from (
    select jsonb_build_object(
      'id', l.id, 'entry_type', l.entry_type, 'amount_ghs', l.amount_ghs,
      'commission_amount_ghs', l.commission_amount_ghs, 'balance_after', l.balance_after,
      'commission_balance_after', l.commission_balance_after, 'description', l.description,
      'reference', l.reference, 'order_id', l.order_id, 'created_at', l.created_at,
      'user', jsonb_build_object('id', u.id, 'phone', u.phone, 'name', u.full_name)
    ) as row,
    l.created_at
    from public.wallet_ledger l
    join public.users u on u.id = l.user_id
    where (p_type is null or p_type = '' or l.entry_type::text = p_type)
      and (p_search is null or p_search = '' or u.phone like '%' || p_search || '%'
           or coalesce(l.reference, '') ilike '%' || p_search || '%'
           or coalesce(l.description, '') ilike '%' || p_search || '%')
    order by l.created_at desc
    limit least(coalesce(p_limit, 100), 1000) offset greatest(coalesce(p_offset, 0), 0)
  ) t;
$$;

create or replace function public.fn_admin_squads() returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('ok', true, 'squads', coalesce(jsonb_agg(row order by volume desc), '[]'::jsonb))
  from (
    select jsonb_build_object(
      'id', s.id, 'name', s.name, 'invite_code', s.invite_code,
      'volume_target_ghs', s.volume_target_ghs, 'current_volume_ghs', s.current_volume_ghs,
      'tier_retained', s.tier_retained, 'period_start', s.current_period_start,
      'period_end', public.fn_period_end(s.current_period_start),
      'progress_pct', least(round(s.current_volume_ghs / nullif(s.volume_target_ghs, 0) * 100, 1), 100),
      'super_agent', jsonb_build_object('id', sa.id, 'phone', sa.phone, 'name', sa.full_name),
      'members', (select count(*) from public.users m where m.squad_id = s.id and m.tier <> 'super_agent'),
      'orders_this_period', (select count(*) from public.orders o
                              where o.squad_id = s.id and o.status = 'delivered'
                                and o.created_at >= s.current_period_start)
    ) as row,
    s.current_volume_ghs as volume
    from public.squads s join public.users sa on sa.id = s.super_agent_id
  ) t;
$$;

create or replace function public.fn_admin_set_user_tier(p_user_id uuid, p_tier public.user_tier, p_actor text default 'admin')
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_user public.users; v_before public.user_tier;
begin
  select * into v_user from public.users where id = p_user_id for update;
  if v_user.id is null then return jsonb_build_object('ok', false, 'error', 'USER_NOT_FOUND'); end if;
  v_before := v_user.tier;
  update public.users
     set tier = p_tier,
         super_agent_unlocked_at = case when p_tier = 'super_agent' then coalesce(super_agent_unlocked_at, now()) else super_agent_unlocked_at end,
         updated_at = now()
   where id = p_user_id;

  if p_tier = 'super_agent' and not exists (select 1 from public.squads where super_agent_id = p_user_id) then
    insert into public.squads (super_agent_id, name, invite_code, volume_target_ghs, current_period_start)
    values (p_user_id, coalesce(v_user.full_name, 'Super Agent') || ' Squad', public.fn_random_code('SQL-', 5),
            public.fn_setting_num('squad_volume_target_ghs', 5000), public.fn_period_start());
  end if;

  perform public.fn_admin_audit(p_actor, 'user.tier_change', 'user', p_user_id::text,
                                jsonb_build_object('from', v_before, 'to', p_tier));
  perform public.fn_notify(p_user_id, 'Account tier updated',
    format('Your account tier is now %s.', replace(p_tier::text, '_', ' ')), 'info');
  return jsonb_build_object('ok', true, 'user_id', p_user_id, 'tier', p_tier, 'previous_tier', v_before);
end $$;

create or replace function public.fn_admin_credit_wallet(
  p_user_id uuid, p_amount numeric, p_reason text, p_actor text default 'admin'
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_wallet public.wallets; v_ledger_id bigint; v_amount numeric(14,2) := round(coalesce(p_amount, 0)::numeric, 2);
begin
  if v_amount = 0 then return jsonb_build_object('ok', false, 'error', 'INVALID_AMOUNT'); end if;
  perform 1 from public.wallets where user_id = p_user_id for update;
  v_wallet := public.fn_wallet_apply(p_user_id, v_amount, 0, case when v_amount > 0 then v_amount else 0 end);
  v_ledger_id := public.fn_ledger_append(
    p_user_id, 'admin_adjustment', v_amount,
    coalesce(nullif(trim(coalesce(p_reason, '')), ''), 'Manual adjustment by ' || p_actor),
    v_wallet.balance_ghs, 0, v_wallet.commission_balance_ghs,
    public.fn_random_code('ADJ-', 6), null, null, jsonb_build_object('actor', p_actor)
  );
  perform public.fn_admin_audit(p_actor, 'wallet.adjust', 'user', p_user_id::text,
                                jsonb_build_object('amount_ghs', v_amount, 'reason', p_reason));
  return jsonb_build_object('ok', true, 'balance_ghs', v_wallet.balance_ghs, 'ledger_id', v_ledger_id);
end $$;

create or replace function public.fn_admin_settings() returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('ok', true, 'settings', coalesce(jsonb_agg(to_jsonb(s) order by s.key), '[]'::jsonb))
  from public.settings s;
$$;

create or replace function public.fn_admin_upsert_setting(p_key text, p_value jsonb, p_actor text default 'admin', p_description text default null)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_before jsonb;
begin
  select value into v_before from public.settings where key = p_key;
  insert into public.settings (key, value, description, updated_at)
  values (p_key, p_value, p_description, now())
  on conflict (key) do update set value = excluded.value,
                                  description = coalesce(excluded.description, public.settings.description),
                                  updated_at = now();
  perform public.fn_admin_audit(p_actor, 'setting.upsert', 'setting', p_key,
                                jsonb_build_object('from', v_before, 'to', p_value));
  return jsonb_build_object('ok', true, 'key', p_key, 'value', p_value);
end $$;

create or replace function public.fn_admin_webhook_events(p_source text default null, p_limit integer default 50)
returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('ok', true, 'events', coalesce(jsonb_agg(to_jsonb(w) order by w.created_at desc), '[]'::jsonb))
  from (
    select * from public.webhook_events
     where (p_source is null or p_source = '' or source = p_source)
     order by created_at desc limit least(coalesce(p_limit, 50), 200)
  ) w;
$$;

-- ---------------------------------------------------------------------------
-- 13. INTEGRITY: prove the ledger and the wallets still agree.
--     Run this from the admin panel and from the test suite.
-- ---------------------------------------------------------------------------
create or replace function public.fn_admin_reconcile() returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  with balances as (
    select w.user_id,
           w.balance_ghs, w.commission_balance_ghs,
           coalesce((select sum(l.amount_ghs) from public.wallet_ledger l where l.user_id = w.user_id), 0) as ledger_balance,
           coalesce((select sum(l.commission_amount_ghs) from public.wallet_ledger l where l.user_id = w.user_id), 0) as ledger_commission
      from public.wallets w
  ),
  drift as (
    select user_id, balance_ghs, ledger_balance, commission_balance_ghs, ledger_commission,
           balance_ghs - ledger_balance as balance_drift,
           commission_balance_ghs - ledger_commission as commission_drift
      from balances
     where balance_ghs <> ledger_balance or commission_balance_ghs <> ledger_commission
  )
  select jsonb_build_object(
    'ok', true,
    'checked_wallets', (select count(*) from balances),
    'drift_count', (select count(*) from drift),
    'drift', coalesce((select jsonb_agg(jsonb_build_object(
        'user_id', d.user_id, 'balance_ghs', d.balance_ghs, 'ledger_balance', d.ledger_balance,
        'commission_balance_ghs', d.commission_balance_ghs, 'ledger_commission', d.ledger_commission,
        'balance_drift', d.balance_drift, 'commission_drift', d.commission_drift) order by abs(d.balance_drift) desc)
      from (select * from drift limit 50) d), '[]'::jsonb),
    'ledger', jsonb_build_object(
      'entries', (select count(*) from public.wallet_ledger),
      'net_ghs', coalesce((select sum(amount_ghs) from public.wallet_ledger), 0),
      'commission_net_ghs', coalesce((select sum(commission_amount_ghs) from public.wallet_ledger), 0),
      'first_entry', (select min(created_at) from public.wallet_ledger),
      'last_entry', (select max(created_at) from public.wallet_ledger),
      'terminal_balances', coalesce((select sum(balance_ghs) from public.wallets), 0)
    ),
    'money_in', jsonb_build_object(
      'deposits_credited_ghs', coalesce((select sum(amount_ghs) from public.deposits where status = 'credited'), 0),
      'p2p_received_ghs', coalesce((select sum(amount_ghs) from public.wallet_ledger where entry_type = 'p2p_receive'), 0),
      'reinvested_ghs', coalesce((select sum(amount_ghs) from public.wallet_ledger where entry_type = 'commission_reinvest'), 0),
      'bonus_ghs', coalesce((select sum(amount_ghs) from public.wallet_ledger where entry_type = 'reinvest_bonus'), 0),
      'refunds_ghs', coalesce((select sum(amount_ghs) from public.wallet_ledger where entry_type = 'refund'), 0),
      'adjustments_ghs', coalesce((select sum(amount_ghs) from public.wallet_ledger where entry_type = 'admin_adjustment'), 0)
    ),
    'money_out', jsonb_build_object(
      'purchases_ghs', coalesce((select -sum(amount_ghs) from public.wallet_ledger where entry_type = 'purchase'), 0),
      'withdrawals_ghs', coalesce((select -sum(amount_ghs) from public.wallet_ledger where entry_type = 'withdrawal'), 0),
      'withdrawal_fees_ghs', coalesce((select -sum(amount_ghs) from public.wallet_ledger where entry_type = 'withdrawal_fee'), 0),
      'p2p_sent_ghs', coalesce((select -sum(amount_ghs) from public.wallet_ledger where entry_type = 'p2p_send'), 0)
    ),
    'orders', jsonb_build_object(
      'delivered', (select count(*) from public.orders where status = 'delivered'),
      'revenue_ghs', coalesce((select sum(price_charged_ghs) from public.orders where status = 'delivered'), 0)
    )
  );
$$;

-- ---------------------------------------------------------------------------
-- 14. PUBLIC CONFIG — the handful of settings the browser is allowed to see.
--     (Collection numbers, limits and support contacts. No secrets.)
-- ---------------------------------------------------------------------------
create or replace function public.fn_public_config() returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'platform_name', public.fn_setting_text('platform_name', 'Priceless Bundle'),
    'platform_tagline', public.fn_setting_text('platform_tagline', 'Instant data. Priceless prices.'),
    'company_name', public.fn_setting_text('company_name', 'LongKinnex Tech and Data'),
    'support_phone', public.fn_setting_text('support_phone', '0551234567'),
    'support_whatsapp', public.fn_setting_text('support_whatsapp', '0551234567'),
    'collection_number_momo', public.fn_setting_text('collection_number_momo', '0551234567'),
    'collection_number_telecel', public.fn_setting_text('collection_number_telecel', '0501234567'),
    'collection_number_airteltigo', public.fn_setting_text('collection_number_airteltigo', '0271234567'),
    'min_deposit_ghs', public.fn_setting_num('min_deposit_ghs', 1),
    'max_deposit_ghs', public.fn_setting_num('max_deposit_ghs', 20000),
    'min_withdrawal_ghs', public.fn_setting_num('min_withdrawal_ghs', 5),
    'instant_withdrawal_fee_ghs', public.fn_setting_num('instant_withdrawal_fee_ghs', 1.5),
    'max_instant_withdrawal_ghs', public.fn_setting_num('max_instant_withdrawal_ghs', 2000),
    'super_agent_commitment_ghs', public.fn_setting_num('super_agent_commitment_ghs', 500),
    'squad_volume_target_ghs', public.fn_setting_num('squad_volume_target_ghs', 5000),
    'commission_rate_squad_sale', public.fn_setting_num('commission_rate_squad_sale', 0.03),
    'min_p2p_ghs', public.fn_setting_num('min_p2p_ghs', 1),
    'reinvest_bonus_min_pct', public.fn_setting_num('reinvest_bonus_min_pct', 2),
    'reinvest_bonus_max_pct', public.fn_setting_num('reinvest_bonus_max_pct', 5),
    'reinvest_bonus_tiers', public.fn_setting('reinvest_bonus_tiers', '[]'::jsonb),
    'supplier_mock', public.fn_setting('supplier_mock', 'true'::jsonb)
  );
$$;

-- Parse telemetry for the webhook audit trail (optional, never blocks credit).
create or replace function public.fn_finish_parse(p_id bigint, p_parsed jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update public.webhook_events
     set parsed_payload = coalesce(p_parsed, '{}'::jsonb)
   where id = p_id;
  return jsonb_build_object('ok', true);
exception when others then
  return jsonb_build_object('ok', false, 'error', sqlerrm);
end $$;

create or replace function public.fn_admin_set_user_status(p_user_id uuid, p_status text, p_actor text default 'admin')
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_user public.users;
begin
  if p_status not in ('active', 'suspended') then
    return jsonb_build_object('ok', false, 'error', 'INVALID_STATUS');
  end if;
  select * into v_user from public.users where id = p_user_id for update;
  if v_user.id is null then return jsonb_build_object('ok', false, 'error', 'USER_NOT_FOUND'); end if;

  update public.users set status = p_status, updated_at = now() where id = p_user_id;
  perform public.fn_admin_audit(p_actor, 'user.status', 'user', p_user_id::text,
                                jsonb_build_object('from', v_user.status, 'to', p_status));
  return jsonb_build_object('ok', true, 'user_id', p_user_id, 'status', p_status);
end $$;
