-- ============================================================================
--  PRICELESS BUNDLE — SEED DATA (safe for production)
--  Platform settings + the launch price list. No users, no demo data.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- SETTINGS
-- ---------------------------------------------------------------------------
insert into public.settings (key, value, description) values
  ('platform_name',                '"Priceless Bundle"'::jsonb,      'Public brand name'),
  ('platform_tagline',             '"Instant data. Priceless prices."'::jsonb, 'Landing page tagline'),
  ('company_name',                 '"LongKinnex Tech and Data"'::jsonb, 'Operator (footer only)'),
  ('support_phone',                '"0551234567"'::jsonb,            'Support line shown in the app'),
  ('support_whatsapp',             '"0551234567"'::jsonb,            'Support WhatsApp number'),

  -- Payment collection: these are the numbers an SMS-forwarding Android phone
  -- monitors. CHANGE THESE to your real collection numbers after deployment.
  ('collection_number_momo',       '"0551234567"'::jsonb,            'MTN MoMo collection number (placeholder)'),
  ('collection_number_telecel',    '"0501234567"'::jsonb,            'Telecel Cash collection number (placeholder)'),
  ('collection_number_airteltigo', '"0271234567"'::jsonb,            'AirtelTigo Money collection number (placeholder)'),

  -- Deposits
  ('min_deposit_ghs',              '1'::jsonb,                        'Minimum wallet top-up'),
  ('max_deposit_ghs',              '20000'::jsonb,                    'Maximum single wallet top-up'),
  ('deposit_intent_ttl_minutes',   '60'::jsonb,                       'How long a top-up reference stays live'),
  ('deposit_amount_match_window_minutes', '240'::jsonb,               'Fallback amount-matching window'),

  -- Withdrawals
  ('min_withdrawal_ghs',           '5'::jsonb,                        'Minimum withdrawal'),
  ('instant_withdrawal_fee_ghs',   '1.5'::jsonb,                      'Fee for an instant payout (Sub-Agents & customers)'),
  ('max_instant_withdrawal_ghs',   '2000'::jsonb,                     'Cap on instant payouts for non Super Agents'),
  ('free_friday_batch_hour',       '18'::jsonb,                       'Free Friday payout hour (Africa/Accra)'),

  -- Tiers & squads
  ('super_agent_commitment_ghs',   '500'::jsonb,                      'Lifetime deposits required to unlock Super Agent'),
  ('squad_volume_target_ghs',      '5000'::jsonb,                     'Monthly squad volume target to retain tier pricing'),
  ('commission_rate_squad_sale',   '0.03'::jsonb,                     'Super Agent commission on squad sales'),
  ('min_p2p_ghs',                  '1'::jsonb,                        'Minimum peer-to-peer transfer'),

  -- Commission reinvestment bonus
  ('reinvest_bonus_min_pct',       '2'::jsonb,                        'Minimum reinvestment bonus'),
  ('reinvest_bonus_max_pct',       '5'::jsonb,                        'Maximum reinvestment bonus'),
  ('reinvest_bonus_tiers',         '[{"min":0,"rate":0.02},{"min":100,"rate":0.03},{"min":500,"rate":0.04},{"min":2000,"rate":0.05}]'::jsonb, 'Bonus rate steps by reinvested amount'),

  -- Supplier
  ('supplier_name',                '"DataMartGH"'::jsonb,             'Upstream data vendor'),
  ('supplier_mock',                'true'::jsonb,                     'Still on the mock vendor (TODO: live API)')
on conflict (key) do update
  set value = excluded.value,
      description = coalesce(excluded.description, public.settings.description),
      updated_at = now();

-- ---------------------------------------------------------------------------
-- LAUNCH PRICE LIST
--   cost_price_ghs        = what we pay the vendor
--   retail_price_ghs      = walk-in customer
--   sub_agent_price_ghs   = Sub-Agent (squad discount tier)
--   super_agent_price_ghs = Super Agent VIP wholesale
--   Guaranteed by constraint: super <= sub <= retail and all >= cost.
-- ---------------------------------------------------------------------------
insert into public.plans
  (network, size_label, data_mb, validity_days, cost_price_ghs, retail_price_ghs, sub_agent_price_ghs, super_agent_price_ghs, active, sort_order)
values
  -- MTN
  ('MTN', '1GB',   1024,  90,   5.00,   6.50,   6.00,   5.60, true, 10),
  ('MTN', '2GB',   2048,  90,   9.80,  12.00,  11.20,  10.40, true, 20),
  ('MTN', '3GB',   3072,  90,  14.40,  17.50,  16.30,  15.20, true, 30),
  ('MTN', '5GB',   5120,  90,  23.50,  28.00,  26.00,  24.50, true, 40),
  ('MTN', '10GB', 10240,  90,  44.00,  52.00,  49.00,  46.00, true, 50),
  ('MTN', '15GB', 15360,  90,  64.00,  74.00,  70.00,  66.50, true, 60),
  ('MTN', '20GB', 20480,  90,  84.00,  96.00,  91.00,  87.00, true, 70),
  ('MTN', '25GB', 25600,  90, 103.00, 118.00, 112.00, 107.00, true, 80),
  ('MTN', '50GB', 51200,  90, 200.00, 225.00, 215.00, 208.00, true, 90),
  ('MTN', '100GB',102400, 90, 390.00, 430.00, 415.00, 400.00, true, 100),

  -- Telecel
  ('Telecel', '1GB',   1024,  90,   4.70,   6.00,   5.60,   5.20, true, 10),
  ('Telecel', '2GB',   2048,  90,   9.00,  11.00,  10.30,   9.60, true, 20),
  ('Telecel', '5GB',   5120,  90,  21.00,  25.00,  23.50,  22.00, true, 30),
  ('Telecel', '10GB', 10240,  90,  40.00,  47.00,  44.50,  42.00, true, 40),
  ('Telecel', '15GB', 15360,  90,  58.00,  67.00,  63.50,  60.50, true, 50),
  ('Telecel', '20GB', 20480,  90,  76.00,  87.00,  82.50,  79.00, true, 60),
  ('Telecel', '25GB', 25600,  90,  94.00, 107.00, 102.00,  97.50, true, 70),
  ('Telecel', '50GB', 51200,  90, 180.00, 203.00, 194.00, 187.00, true, 80),

  -- AirtelTigo
  ('AirtelTigo', '1GB',   1024, 90,  4.30,  5.50,  5.10,  4.80, true, 10),
  ('AirtelTigo', '2GB',   2048, 90,  8.20, 10.00,  9.40,  8.80, true, 20),
  ('AirtelTigo', '5GB',   5120, 90, 19.00, 23.00, 21.50, 20.20, true, 30),
  ('AirtelTigo', '10GB', 10240, 90, 36.00, 42.00, 40.00, 38.00, true, 40),
  ('AirtelTigo', '15GB', 15360, 90, 52.00, 60.00, 57.00, 54.00, true, 50),
  ('AirtelTigo', '20GB', 20480, 90, 68.00, 78.00, 74.00, 70.50, true, 60)
on conflict (network, size_label) do update
  set data_mb = excluded.data_mb,
      validity_days = excluded.validity_days,
      cost_price_ghs = excluded.cost_price_ghs,
      retail_price_ghs = excluded.retail_price_ghs,
      sub_agent_price_ghs = excluded.sub_agent_price_ghs,
      super_agent_price_ghs = excluded.super_agent_price_ghs,
      active = excluded.active,
      sort_order = excluded.sort_order,
      updated_at = now();
