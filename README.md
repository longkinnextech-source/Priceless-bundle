# Priceless Bundle

**Instant data. Priceless prices.**

A production VTU (mobile data reselling) platform for Ghana — built by **LongKinnex Tech and Data**.
Customers top up a wallet with Mobile Money and push MTN / Telecel / AirtelTigo data to any
number. Agents resell at discount pricing, Super Agents get VIP wholesale rates, free instant
payouts and their own Telegram / WhatsApp bot, and squads pool their sales to keep their tier.

```
Next.js 16 (App Router) · TypeScript · Tailwind CSS 4 · PostgreSQL / Supabase
```

---

## Table of contents

- [What's in the box](#whats-in-the-box)
- [Quick start (2 minutes)](#quick-start-2-minutes)
- [Deploying to Supabase](#deploying-to-supabase)
- [Environment variables](#environment-variables)
- [Automatic payment collection (SMS forwarder)](#automatic-payment-collection-sms-forwarder)
- [The money model](#the-money-model)
- [Agent tiers, squads and commission](#agent-tiers-squads-and-commission)
- [Bot-in-a-Box](#bot-in-a-box)
- [Admin panel](#admin-panel)
- [Connecting the real data supplier](#connecting-the-real-data-supplier)
- [Testing](#testing)
- [Project layout](#project-layout)
- [Going live checklist](#going-live-checklist)

---

## What's in the box

| Area | What's built |
| --- | --- |
| **Database** | 15 tables, 80+ Postgres functions, immutable ledger, row level security. `supabase/schema.sql`, `supabase/functions.sql`, `supabase/seed.sql` |
| **Wallet** | Atomic top-ups via MoMo SMS, P2P transfers, withdrawals (instant / Free Friday), commission pot with 2–5% reinvestment bonus |
| **Buy data** | Server-side tier pricing, atomic debit + order creation, ~95% mock supplier, automatic refunds on failure |
| **Agents** | Customer → Sub-Agent (free) → Super Agent (GHS 500 deposit commitment), squads with monthly volume targets and tier retention |
| **Bots** | Bot-in-a-Box: a Super Agent links their own Telegram token or WhatsApp Business endpoint and sells through it at wholesale |
| **Admin** | Editable pricing table, full order list, unmatched-deposit review queue, revenue + margin reporting, ledger reconciliation, user management |
| **Tests** | 257 database assertions + 199 end-to-end API assertions, both runnable with one command |

---

## Quick start (2 minutes)

```bash
npm install
cp .env.example .env.local          # optional — dev defaults are built in
npm run dev:local                   # starts a local PostgreSQL + the app
```

`npm run dev:local` boots a real PostgreSQL engine (PGlite, Postgres compiled to WebAssembly)
over the wire protocol on port `55432`, applies the schema, then starts Next.js on
<http://localhost:3000> with `DATABASE_URL` already pointed at it. No Docker, no local Postgres
install, no configuration.

**Operator login:** `0244000000` / `246810` → <http://localhost:3000/login>

> The local database is a development convenience only. Production uses Supabase — see below.

Other useful commands:

```bash
npm run dev          # Next.js only (needs DATABASE_URL or SUPABASE_* set)
npm run db:setup     # apply schema.sql → functions.sql → seed.sql
npm run db:reset     # wipe the local database and re-apply everything
npm run db:verify    # apply + print fn_health() and the ledger reconciliation
npm test             # 257 database tests + 199 end-to-end API tests
npm run build        # production build
npm run lint         # eslint (React + TypeScript rules)
npm run typecheck    # tsc --noEmit
```

---

## Deploying to Supabase

### 1. Create the project and apply the schema

Create a project at [supabase.com](https://supabase.com), open **SQL Editor**, and run these three
files **in order**:

1. `supabase/schema.sql` — tables, enums, indexes, constraints, RLS
2. `supabase/functions.sql` — every money-moving stored function
3. `supabase/seed.sql` — platform settings + the launch price list

Every statement is idempotent, so re-running them is safe and is also how you ship updates.

Prefer the CLI? `supabase db push` works the same way, or pipe the files with `psql`:

```bash
psql "$DATABASE_URL" -f supabase/schema.sql
psql "$DATABASE_URL" -f supabase/functions.sql
psql "$DATABASE_URL" -f supabase/seed.sql
```

### 2. Point the app at it

Set **either** transport (the app auto-detects):

```bash
# A. Direct Postgres (recommended — lower latency, one round trip per call)
DATABASE_URL=postgresql://postgres:PASSWORD@db.<project>.supabase.co:5432/postgres

# B. Supabase REST/RPC with the service-role key
SUPABASE_URL=https://<project>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<service-role-key>
```

Both go through the exact same Postgres functions, so behaviour is identical.

> **Never** expose `SUPABASE_SERVICE_ROLE_KEY` to the browser. It bypasses row level security by
> design. It is only read in server code (`src/lib/env.ts` → `src/lib/db/index.ts`).

### 3. Security model

- RLS is **enabled with zero policies** on every table. The `anon` and `authenticated` keys can
  read and write nothing; `schema.sql` also revokes their table and schema privileges when those
  roles exist.
- All access flows through `SECURITY DEFINER` functions owned by the schema owner.
- `wallet_ledger` is **append-only** — a trigger rejects `UPDATE` and `DELETE` outright.
- `wallets.balance_ghs` has a `CHECK (balance_ghs >= 0)` constraint, so a negative balance is
  impossible even if application code misbehaves.
- Prices are resolved server-side from `plans`; a client-sent price is never read.
- The admin panel requires a session with the admin flag, which only the operator login grants.

---

## Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | one of these two | Direct Postgres connection |
| `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` | one of these two | PostgREST RPC transport |
| `SESSION_SECRET` | **yes in production** | Signs session cookies (32+ random characters) |
| `SMS_WEBHOOK_SECRET` | **yes** | Shared secret your SMS-forwarder app sends |
| `SMS_WEBHOOK_HEADER` | no | Header name (default `x-priceless-secret`) |
| `ADMIN_PHONE` / `ADMIN_PIN` | **yes** | Operator login for `/admin` — change both |
| `PUBLIC_BASE_URL` | recommended | Absolute URL used to register Telegram/WhatsApp webhooks |
| `TELEGRAM_WEBHOOK_SECRET` | no | Extra `secret_token` check on Telegram updates |
| `WHATSAPP_ACCESS_TOKEN` | no | Sends WhatsApp replies via the Cloud API |
| `WHATSAPP_CLOUD_API_URL` | no | Defaults to `https://graph.facebook.com/v21.0` |
| `DATAMARTGH_API_KEY` / `DATAMARTGH_BASE_URL` | no | Switches the supplier from mock to live |
| `SUPPLIER_SUCCESS_RATE` / `SUPPLIER_MOCK_MODE` | no | Mock tuning (`random`, `always_succeed`, `always_fail`) |

Generate a session secret:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

---

## Automatic payment collection (SMS forwarder)

There is **no third-party payment gateway**. The platform reads the Mobile Money confirmation SMS
that lands on the collection phone.

### How it works

```
1. User taps "Get my reference code" on /wallet
      → fn_create_deposit_intent() stores an intent with a unique code (e.g. PB-4X7Q)
        and returns the collection number + expiry

2. User sends the money to the collection number, using PB-4X7Q as the reference

3. The Android phone holding the collection SIM forwards every incoming SMS to
      POST /api/webhook/sms-deposit
   with the shared secret in the x-priceless-secret header

4. The route writes the RAW payload to webhook_events FIRST (always, whatever happens),
   then parses amount / sender / reference defensively

5. fn_process_sms_deposit() matches and credits in ONE transaction:
      reference code  → confidence 1.00
      sender phone    → confidence 0.90
      unique amount in a time window → confidence 0.70
      anything ambiguous or unparsed → unmatched_review (a human decides)

6. The wallet, the ledger entry, the deposit row and the intent are all updated
   together — or not at all.
```

### Setting up the Android forwarder

Any SMS-forwarder app that can POST works (e.g. "SMS Forwarder — Auto forward", "SMS to URL
Forwarder"). Configure:

| Setting | Value |
| --- | --- |
| URL | `https://your-domain.com/api/webhook/sms-deposit` |
| Method | `POST` |
| Header | `x-priceless-secret: <your SMS_WEBHOOK_SECRET>` |
| Body | The raw SMS text (plain text, JSON `{"message": "..."}`, or form-encoded all work) |
| Trigger | Incoming SMS from your MoMo sender ID(s), e.g. `MobileMoney`, `TelecelCash` |

Test it:

```bash
curl -X POST https://your-domain.com/api/webhook/sms-deposit \
  -H "Content-Type: text/plain" \
  -H "x-priceless-secret: $SMS_WEBHOOK_SECRET" \
  --data 'Payment received for GHS 50.00 from 0244123456. Reference: PB-4X7Q. Your new balance is GHS 120.50.'
```

A wrong or missing secret returns `401` and credits nothing — but the attempt is still recorded in
`webhook_events` with `signature_ok = false`, and the admin panel shows it under **Integrity**.

### Which SMS formats are understood

The parser is deliberately conservative — it never throws, and it never guesses:

```
Payment received for GHS 50.00 from KOFI MENSAH 0244123456. Reference: PB-4X7Q. New balance GHS 120.50
You have received GHS20.00 from 0501234567. Ref PB4X7Q. Current balance GHS 45.00
GHS 100.00 has been credited to your Telecel Cash account from 0551234567. Trans ID: TC240912.1234
Cash In: GHS 5.00 from 0264123456 (AMA). New balance: GHS 5.00.
```

`balance` figures are explicitly skipped so they can never be mistaken for the payment amount.

### Debit alerts are never credited

The collection phone also receives **debit** alerts — cash-outs, airtime purchases, transfers out.
Those are money *leaving*, so they must never become a wallet credit. Every SMS is classified as
`credit`, `debit` or `unknown` before it is matched:

| Direction | What happens |
| --- | --- |
| `credit` | matched and credited normally |
| `debit` | **always held** (`DEBIT_MESSAGE`) even if it quotes a live reference code — the operator dismisses it in one click |
| `unknown` + reference or unique-amount match | credited — the user's own pending intent corroborates it |
| `unknown` + sender-number match only | held (`DIRECTION_UNVERIFIED`) — one weak signal on its own is not enough to create money |

```bash
# A debit alert settles into the review queue instead of the wallet:
curl -X POST https://your-domain.com/api/webhook/sms-deposit \
  -H "x-priceless-secret: $SMS_WEBHOOK_SECRET" \
  --data 'Your Mobile Money account has been debited GHS 40.00 for airtime purchase.'
# -> {"status":"unmatched_review", "parsed":{"direction":"debit","amount":null}, ...}
```

### Changing the collection numbers

Admin panel → **Pricing**-adjacent settings, or directly:

```sql
update public.settings set value = '"0244123456"'::jsonb where key = 'collection_number_momo';
update public.settings set value = '"0501234567"'::jsonb where key = 'collection_number_telecel';
```

They are placeholders out of the box — **change them before you take a single cedi.**

---

## The money model

Money never moves outside a Postgres function. The application layer cannot write a balance.

| Rule | Where it is enforced |
| --- | --- |
| No negative balance, ever | `CHECK (balance_ghs >= 0)` + `fn_wallet_apply()` |
| Every movement is logged with `balance_after` | `fn_ledger_append()`, called inside the same transaction |
| The ledger is immutable | `trg_ledger_immutable` (blocks UPDATE/DELETE) |
| A purchase is all-or-nothing | `fn_purchase_data()` — one transaction, wallet locked with `SELECT … FOR UPDATE` |
| A failed delivery is refunded automatically | `fn_fulfill_order()` — refund + ledger + status in one transaction |
| The same SMS can't credit twice | `deposits.sms_hash` unique constraint |
| Ambiguity never auto-credits | `fn_process_sms_deposit()` → `unmatched_review` |
| Prices come from the server | `fn_resolve_price()` / `fn_list_plans()` |
| Nobody sells below cost | `plans` CHECK constraints + `fn_admin_upsert_plan()` validation |

Ledger entry types: `deposit`, `purchase`, `commission`, `commission_reinvest`, `reinvest_bonus`,
`p2p_send`, `p2p_receive`, `withdrawal`, `withdrawal_fee`, `refund`, `admin_adjustment`, `squad_bonus`.

**Audit at any time** — `fn_admin_reconcile()` proves every wallet equals the sum of its ledger
entries, and the admin panel shows it under **Integrity**.

---

## Agent tiers, squads and commission

| Tier | How to get it | Pricing | Payouts |
| --- | --- | --- | --- |
| **Customer** | sign up | retail | instant (small fee) or free Friday batch |
| **Sub-Agent** | free upgrade | standard discount | instant (small fee) or free Friday batch |
| **Super Agent** | GHS 500 lifetime wallet deposits | VIP wholesale | unlimited free instant payouts |

The GHS 500 is a **deposit commitment, not a fee** — it stays in the wallet and can be spent.

**Squads.** A Super Agent gets a squad with an invite code (`SQL-XXXXX`) and can also add Sub-Agents
by phone number. Every delivered sale by a squad member is attributed to the squad and recomputed
automatically (`fn_squad_recompute`, called from `fn_fulfill_order`).

- Hit the monthly target (default GHS 5,000, configurable) → the whole squad keeps its discount
  tier into the next month.
- Miss it → `fn_ensure_squad_period()` flips the squad to retail pricing at the moment the period
  closes; the tier is earned back as soon as the new target is met.

**Commission.** Super Agents earn 3% (configurable) of every delivered squad sale, credited to a
separate commission pot. Reinvesting that pot into the main wallet earns a **2–5% bonus** on a
sliding ladder:

| Reinvested at once | Bonus |
| --- | --- |
| under GHS 100 | 2% |
| GHS 100 – 499.99 | 3% |
| GHS 500 – 1,999.99 | 4% |
| GHS 2,000 and above | 5% |

---

## Bot-in-a-Box

A Super Agent links their own bot in **Agent Dashboard → Bot-in-a-Box**.

### Telegram

1. Create a bot with [@BotFather](https://t.me/BotFather) and copy the token.
2. Paste it into the dashboard and hit **Link bot**. The app calls `setWebhook` for you and points it
   at `/api/bot/telegram/<token>`.
3. Message the bot:

```
help                        command list
balance                     wallet balance
prices                      this agent's own wholesale price list
buy mtn 5gb 0244123456      instant vend
orders                      last five orders
```

Every bot sale runs at that Super Agent's wholesale tier, is recorded in `bot_orders` with the end
customer's number and channel, and counts toward their squad volume. Delivery failures refund the
agent automatically.

Set `TELEGRAM_WEBHOOK_SECRET` to also verify Telegram's `x-telegram-bot-api-secret-token` header.

### WhatsApp Business

1. In Meta's dashboard, set the webhook URL to `https://your-domain.com/api/bot/whatsapp`.
2. Use the verify token you entered in the dashboard.
3. Link the endpoint (and optionally the phone number ID) so inbound messages can be attributed.

`GET /api/bot/whatsapp` answers Meta's `hub.challenge` handshake only if the verify token belongs to
a linked agent.

---

## Admin panel

`/admin` — operator login only.

| Tab | What it does |
| --- | --- |
| **Overview** | revenue, margin, deposits, order health, 14-day chart, network split, squad and wallet totals, the SMS webhook URL with a copy button |
| **Pricing** | create/edit `plans` directly — cost, retail, Sub-Agent and Super Agent prices, with server-side validation (never below cost, always Super ≤ Sub ≤ Retail) |
| **Orders** | every order with buyer, attribution, channel, margin, status and failure reason; search by phone, reference or order id |
| **Deposits** | the unmatched review queue with ranked candidate accounts and the raw SMS — credit or reject, both audited |
| **Payouts** | approve or reject withdrawals (rejection returns the funds automatically) and run the Free Friday batch |
| **Users** | search, change tiers, adjust wallets, suspend/reactivate |
| **Squads** | volume vs target, retention state, invite codes |
| **Integrity** | wallet ⇄ ledger reconciliation, money-in/money-out summary, and the raw SMS webhook audit trail |

Sign in with `ADMIN_PHONE` / `ADMIN_PIN`.

---

## Connecting the real data supplier

`src/lib/supplier.ts` contains `dispatchDataOrder()`, currently a mock with a ~95% success rate and
a clearly marked `TODO`. It is the **only** place that talks to the upstream vendor.

Everything downstream is already wired and tested: order state transitions, wallet refunds with
ledger entries, squad volume roll-up, commission, and the bot replies.

To go live:

1. Implement the DataMartGH call inside `dispatchDataOrder` (base URL + key from
   `DATAMARTGH_BASE_URL` / `DATAMARTGH_API_KEY`).
2. Keep the contract: **never throw**, return `{ ok: false, error }` on failure so
   `fn_fulfill_order()` can refund.
3. Make the call idempotent on our order id (send `reference`, treat a duplicate-reference response
   as success).
4. No other file needs to change.

---

## Testing

```bash
npm run test:sql     # 257 assertions, real Postgres, money rules & invariants
npm run test:e2e     # 199 assertions over HTTP against real route handlers
npm test             # both
```

`npm run test:e2e` starts its own stack (an in-memory Postgres on `:55433` plus two Next.js servers
on `:3100` / `:3101`, one with a succeeding supplier and one with a failing supplier so the refund
path is exercised for real). Point it at a running deployment instead with:

```bash
E2E_BASE_URL=https://your-domain.com E2E_FAIL_BASE_URL=http://localhost:3001 node tests/e2e.mjs
```

### Live walkthrough (great after a deploy)

```bash
BASE_URL=https://your-domain.com DATABASE_URL=postgres://... node scripts/smoke.mjs
```

It drives the wallet top-up and buy-data flows against the deployment, then reads the actual rows
back out of Postgres and prints them — including proof that a tampered client price is ignored.

---

## Project layout

```
supabase/
  schema.sql            tables, enums, constraints, indexes, RLS, ledger immutability
  functions.sql         every money-moving function (the whole business core)
  seed.sql              platform settings + launch price list
src/
  app/
    api/                34 route handlers (auth, plans, orders, wallet, agent, admin, bots, webhook)
    page.tsx            landing page
    buy/ wallet/ agent/ withdraw/ admin/ login/ signup/
  components/
    Logo.tsx            reads /public/logo.png — swap the file, nothing else to change
    Nav.tsx Footer.tsx Toast.tsx ui.tsx
    pages/              the five main screens
    forms/              signup + login
  lib/
    db/index.ts         Postgres access (pg or Supabase RPC) + jsonb handling
    auth.ts             PIN hashing (scrypt), signed session cookies
    sms.ts              defensive mobile-money SMS parser
    supplier.ts         mock supplier with the real-API TODO
    api.ts rpc.ts format.ts url.ts env.ts client.ts
scripts/
  pg-server.mjs         local PostgreSQL (PGlite) over the wire protocol
  dev-stack.mjs         one-command local stack
  db-setup.mjs          applies schema/functions/seed
  smoke.mjs             live deployment walkthrough
  db-verify.mjs         schema / seed / accounting checks against any database
tests/
  sql.test.mjs          database suite
  e2e.mjs               HTTP end-to-end suite
  harness.mjs           assertions + a real Postgres per run
public/logo.png         placeholder — replace with your own artwork
eslint.config.mjs       lint rules
```

---

## Going live checklist

- [ ] Set `SESSION_SECRET` to 32+ random characters.
- [ ] Change `ADMIN_PHONE` and `ADMIN_PIN`.
- [ ] Set `SMS_WEBHOOK_SECRET` and configure the Android forwarder with the same value.
- [ ] Update the collection numbers in `settings` to your real MoMo / Telecel numbers.
- [ ] Replace `public/logo.png` with your real logo (no code changes needed).
- [ ] Re-check the price list in **Admin → Pricing** against your current DataMartGH costs.
- [ ] Set `PUBLIC_BASE_URL` so Telegram/WhatsApp webhooks register correctly.
- [ ] Implement `dispatchDataOrder()` against the live vendor API.
- [ ] Point an uptime monitor at `/api/health`.
- [ ] Run `node scripts/smoke.mjs` against production and confirm it passes.

---

© 2026 Priceless Bundle by **LongKinnex Tech and Data**.
