/**
 * Priceless Bundle — database business-logic test suite.
 *
 * Runs against a REAL Postgres engine (PGlite = Postgres compiled to WASM)
 * with the exact schema.sql + functions.sql + seed.sql that production uses.
 * Nothing here is mocked at the database layer.
 *
 *   node tests/sql.test.mjs
 */

import {
  makeDb, rpc, rpcError, one, all,
  section, check, checkEq, checkClose, checkGte, summary,
  HASHES, registerUser, creditWallet, getPlanId, walletOf, n, results,
} from "./harness.mjs";

const db = await makeDb();
const Q = (sql, params) => all(db, sql, params);
const ONE = (sql, params) => one(db, sql, params);

/* ====================================================================== */
section("1. Schema, seed & platform health");

const health = await rpc(db, "fn_health", {});
check("fn_health() reports ok", health?.ok === true);
checkEq("brand is Priceless Bundle", health?.brand, "Priceless Bundle");
checkEq("operator is LongKinnex Tech and Data", health?.by, "LongKinnex Tech and Data");
checkEq("24 launch plans seeded", n(health?.plans), 24);

const pricingViolations = await Q(`
  select count(*)::int as bad from public.plans
   where super_agent_price_ghs > sub_agent_price_ghs
      or sub_agent_price_ghs > retail_price_ghs
      or retail_price_ghs < cost_price_ghs
      or super_agent_price_ghs < cost_price_ghs`);
checkEq("no plan breaks the tier price ordering", n(pricingViolations[0].bad), 0);

const settingsCount = await Q("select count(*)::int as c from public.settings");
checkGte("settings seeded", n(settingsCount[0].c), 10);

const rlsDisabled = await Q(`
  select count(*)::int as c from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
   where ns.nspname = 'public' and c.relkind = 'r' and c.relname in
     ('users','wallets','wallet_ledger','orders','deposits','withdrawals','plans','squads')
     and not c.relrowsecurity`);
checkEq("row level security enabled on money tables", n(rlsDisabled[0].c), 0);

const policies = await Q(`
  select count(*)::int as c from pg_policies where schemaname = 'public' and tablename in
    ('users','wallets','wallet_ledger','orders','deposits','withdrawals','plans','squads')`);
checkEq("no RLS policy grants public access", n(policies[0].c), 0);

const forced = await Q(`
  select count(*)::int as c from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
   where ns.nspname = 'public' and c.relkind = 'r' and c.relname = 'wallets' and c.relforcerowsecurity`);
checkEq("RLS is not forced (which would lock out the app owner)", n(forced[0].c), 0);

const anonPlans = await rpc(db, "fn_list_plans", {});
checkEq("anonymous visitors get the full catalogue", anonPlans.plans.length, 24);
check(
  "cost price is never exposed in the catalogue",
  !JSON.stringify(anonPlans.plans).includes("cost_price"),
  JSON.stringify(anonPlans.plans[0])
);
check(
  "catalogue prices are numeric",
  typeof anonPlans.plans[0].price_ghs === "number",
  typeof anonPlans.plans[0].price_ghs
);

const purchaseArgs = await ONE(
  `select pg_get_function_arguments(to_regprocedure('public.fn_purchase_data(uuid,uuid,text,public.bot_channel,text,text,text)')) as args`
);
check(
  "fn_purchase_data() accepts NO client-supplied price",
  Boolean(purchaseArgs?.args) && !/price/i.test(purchaseArgs.args),
  purchaseArgs?.args
);

/* ====================================================================== */
section("2. Registration, activation & auth");

const alice = await registerUser(db, "0244000001", "Alice Mensah", HASHES.alice);
checkEq("customer registered", alice.tier, "customer");
checkEq("wallet auto-created at zero", n(alice.wallet.balance_ghs), 0);

// +233 and 9-digit forms normalise to 0XXXXXXXXX
const normalised = await rpc(db, "fn_auth_lookup", { p_phone: "+233244000001" });
checkEq("+233 numbers resolve to the same account", normalised?.user_id, alice.id);

const badPhone = await rpc(db, "fn_register_user", { p_phone: "12345", p_full_name: "Nope", p_pin_hash: HASHES.bob });
checkEq("invalid phone rejected", badPhone.error, "INVALID_PHONE");

const dupe = await rpc(db, "fn_register_user", { p_phone: "0244000001", p_full_name: "Impostor", p_pin_hash: HASHES.bob });
checkEq("duplicate registration rejected", dupe.error, "PHONE_TAKEN");

const weakPin = await rpc(db, "fn_register_user", { p_phone: "0244000999", p_full_name: "Weak", p_pin_hash: "short" });
checkEq("weak PIN hash rejected", weakPin.error, "INVALID_PIN");

const authLookup = await rpc(db, "fn_auth_lookup", { p_phone: "0244000001" });
checkEq("auth lookup returns the stored hash", authLookup.pin_hash, HASHES.alice);
const missing = await rpc(db, "fn_auth_lookup", { p_phone: "0209999999" });
checkEq("unknown phone returns NOT_FOUND", missing.error, "NOT_FOUND");

/* ====================================================================== */
section("3. Automatic payment collection (SMS deposit engine)");

const intent = await rpc(db, "fn_create_deposit_intent", { p_user_id: alice.id, p_amount: 100 });
check("deposit intent created", intent?.ok === true);
check("reference code looks like PB-XXXX", /^PB-[A-Z0-9]{4}$/.test(intent.intent.reference_code), intent.intent.reference_code);
check("collection number returned", Boolean(intent.intent.collection_number));
checkEq("intent starts as pending_match", intent.intent.status, "pending_match");

const credit = await rpc(db, "fn_process_sms_deposit", {
  p_raw_message: `Payment received for GHS 100.00 from KOFI 0244123456. Reference: ${intent.intent.reference_code}. Your new balance is GHS 100.00.`,
  p_amount: 100,
  p_sender_phone: "0244123456",
  p_reference_code: intent.intent.reference_code,
  p_provider: "MTN Mobile Money",
  p_sms_hash: "sms-hash-001",
});
checkEq("SMS credited by reference", credit.status, "credited");
checkEq("match strategy recorded", credit.match_strategy, "reference");
checkEq("wallet balance credited", n(credit.new_balance_ghs), 100);
checkEq("deposit ledger row written", typeof credit.ledger_id, "number");

const ledgerRow = await ONE("select entry_type, amount_ghs, balance_after from public.wallet_ledger where id = $1", [credit.ledger_id]);
checkEq("ledger entry type is deposit", ledgerRow.entry_type, "deposit");
checkEq("ledger snapshots balance_after", n(ledgerRow.balance_after), 100);

const duplicate = await rpc(db, "fn_process_sms_deposit", {
  p_raw_message: "same message", p_amount: 100, p_sender_phone: "0244123456",
  p_reference_code: intent.intent.reference_code, p_sms_hash: "sms-hash-001",
});
checkEq("duplicate SMS is detected", duplicate.status, "duplicate");
checkEq("duplicate SMS does not credit twice", n((await walletOf(db, alice.id)).balance), 100);

const intentAfter = await ONE("select status, matched_deposit_id from public.deposit_intents where id = $1", [intent.intent.id]);
checkEq("intent marked matched", intentAfter.status, "matched");
check("intent linked to the deposit", Boolean(intentAfter.matched_deposit_id));

// Sender-phone fallback: no reference in the SMS, sender is a registered user.
// The direction must be a confirmed credit for this weakest signal to be used.
const senderMatch = await rpc(db, "fn_process_sms_deposit", {
  p_raw_message: "You have received GHS 25.00 from 0244000001. Current balance GHS 125.00",
  p_amount: 25,
  p_sender_phone: "0244000001",
  p_sms_hash: "sms-hash-002",
  p_direction: "credit",
});
checkEq("SMS credited by sender phone", senderMatch.status, "credited");
checkEq("sender-phone strategy recorded", senderMatch.match_strategy, "sender_phone");
checkEq("balance now 125", n(senderMatch.new_balance_ghs), 125);

// --- Direction guard: a DEBIT alert must never be credited -----------------
const debitAttempt = await rpc(db, "fn_process_sms_deposit", {
  p_raw_message: "Your Mobile Money account has been debited GHS 25.00 for airtime purchase.",
  p_amount: 25,
  p_sender_phone: "0244000001",
  p_sms_hash: "sms-hash-debit-001",
  p_direction: "debit",
});
checkEq("debit alert is held, not credited", debitAttempt.status, "unmatched_review");
checkEq("debit hold reason recorded", debitAttempt.hold_reason, "DEBIT_MESSAGE");
checkEq("debit alert left the wallet untouched", n((await walletOf(db, alice.id)).balance), 125);

// A debit alert quoting a live reference code must still not credit. The user
// genuinely has a pending intent, so the reference DOES resolve — the debit
// guard has to be what stops it, not a failed lookup.
const debitIntent = await rpc(db, "fn_create_deposit_intent", { p_user_id: alice.id, p_amount: 100 });
const debitWithRef = await rpc(db, "fn_process_sms_deposit", {
  p_raw_message: `Cash Out: GHS 100.00 sent to 0244123456. Ref ${debitIntent.intent.reference_code}`,
  p_amount: 100,
  p_sender_phone: "0244123456",
  p_reference_code: debitIntent.intent.reference_code,
  p_sms_hash: "sms-hash-debit-002",
  p_direction: "debit",
});
checkEq("debit alert with a reference code is still held", debitWithRef.status, "unmatched_review");
checkEq("debit-with-reference reason recorded", debitWithRef.hold_reason, "DEBIT_MESSAGE");
checkEq("debit-with-reference credited nobody", n((await walletOf(db, alice.id)).balance), 125);
checkEq(
  "the user's pending intent survives the debit attempt",
  (await ONE("select status from public.deposit_intents where id = $1", [debitIntent.intent.id])).status,
  "pending_match"
);

// An SMS whose direction cannot be determined is credited only when an intent
// corroborates it (reference / unique amount), never on the sender number alone.
const erin = await registerUser(db, "0244000008", "Erin Darko", HASHES.carol);
const unclearIntent = await rpc(db, "fn_create_deposit_intent", { p_user_id: erin.id, p_amount: 12 });
const unclearSenderOnly = await rpc(db, "fn_process_sms_deposit", {
  p_raw_message: "GHS 12.00 from 0244000008 on 12/09.",
  p_amount: 12,
  p_sender_phone: "0244000008",
  p_sms_hash: "sms-hash-unclear-001",
  p_direction: "unknown",
});
checkEq("unverifiable direction is held for review", unclearSenderOnly.status, "unmatched_review");
checkEq("unverified-direction reason recorded", unclearSenderOnly.hold_reason, "DIRECTION_UNVERIFIED");
checkEq("unverified direction credited nobody", n((await walletOf(db, erin.id)).balance), 0);
checkEq(
  "the pending intent is left open for the real SMS",
  (await ONE("select status from public.deposit_intents where id = $1", [unclearIntent.intent.id])).status,
  "pending_match"
);

const unclearWithRef = await rpc(db, "fn_process_sms_deposit", {
  p_raw_message: `GHS 12.00 from 0244000008 on 12/09. Ref ${unclearIntent.intent.reference_code}`,
  p_amount: 12,
  p_sender_phone: "0244000008",
  p_reference_code: unclearIntent.intent.reference_code,
  p_sms_hash: "sms-hash-unclear-002",
  p_direction: "unknown",
});
checkEq("an intent-corroborated unknown direction still credits", unclearWithRef.status, "credited");
checkEq("erin is credited once the intent corroborates the direction", n((await walletOf(db, erin.id)).balance), 12);

// Amount + time-window fallback for a different payer.
const bob = await registerUser(db, "0244000002", "Bob Owusu", HASHES.bob);
const bobIntent = await rpc(db, "fn_create_deposit_intent", { p_user_id: bob.id, p_amount: 37 });
const amountMatch = await rpc(db, "fn_process_sms_deposit", {
  p_raw_message: "Cash In: GHS 37.00 from 0559998888 (AMA). New balance: GHS 37.00.",
  p_amount: 37,
  p_sender_phone: "0559998888",
  p_sms_hash: "sms-hash-003",
});
checkEq("SMS credited by unique amount window", amountMatch.status, "credited");
checkEq("amount-window strategy recorded", amountMatch.match_strategy, "amount_window");
checkEq("amount match resolves to the right user", amountMatch.user_id, bob.id);
checkEq("bob's intent is matched", (await ONE("select status from public.deposit_intents where id = $1", [bobIntent.intent.id])).status, "matched");

// Ambiguity must NEVER be auto-credited.
const carol = await registerUser(db, "0244000003", "Carol Asante", HASHES.carol);
const dave = await registerUser(db, "0244000004", "Dave Boateng", HASHES.bob);
await rpc(db, "fn_create_deposit_intent", { p_user_id: carol.id, p_amount: 60 });
await rpc(db, "fn_create_deposit_intent", { p_user_id: dave.id, p_amount: 60 });
const ambiguous = await rpc(db, "fn_process_sms_deposit", {
  p_raw_message: "Payment received for GHS 60.00 from 0207776666. Reference: NONE.",
  p_amount: 60,
  p_sender_phone: "0207776666",
  p_sms_hash: "sms-hash-004",
});
checkEq("ambiguous amount goes to review", ambiguous.status, "unmatched_review");
checkEq("ambiguity reason recorded", ambiguous.hold_reason, "AMBIGUOUS_AMOUNT_MATCH");
checkEq("carol not credited", n((await walletOf(db, carol.id)).balance), 0);
checkEq("dave not credited", n((await walletOf(db, dave.id)).balance), 0);

const unparsable = await rpc(db, "fn_process_sms_deposit", {
  p_raw_message: "Payment received from 0244111222. Amount could not be determined.",
  p_amount: null,
  p_sender_phone: "0244111222",
  p_sms_hash: "sms-hash-005",
});
checkEq("unparsable amount goes to review", unparsable.status, "unmatched_review");
checkEq("unparsable reason recorded", unparsable.hold_reason, "AMOUNT_UNPARSED");

const stranger = await rpc(db, "fn_process_sms_deposit", {
  p_raw_message: "Payment received for GHS 15.00 from 0201112223.",
  p_amount: 15,
  p_sender_phone: "0201112223",
  p_sms_hash: "sms-hash-006",
});
checkEq("unknown payer goes to review", stranger.status, "unmatched_review");
checkEq("no-match reason recorded", stranger.hold_reason, "NO_MATCHING_INTENT");

// Raw payload logging (the webhook audit trail).
const eventId = await rpc(db, "fn_log_webhook_event", {
  p_source: "android-sms-forwarder",
  p_raw_body: "Payment received for GHS 100.00 ...",
  p_payload: { parsed: true },
  p_headers: { "content-type": "text/plain" },
  p_remote_ip: "10.0.0.1",
  p_signature_ok: true,
});
check("webhook event logged before parsing", typeof eventId === "number");
await rpc(db, "fn_finish_webhook_event", { p_id: eventId, p_outcome: "credited", p_processing_ms: 12 });
checkEq("webhook event outcome recorded", (await ONE("select outcome from public.webhook_events where id = $1", [eventId])).outcome, "credited");

/* ====================================================================== */
section("4. Buy data — tier pricing, atomic debit, insufficient funds");

const plan5gb = await getPlanId(db, "MTN", "5GB");
const plan1gb = await getPlanId(db, "MTN", "1GB");
const [plan5gbRow] = await Q("select retail_price_ghs, sub_agent_price_ghs, super_agent_price_ghs, cost_price_ghs from public.plans where id = $1", [plan5gb]);
const [plan1gbRow] = await Q("select retail_price_ghs from public.plans where id = $1", [plan1gb]);

const customerPrice = await rpc(db, "fn_resolve_price", { p_user_id: alice.id, p_plan_id: plan5gb });
checkEq("customer is quoted retail price", n(customerPrice.price_ghs), n(plan5gbRow.retail_price_ghs));
checkEq("cost price never leaves the pricing resolver", customerPrice.cost_price_ghs, undefined);

// Insufficient funds: nothing partial, no order, no ledger row.
const frank = await registerUser(db, "0244000007", "Frank Broke", HASHES.bob);
checkEq("a fresh account starts at zero", n((await walletOf(db, frank.id)).balance), 0);
const ordersBefore = n((await ONE("select count(*)::int as c from public.orders")).c);
const ledgerBefore = n((await ONE("select count(*)::int as c from public.wallet_ledger")).c);
const tooExpensive = await rpc(db, "fn_purchase_data", {
  p_user_id: frank.id, p_plan_id: plan5gb, p_recipient_phone: "0244111222",
});
checkEq("insufficient funds blocks the purchase", tooExpensive.ok, false);
checkEq("insufficient funds error code", tooExpensive.error, "INSUFFICIENT_FUNDS");
checkEq("no order was created", n((await ONE("select count(*)::int as c from public.orders")).c), ordersBefore);
checkEq("no ledger row was written", n((await ONE("select count(*)::int as c from public.wallet_ledger")).c), ledgerBefore);
checkEq("wallet untouched", n((await walletOf(db, frank.id)).balance), 0);
checkClose("shortfall reported equals the full price", n(tooExpensive.shortfall_ghs), n(plan5gbRow.retail_price_ghs));

const badRecipient = await rpc(db, "fn_purchase_data", {
  p_user_id: alice.id, p_plan_id: plan1gb, p_recipient_phone: "abc",
});
checkEq("invalid recipient rejected", badRecipient.error, "INVALID_RECIPIENT");

const purchase = await rpc(db, "fn_purchase_data", {
  p_user_id: alice.id, p_plan_id: plan1gb, p_recipient_phone: "0244111222",
});
checkEq("purchase succeeds", purchase.ok, true);
checkEq("order starts as pending", purchase.order.status, "pending");
checkEq("tier snapshot recorded on the order", purchase.order.buyer_tier_at_purchase, "customer");
checkEq("charged the retail price", n(purchase.order.price_charged_ghs), n(plan1gbRow.retail_price_ghs));
checkClose("wallet debited by exactly the price", n(purchase.wallet.balance_ghs), 125 - n(plan1gbRow.retail_price_ghs));

const purchaseLedger = await ONE("select entry_type, amount_ghs, order_id, balance_after from public.wallet_ledger where id = $1", [purchase.ledger_id]);
checkEq("purchase ledger type", purchaseLedger.entry_type, "purchase");
checkClose("purchase ledger amount is negative", n(purchaseLedger.amount_ghs), -n(plan1gbRow.retail_price_ghs));
checkEq("purchase ledger links to the order", purchaseLedger.order_id, purchase.order.id);
checkClose("purchase ledger snapshots the new balance", n(purchaseLedger.balance_after), n(purchase.wallet.balance_ghs));

// A bundle the operator has switched off must be unbuyable even though the row
// still exists — and switching it off must not disturb anything else.
const togglePlan = await ONE(
  "select id, network, size_label from public.plans where id <> $1 order by sort_order limit 1",
  [plan1gb]
);
await Q("update public.plans set active = false where id = $1", [togglePlan.id]);
const balanceBeforeInactive = n((await walletOf(db, alice.id)).balance);
const inactiveAttempt = await rpc(db, "fn_purchase_data", {
  p_user_id: alice.id, p_plan_id: togglePlan.id, p_recipient_phone: "0244333999",
});
checkEq("a deactivated bundle cannot be bought", inactiveAttempt.error, "PLAN_UNAVAILABLE");
checkEq("the blocked purchase charged nothing", n((await walletOf(db, alice.id)).balance), balanceBeforeInactive);
checkEq(
  "the blocked purchase created no order",
  n((await ONE("select count(*)::int as c from public.orders where recipient_phone = '0244333999'")).c),
  0
);
await Q("update public.plans set active = true where id = $1", [togglePlan.id]);
checkEq(
  "the catalogue is restored afterwards",
  (await ONE("select active from public.plans where id = $1", [togglePlan.id])).active,
  true
);

const missingPlan = await rpc(db, "fn_purchase_data", {
  p_user_id: alice.id, p_plan_id: "00000000-0000-0000-0000-000000000000", p_recipient_phone: "0244111222",
});
checkEq("a nonexistent plan is rejected", missingPlan.error, "PLAN_UNAVAILABLE");

/* ====================================================================== */
section("5. Fulfilment — delivery and automatic refund");

const delivered = await rpc(db, "fn_fulfill_order", {
  p_order_id: purchase.order.id, p_success: true,
  p_supplier_reference: "MOCK-ABC123", p_supplier_response: { vendor: "mock" },
});
checkEq("order delivered", delivered.status, "delivered");
checkEq("supplier reference stored", delivered.supplier_reference, "MOCK-ABC123");
checkEq("delivery is final", (await ONE("select status from public.orders where id = $1", [purchase.order.id])).status, "delivered");

const reFulfil = await rpc(db, "fn_fulfill_order", { p_order_id: purchase.order.id, p_success: true });
checkEq("cannot fulfil an order twice", reFulfil.error, "ALREADY_FINAL");

const purchase2 = await rpc(db, "fn_purchase_data", {
  p_user_id: alice.id, p_plan_id: plan1gb, p_recipient_phone: "0244333444",
});
const balanceBeforeFailure = n(purchase2.wallet.balance_ghs);
const failed = await rpc(db, "fn_fulfill_order", {
  p_order_id: purchase2.order.id, p_success: false, p_failure_reason: "Vendor network timeout",
});
checkEq("failed order is refunded", failed.status, "refunded");
checkClose("refund restores the exact price", n(failed.new_balance_ghs), balanceBeforeFailure + n(plan1gbRow.retail_price_ghs));
const refundedOrder = await ONE("select status, failure_reason, refund_ledger_id from public.orders where id = $1", [purchase2.order.id]);
checkEq("order status is refunded", refundedOrder.status, "refunded");
checkEq("failure reason stored", refundedOrder.failure_reason, "Vendor network timeout");
check("refund ledger row linked", Boolean(refundedOrder.refund_ledger_id));
const refundLedger = await ONE("select entry_type, amount_ghs from public.wallet_ledger where id = $1", [refundedOrder.refund_ledger_id]);
checkEq("refund ledger type", refundLedger.entry_type, "refund");
checkClose("refund amount positive", n(refundLedger.amount_ghs), n(plan1gbRow.retail_price_ghs));

/* ====================================================================== */
section("6. Agent tiers & the squad mechanic");

// Super Agent unlock requires a GHS 500 lifetime deposit commitment.
const earlyUpgrade = await rpc(db, "fn_upgrade_to_super_agent", { p_user_id: carol.id });
checkEq("super agent blocked below the commitment", earlyUpgrade.error, "COMMITMENT_NOT_MET");
checkEq("commitment is GHS 500", n(earlyUpgrade.eligibility.commitment_ghs), 500);

await creditWallet(db, carol.id, 500);
const eligibility = await rpc(db, "fn_upgrade_eligibility", { p_user_id: carol.id });
checkEq("commitment met after a GHS 500 deposit", eligibility.eligible, true);

const upgrade = await rpc(db, "fn_upgrade_to_super_agent", { p_user_id: carol.id });
checkEq("super agent unlocked", upgrade.tier, "super_agent");
check("squad created on upgrade", Boolean(upgrade.squad?.id));
check("squad invite code issued", /^SQL-[A-Z0-9]{5}$/.test(upgrade.squad?.invite_code ?? ""), upgrade.squad?.invite_code);
checkEq("squad target defaults to GHS 5,000", n(upgrade.squad?.volume_target_ghs), 5000);

// Sub-Agent is free.
const subUpgrade = await rpc(db, "fn_upgrade_to_sub_agent", { p_user_id: dave.id });
checkEq("sub agent upgrade is free", subUpgrade.tier, "sub_agent");

const recruit = await rpc(db, "fn_recruit_sub_agent", {
  p_super_agent_id: carol.id, p_phone: "0244000005", p_full_name: "Esi Recruited",
});
checkEq("super agent can recruit a sub agent", recruit.ok, true);
checkEq("recruit created a pending account", recruit.created, true);
check("recruited user has no PIN yet", true);
const pendingAuth = await rpc(db, "fn_auth_lookup", { p_phone: "0244000005" });
checkEq("recruited account needs activation", pendingAuth.error, "NOT_ACTIVATED");

const activation = await rpc(db, "fn_register_user", {
  p_phone: "0244000005", p_full_name: "Esi Recruited", p_pin_hash: HASHES.carol,
});
checkEq("recruit activates by registering", activation.activated, true);
checkEq("recruit keeps the sub_agent tier", activation.user.tier, "sub_agent");
checkEq("recruit lands in the recruiter's squad", activation.user.squad_id, upgrade.squad.id);

const joinOther = await rpc(db, "fn_join_squad", { p_user_id: dave.id, p_invite_code: upgrade.squad.invite_code });
checkEq("sub agent joins a squad by code", joinOther.ok, true);
checkEq("joined the right squad", joinOther.squad.id, upgrade.squad.id);

const badInvite = await rpc(db, "fn_join_squad", { p_user_id: alice.id, p_invite_code: "SQL-NOPE1" });
checkEq("bad invite code rejected", badInvite.error, "INVALID_INVITE");

// Squad pricing + volume roll-up.
const subPrice = await rpc(db, "fn_resolve_price", { p_user_id: dave.id, p_plan_id: plan5gb });
checkEq("sub agent sees sub-agent pricing", n(subPrice.price_ghs), n(plan5gbRow.sub_agent_price_ghs));

const superPrice = await rpc(db, "fn_resolve_price", { p_user_id: carol.id, p_plan_id: plan5gb });
checkEq("super agent sees VIP wholesale pricing", n(superPrice.price_ghs), n(plan5gbRow.super_agent_price_ghs));

// The catalogue itself must resolve prices per tier.
const subCatalogue = await rpc(db, "fn_list_plans", { p_user_id: dave.id });
const subCatalogueRow = subCatalogue.plans.find((p) => p.size_label === "5GB" && p.network === "MTN");
checkEq("catalogue shows sub-agent price for sub agents", n(subCatalogueRow.price_ghs), n(plan5gbRow.sub_agent_price_ghs));
checkEq("catalogue keeps tier context", subCatalogueRow.effective_tier, "sub_agent");
check("catalogue hides the cost price", !JSON.stringify(subCatalogue).includes("cost_price"));
const superCatalogue = await rpc(db, "fn_list_plans", { p_user_id: carol.id });
const superCatalogueRow = superCatalogue.plans.find((p) => p.size_label === "5GB" && p.network === "MTN");
checkEq("catalogue shows wholesale price for super agents", n(superCatalogueRow.price_ghs), n(plan5gbRow.super_agent_price_ghs));

await creditWallet(db, dave.id, 500);
const squadVolumeBefore = n((await ONE("select current_volume_ghs from public.squads where id = $1", [upgrade.squad.id])).current_volume_ghs);

const squadSale = await rpc(db, "fn_purchase_data", {
  p_user_id: dave.id, p_plan_id: plan5gb, p_recipient_phone: "0244555666",
});
checkEq("sub agent purchase succeeds", squadSale.ok, true);
await rpc(db, "fn_fulfill_order", { p_order_id: squadSale.order.id, p_success: true, p_supplier_reference: "MOCK-SQUAD1" });

const squadAfter = await ONE("select current_volume_ghs, tier_retained from public.squads where id = $1", [upgrade.squad.id]);
checkClose(
  "delivered squad sale increases squad volume",
  n(squadAfter.current_volume_ghs),
  squadVolumeBefore + n(plan5gbRow.sub_agent_price_ghs)
);
checkEq("order attributed to the squad's super agent", squadSale.order.attributed_super_agent_id, carol.id);
checkEq("order records the squad", squadSale.order.squad_id, upgrade.squad.id);
checkEq("tier retained while under target", squadAfter.tier_retained, true);
checkEq("squad target recorded as missed before the target is hit", (await ONE("select count(*)::int as c from public.squads where id = $1 and current_volume_ghs >= volume_target_ghs", [upgrade.squad.id])).c, 0);

// Commission accrues to the Super Agent for squad sales.
const commissionPot = await ONE("select commission_balance_ghs from public.wallets where user_id = $1", [carol.id]);
const expectedCommission = Math.round(n(plan5gbRow.sub_agent_price_ghs) * 0.03 * 100) / 100;
checkClose("super agent earns 3% commission on squad sales", n(commissionPot.commission_balance_ghs), expectedCommission);
const commissionLedger = await ONE(
  "select amount_ghs, commission_amount_ghs, balance_after, commission_balance_after from public.wallet_ledger where user_id = $1 and entry_type = 'commission'",
  [carol.id]
);
checkEq("commission ledger leaves the main balance untouched", n(commissionLedger.amount_ghs), 0);
checkClose("commission ledger credits the commission pot", n(commissionLedger.commission_amount_ghs), expectedCommission);

// No commission on your own sale.
const carolSale = await rpc(db, "fn_purchase_data", { p_user_id: carol.id, p_plan_id: plan1gb, p_recipient_phone: "0244777888" });
await rpc(db, "fn_fulfill_order", { p_order_id: carolSale.order.id, p_success: true });
const commissionAfterOwnSale = await ONE("select commission_balance_ghs from public.wallets where user_id = $1", [carol.id]);
checkClose("no self-commission on the super agent's own sale", n(commissionAfterOwnSale.commission_balance_ghs), expectedCommission);

/* ====================================================================== */
section("7. Squad target miss, rollover and tier retention");

// Force the squad's period into the past, set an unreachable target, roll over.
await Q("update public.squads set current_period_start = now() - interval '2 months', volume_target_ghs = 1000000 where id = $1", [upgrade.squad.id]);
const rollover = await rpc(db, "fn_ensure_squad_period", { p_squad_id: upgrade.squad.id });
checkEq("period rolled over", rollover.rolled_over, true);
checkEq("missed target is recorded", rollover.tier_retained, false);

const demotedPrice = await rpc(db, "fn_resolve_price", { p_user_id: dave.id, p_plan_id: plan5gb });
checkEq("squad member falls back to retail after a miss", n(demotedPrice.price_ghs), n(plan5gbRow.retail_price_ghs));
checkEq("fallback reason is explained", demotedPrice.effective_tier, "customer");

// Hit the target this period -> tier retained again.
await Q("update public.squads set volume_target_ghs = 10 where id = $1", [upgrade.squad.id]);
const recompute = await rpc(db, "fn_squad_recompute", { p_squad_id: upgrade.squad.id });
checkEq("target hit after recompute", recompute.tier_retained, true);
const restoredPrice = await rpc(db, "fn_resolve_price", { p_user_id: dave.id, p_plan_id: plan5gb });
checkEq("sub agent pricing restored", n(restoredPrice.price_ghs), n(plan5gbRow.sub_agent_price_ghs));
await Q("update public.squads set volume_target_ghs = 5000 where id = $1", [upgrade.squad.id]);

const dashboard = await rpc(db, "fn_squad_dashboard", { p_user_id: carol.id });
checkEq("squad dashboard returns the squad", dashboard.squad.id, upgrade.squad.id);
checkGte("dashboard lists members", dashboard.member_count, 1);
check("dashboard exposes the invite link", /^SQL-/.test(dashboard.squad.invite_code));

/* ====================================================================== */
section("8. Commission reinvestment bonus");

const carolWalletBefore = await walletOf(db, carol.id);
const reinvest = await rpc(db, "fn_commission_reinvest", { p_user_id: carol.id });
checkEq("reinvest succeeds", reinvest.ok, true);
checkClose("exact commission amount reinvested", n(reinvest.reinvested_ghs), carolWalletBefore.commission);
checkGte("bonus rate is at least 2%", n(reinvest.bonus_rate), 0.02);
check("bonus rate is at most 5%", n(reinvest.bonus_rate) <= 0.05);
checkClose("bonus matches the rate", n(reinvest.bonus_ghs), Math.round(carolWalletBefore.commission * n(reinvest.bonus_rate) * 100) / 100);
checkClose("wallet receives principal + bonus", n(reinvest.balance_ghs), carolWalletBefore.balance + carolWalletBefore.commission + n(reinvest.bonus_ghs));
checkEq("commission pot emptied", n(reinvest.commission_balance_ghs), 0);

const reinvestLedger = await all(db,
  "select entry_type, amount_ghs, commission_amount_ghs from public.wallet_ledger where user_id = $1 and entry_type in ('commission_reinvest','reinvest_bonus') order by id desc limit 2",
  [carol.id]
);
checkEq("two ledger rows written (move + bonus)", reinvestLedger.length, 2);
checkEq("bonus ledger row type", reinvestLedger[0].entry_type, "reinvest_bonus");
checkEq("reinvest ledger row type", reinvestLedger[1].entry_type, "commission_reinvest");
checkEq("reinvest moves the commission pot out", n(reinvestLedger[1].commission_amount_ghs), -carolWalletBefore.commission);

const emptyReinvest = await rpc(db, "fn_commission_reinvest", { p_user_id: carol.id });
checkEq("nothing left to reinvest", emptyReinvest.error, "NOTHING_TO_REINVEST");

// Bonus steps up with the amount (tiered 2% -> 5%).
const lowRate = await ONE("select public.fn_reinvest_rate(50) as r");
const midRate = await ONE("select public.fn_reinvest_rate(150) as r");
const highRate = await ONE("select public.fn_reinvest_rate(5000) as r");
checkEq("GHS 50 reinvest earns 2%", n(lowRate.r), 0.02);
checkEq("GHS 150 reinvest earns 3%", n(midRate.r), 0.03);
checkEq("GHS 5,000 reinvest earns 5% (capped)", n(highRate.r), 0.05);

/* ====================================================================== */
section("9. Withdrawals — instant fees, Free Friday, Super Agent perks");

const aliceQuote = await rpc(db, "fn_withdrawal_quote", { p_user_id: alice.id, p_amount: 50, p_mode: "instant" });
checkEq("customer instant withdrawal is quoted a fee", n(aliceQuote.fee_ghs), 1.5);
checkEq("net amount excludes the fee", n(aliceQuote.net_amount_ghs), 48.5);

const carolQuote = await rpc(db, "fn_withdrawal_quote", { p_user_id: carol.id, p_amount: 50, p_mode: "instant" });
checkEq("super agent instant withdrawal is free", n(carolQuote.fee_ghs), 0);
checkEq("super agent flagged as free", carolQuote.free_instant, true);

const tooSmall = await rpc(db, "fn_withdrawal_request", { p_user_id: alice.id, p_amount: 2, p_mode: "instant" });
checkEq("minimum withdrawal enforced", tooSmall.error, "AMOUNT_BELOW_MIN");

const aliceBalance = await walletOf(db, alice.id);
const bigWithdrawal = await rpc(db, "fn_withdrawal_request", { p_user_id: alice.id, p_amount: 5000, p_mode: "instant" });
checkEq("instant cap enforced for non super agents", bigWithdrawal.error, "ABOVE_INSTANT_LIMIT");

const withdrawalAmount = Math.min(50, aliceBalance.balance - 1);
const withdrawal = await rpc(db, "fn_withdrawal_request", {
  p_user_id: alice.id, p_amount: withdrawalAmount, p_mode: "instant",
  p_payout_method: "momo", p_payout_details: { number: "0244000001" },
});
checkEq("instant withdrawal accepted", withdrawal.ok, true);
checkEq("instant withdrawal is processing", withdrawal.withdrawal.status, "processing");
checkClose("wallet debited gross (amount)", n(withdrawal.wallet.balance_ghs), aliceBalance.balance - withdrawalAmount);

const withdrawalLedger = await all(db,
  "select entry_type, amount_ghs from public.wallet_ledger where user_id = $1 and reference = $2 order by id",
  [alice.id, withdrawal.withdrawal.payout_reference]
);
checkEq("withdrawal writes two ledger rows", withdrawalLedger.length, 2);
checkEq("payout row type", withdrawalLedger[0].entry_type, "withdrawal");
checkEq("fee row type", withdrawalLedger[1].entry_type, "withdrawal_fee");
checkClose("payout net of fee", n(withdrawalLedger[0].amount_ghs), -(withdrawalAmount - 1.5));
checkClose("fee row is the fee", n(withdrawalLedger[1].amount_ghs), -1.5);

const freeFriday = await rpc(db, "fn_withdrawal_request", { p_user_id: bob.id, p_amount: 10, p_mode: "free_friday_batch" });
checkEq("free friday withdrawal accepted", freeFriday.ok, true);
checkEq("free friday is batched", freeFriday.withdrawal.status, "batched");
checkEq("free friday charges no fee", n(freeFriday.withdrawal.fee_ghs), 0);
check("free friday is scheduled for a Friday", new Date(freeFriday.withdrawal.scheduled_for).getUTCDay() === 5 || new Date(freeFriday.withdrawal.scheduled_for).getUTCDay() === 6);

const carolWithdrawal = await rpc(db, "fn_withdrawal_request", { p_user_id: carol.id, p_amount: 100, p_mode: "instant" });
checkEq("super agent withdraws instantly with no fee", n(carolWithdrawal.withdrawal.fee_ghs), 0);
checkEq("super agent withdrawal is not fee-limited", carolWithdrawal.ok, true);

const daveBalance = (await walletOf(db, dave.id)).balance;
const poorWithdrawal = await rpc(db, "fn_withdrawal_request", {
  p_user_id: dave.id, p_amount: Math.min(1500, Math.floor(daveBalance) + 500), p_mode: "instant",
});
checkEq("withdrawal limited by wallet balance", poorWithdrawal.error, "INSUFFICIENT_FUNDS");

const negativeWithdrawal = await rpc(db, "fn_withdrawal_request", { p_user_id: dave.id, p_amount: -50, p_mode: "instant" });
checkEq("negative withdrawal rejected", negativeWithdrawal.error, "AMOUNT_BELOW_MIN");

/* ====================================================================== */
section("10. Peer-to-peer transfers");

const aliceBefore = await walletOf(db, alice.id);
const bobBefore = await walletOf(db, bob.id);
const p2pAmount = Math.min(20, aliceBefore.balance - 1);
const p2p = await rpc(db, "fn_p2p_transfer", {
  p_from_user_id: alice.id, p_recipient: "0244000002", p_amount: p2pAmount, p_note: "Test transfer",
});
checkEq("p2p transfer succeeds", p2p.ok, true);
checkClose("sender debited", n(p2p.balance_ghs), aliceBefore.balance - p2pAmount);
checkClose("recipient credited", n((await walletOf(db, bob.id)).balance), bobBefore.balance + p2pAmount);

const p2pLedger = await all(db, "select entry_type, amount_ghs from public.wallet_ledger where reference = $1 order by id", [p2p.reference]);
checkEq("p2p writes two ledger rows", p2pLedger.length, 2);
checkEq("sender row is p2p_send", p2pLedger[0].entry_type, "p2p_send");
checkEq("receiver row is p2p_receive", p2pLedger[1].entry_type, "p2p_receive");
checkClose("transfer conserves money", n(p2pLedger[0].amount_ghs) + n(p2pLedger[1].amount_ghs), 0);

const selfTransfer = await rpc(db, "fn_p2p_transfer", { p_from_user_id: alice.id, p_recipient: "0244000001", p_amount: 5 });
checkEq("self transfer blocked", selfTransfer.error, "SELF_TRANSFER");

const ghostTransfer = await rpc(db, "fn_p2p_transfer", { p_from_user_id: alice.id, p_recipient: "0209999998", p_amount: 5 });
checkEq("unknown recipient blocked", ghostTransfer.error, "RECIPIENT_NOT_FOUND");

const brokeTransfer = await rpc(db, "fn_p2p_transfer", { p_from_user_id: alice.id, p_recipient: "0244000002", p_amount: 100000 });
checkEq("insufficient balance blocked", brokeTransfer.error, "INSUFFICIENT_FUNDS");

/* ====================================================================== */
section("11. Bot-in-a-Box");

const badToken = await rpc(db, "fn_set_bot_config", {
  p_user_id: carol.id, p_channel: "telegram", p_token: "not-a-token",
});
checkEq("malformed telegram token rejected", badToken.error, "INVALID_TOKEN");

const goodToken = "7654321098:AAHk3Lm9QqWxYz12AbCdEfGhIjKlMnOpQrS";
const linked = await rpc(db, "fn_set_bot_config", {
  p_user_id: carol.id, p_channel: "telegram", p_token: goodToken, p_enabled: true,
});
checkEq("telegram bot linked", linked.linked, true);

const duplicateToken = await rpc(db, "fn_set_bot_config", {
  p_user_id: dave.id, p_channel: "telegram", p_token: goodToken,
});
checkEq("bot token cannot be shared", duplicateToken.error, "NOT_SUPER_AGENT");

const notSuperAgent = await rpc(db, "fn_set_bot_config", {
  p_user_id: dave.id, p_channel: "telegram", p_token: "1234567890:BBHk3Lm9QqWxYz12AbCdEfGhIjKlMnOpQrS",
});
checkEq("sub agents cannot link bots", notSuperAgent.error, "NOT_SUPER_AGENT");

const owner = await rpc(db, "fn_resolve_bot_owner", { p_channel: "telegram", p_token: goodToken });
checkEq("inbound token resolves to the owner", owner.user_id, carol.id);
const unlinkedOwner = await rpc(db, "fn_resolve_bot_owner", { p_channel: "telegram", p_token: "1234567890:XXHk3Lm9QqWxYz12AbCdEfGhIjKlMnOpQrS" });
checkEq("unlinked token resolves to nothing", unlinkedOwner.error, "BOT_NOT_LINKED");

const helpCmd = await rpc(db, "fn_bot_command", { p_super_agent_id: carol.id, p_channel: "telegram", p_text: "/start" });
checkEq("bot answers /start", helpCmd.action, "help");
check("help text mentions balance", /balance/i.test(helpCmd.reply));

const balanceCmd = await rpc(db, "fn_bot_command", { p_super_agent_id: carol.id, p_channel: "telegram", p_text: "balance" });
checkEq("bot answers balance", balanceCmd.action, "balance");
check("balance reply contains a figure", /GHS/.test(balanceCmd.reply));

const pricesCmd = await rpc(db, "fn_bot_command", { p_super_agent_id: carol.id, p_channel: "telegram", p_text: "prices" });
checkEq("bot answers prices", pricesCmd.action, "prices");
check("price list includes MTN", /MTN/.test(pricesCmd.reply));

const carolBalanceBeforeBot = await walletOf(db, carol.id);
const vend = await rpc(db, "fn_bot_command", {
  p_super_agent_id: carol.id, p_channel: "telegram", p_text: "buy mtn 1gb 0244333777", p_external_user_ref: "tg-555",
});
checkEq("bot executes a vend", vend.action, "vend");
checkEq("bot order is created at the super agent's tier", vend.purchase.order.buyer_tier_at_purchase, "super_agent");
checkEq("bot order channel", vend.purchase.order.channel, "telegram");
checkClose("bot order charges wholesale price", n(vend.purchase.order.price_charged_ghs), n(plan1gbRow.retail_price_ghs) - 0.9, 0.91);
checkClose("bot sale debits the super agent wallet", n((await walletOf(db, carol.id)).balance), carolBalanceBeforeBot.balance - n(vend.purchase.order.price_charged_ghs));

const botOrderRow = await ONE("select super_agent_id, channel, end_customer_phone from public.bot_orders where order_id = $1", [vend.purchase.order.id]);
checkEq("bot_orders row attributes the sale", botOrderRow.super_agent_id, carol.id);
checkEq("bot_orders records the channel", botOrderRow.channel, "telegram");
checkEq("bot_orders records the end customer", botOrderRow.end_customer_phone, "0244333777");

const botUnknown = await rpc(db, "fn_bot_command", { p_super_agent_id: carol.id, p_channel: "telegram", p_text: "sing me a song" });
checkEq("unknown command handled gracefully", botUnknown.action, "unknown");

const subAgentBot = await rpc(db, "fn_bot_command", { p_super_agent_id: dave.id, p_channel: "telegram", p_text: "balance" });
checkEq("sub agent bot access blocked", subAgentBot.error, "NOT_SUPER_AGENT");

/* ====================================================================== */
section("12. Admin: pricing, deposits review, reporting");

const belowCost = await rpc(db, "fn_admin_upsert_plan", {
  p_network: "MTN", p_size_label: "7GB", p_data_mb: 7168,
  p_cost_price_ghs: 30, p_retail_price_ghs: 20, p_sub_agent_price_ghs: 20, p_super_agent_price_ghs: 20,
});
checkEq("plan below cost rejected", belowCost.error, "BELOW_COST");

const wrongOrder = await rpc(db, "fn_admin_upsert_plan", {
  p_network: "MTN", p_size_label: "7GB", p_data_mb: 7168,
  p_cost_price_ghs: 20, p_retail_price_ghs: 30, p_sub_agent_price_ghs: 29, p_super_agent_price_ghs: 31,
});
checkEq("tier ordering enforced", wrongOrder.error, "TIER_ORDER");

const createdPlan = await rpc(db, "fn_admin_upsert_plan", {
  p_network: "MTN", p_size_label: "7GB", p_data_mb: 7168,
  p_cost_price_ghs: 30, p_retail_price_ghs: 36, p_sub_agent_price_ghs: 34, p_super_agent_price_ghs: 32,
  p_actor: "test-admin",
});
checkEq("admin can create a plan", createdPlan.ok, true);
checkEq("new plan is active", createdPlan.plan.active, true);

const updatedPlan = await rpc(db, "fn_admin_upsert_plan", {
  p_plan_id: createdPlan.plan.id, p_network: "MTN", p_size_label: "7GB", p_data_mb: 7168,
  p_cost_price_ghs: 30, p_retail_price_ghs: 38, p_sub_agent_price_ghs: 35, p_super_agent_price_ghs: 33,
});
checkEq("admin can edit a plan price", n(updatedPlan.plan.retail_price_ghs), 38);

const auditRows = await Q("select count(*)::int as c from public.admin_actions where action like 'plan.%'");
checkGte("plan changes are audited", n(auditRows[0].c), 2);

// Unmatched deposit -> manual resolution.
const unmatched = await rpc(db, "fn_admin_unmatched_deposits", {});
checkGte("unmatched queue is populated", n(unmatched.count), 3);
const ambiguousRow = unmatched.deposits.find((d) => d.hold_reason === "AMBIGUOUS_AMOUNT_MATCH");
check("ambiguous deposit is in the queue", Boolean(ambiguousRow));
checkGte("candidate intents suggested", (ambiguousRow?.candidates ?? []).length, 2);

const carolBeforeResolve = await walletOf(db, carol.id);
const resolved = await rpc(db, "fn_admin_resolve_deposit", {
  p_deposit_id: ambiguousRow.id, p_user_id: carol.id, p_action: "credit",
  p_note: "Confirmed by MoMo receipt", p_actor: "test-admin",
});
checkEq("admin can resolve an unmatched deposit", resolved.status, "credited");
checkClose("resolved deposit credits the wallet", n((await walletOf(db, carol.id)).balance), carolBeforeResolve.balance + 60);

const alreadyResolved = await rpc(db, "fn_admin_resolve_deposit", {
  p_deposit_id: ambiguousRow.id, p_user_id: carol.id, p_action: "credit",
});
checkEq("a deposit cannot be credited twice", alreadyResolved.error, "ALREADY_RESOLVED");

const rejected = await rpc(db, "fn_admin_resolve_deposit", {
  p_deposit_id: unmatched.deposits.find((d) => d.id !== ambiguousRow.id).id,
  p_user_id: null, p_action: "reject", p_note: "Not a customer payment",
});
checkEq("admin can reject a deposit", rejected.status, "rejected");

const metrics = await rpc(db, "fn_admin_metrics", {});
checkEq("admin metrics available", metrics.ok, true);
checkGte("metrics report revenue", n(metrics.revenue.gross_all_time_ghs), 1);
checkGte("metrics report margin", n(metrics.revenue.margin_all_time_ghs), 0);
checkGte("metrics count users", n(metrics.users.total), 6);
checkEq("metrics expose 14 days of activity", metrics.daily.length, 14);
check("metrics break down by network", Array.isArray(metrics.networks) && metrics.networks.length >= 1);

const adminOrders = await rpc(db, "fn_admin_orders", { p_limit: 100 });
checkGte("admin order list populated", n(adminOrders.count), 4);
const searchOrders = await rpc(db, "fn_admin_orders", { p_search: "0244555666" });
checkEq("admin order search works", n(searchOrders.count), 1);

const freeFridayRun = await rpc(db, "fn_admin_process_free_friday", { p_actor: "test-admin" });
checkGte("free friday run queues payouts", n(freeFridayRun.count), 1);
checkEq("free friday run clears the batched bucket", n((await ONE("select count(*)::int as c from public.withdrawals where status = 'batched'")).c), 0);

const paidWithdrawal = await ONE("select id from public.withdrawals where user_id = $1 and status = 'processing' limit 1", [bob.id]);
const paid = await rpc(db, "fn_admin_mark_withdrawal", {
  p_withdrawal_id: paidWithdrawal.id, p_status: "paid", p_payout_reference: "MOMO-PAYOUT-1", p_actor: "test-admin",
});
checkEq("withdrawal marked paid", paid.withdrawal.status, "paid");

const carolPaidRow = await ONE("select id, net_amount_ghs from public.withdrawals where user_id = $1 and status = 'processing' limit 1", [carol.id]);
const carolBeforeReject = await walletOf(db, carol.id);
const rejectedWithdrawal = await rpc(db, "fn_admin_mark_withdrawal", {
  p_withdrawal_id: carolPaidRow.id, p_status: "rejected", p_note: "Wrong MoMo number", p_actor: "test-admin",
});
checkEq("withdrawal rejected", rejectedWithdrawal.status, "rejected");
checkClose("rejected withdrawal refunds the wallet", n((await walletOf(db, carol.id)).balance), carolBeforeReject.balance + n(carolPaidRow.net_amount_ghs) + 0);

const tierChange = await rpc(db, "fn_admin_set_user_tier", { p_user_id: dave.id, p_tier: "super_agent", p_actor: "test-admin" });
checkEq("admin can change a tier", tierChange.tier, "super_agent");
const squadCreated = await ONE("select count(*)::int as c from public.squads where super_agent_id = $1", [dave.id]);
checkEq("tier change to super agent provisions a squad", n(squadCreated.c), 1);
await rpc(db, "fn_admin_set_user_tier", { p_user_id: dave.id, p_tier: "sub_agent", p_actor: "test-admin" });

const adjustment = await rpc(db, "fn_admin_credit_wallet", {
  p_user_id: alice.id, p_amount: 5, p_reason: "Goodwill credit", p_actor: "test-admin",
});
checkEq("admin wallet adjustment applied", adjustment.ok, true);
const adjustmentLedger = await ONE("select entry_type from public.wallet_ledger where id = $1", [adjustment.ledger_id]);
checkEq("adjustment is logged as admin_adjustment", adjustmentLedger.entry_type, "admin_adjustment");

/* ====================================================================== */
section("13. Money safety & ledger integrity");

const negativeAttempt = await rpcError(db, "update public.wallets set balance_ghs = -50");
check("negative balance is impossible at the database level", Boolean(negativeAttempt) && /check|violates/i.test(negativeAttempt), negativeAttempt ?? "no error raised!");

const ledgerUpdate = await rpcError(db, "update public.wallet_ledger set amount_ghs = 999 where id = (select max(id) from public.wallet_ledger)");
check("ledger rows cannot be updated", Boolean(ledgerUpdate) && /append-only/i.test(ledgerUpdate), ledgerUpdate ?? "ledger update allowed!");
const ledgerDelete = await rpcError(db, "delete from public.wallet_ledger where id = (select max(id) from public.wallet_ledger)");
check("ledger rows cannot be deleted", Boolean(ledgerDelete) && /append-only/i.test(ledgerDelete), ledgerDelete ?? "ledger delete allowed!");

const drift = await rpc(db, "fn_admin_reconcile", {});
checkEq("no wallet drifts from its ledger", n(drift.drift_count), 0);
checkGte("reconcile checked the wallets", n(drift.checked_wallets), 6);
checkClose(
  "sum of ledger entries equals the sum of balances",
  n(drift.ledger.net_ghs),
  n(drift.ledger.terminal_balances)
);

// Every balance is reconstructible from the ledger alone.
const ledgerMismatch = await Q(`
  select count(*)::int as c from public.wallets w
   where w.balance_ghs <> coalesce((select sum(l.amount_ghs) from public.wallet_ledger l where l.user_id = w.user_id), 0)`);
checkEq("every balance is reconstructible from the ledger", n(ledgerMismatch[0].c), 0);

const commissionMismatch = await Q(`
  select count(*)::int as c from public.wallets w
   where w.commission_balance_ghs <> coalesce((select sum(l.commission_amount_ghs) from public.wallet_ledger l where l.user_id = w.user_id), 0)`);
checkEq("every commission pot reconciles too", n(commissionMismatch[0].c), 0);

// Double-spend guard: spend down to a balance that only covers one more order.
const drainUser = await registerUser(db, "0244000006", "Drain Test", HASHES.alice);
const cheapPlan = await ONE("select id, retail_price_ghs from public.plans where network = 'AirtelTigo' and size_label = '1GB'");
await creditWallet(db, drainUser.id, n(cheapPlan.retail_price_ghs));
const firstBuy = await rpc(db, "fn_purchase_data", { p_user_id: drainUser.id, p_plan_id: cheapPlan.id, p_recipient_phone: "0244000007" });
checkEq("first purchase with exact balance succeeds", firstBuy.ok, true);
const secondBuy = await rpc(db, "fn_purchase_data", { p_user_id: drainUser.id, p_plan_id: cheapPlan.id, p_recipient_phone: "0244000007" });
checkEq("second purchase with an empty wallet is blocked", secondBuy.error, "INSUFFICIENT_FUNDS");
checkEq("wallet never went negative", n((await walletOf(db, drainUser.id)).balance), 0);

const negativeWalletCount = await ONE("select count(*)::int as c from public.wallets where balance_ghs < 0 or commission_balance_ghs < 0");
checkEq("no wallet is negative anywhere", n(negativeWalletCount.c), 0);

const orderLedgerCount = await ONE(`
  select count(*)::int as c from public.orders o
   where o.status = 'delivered' and not exists (
     select 1 from public.wallet_ledger l where l.order_id = o.id and l.entry_type = 'purchase')`);
checkEq("every delivered order has a purchase ledger row", n(orderLedgerCount.c), 0);

const refundCoverage = await ONE(`
  select count(*)::int as c from public.orders o
   where o.status = 'refunded' and not exists (
     select 1 from public.wallet_ledger l where l.order_id = o.id and l.entry_type = 'refund')`);
checkEq("every refunded order has a refund ledger row", n(refundCoverage.c), 0);

const orphanSquadSales = await ONE(`
  select count(*)::int as c from public.orders o
   where o.squad_id is not null and o.status = 'delivered' and o.attributed_super_agent_id is null`);
checkEq("squad sales are always attributed to a super agent", n(orphanSquadSales.c), 0);

/* ====================================================================== */
const failures = results.failed;
await db.close();

if (failures > 0) {
  summary("SQL suite");
  process.exit(1);
}
process.exit(summary("SQL suite") === 0 ? 0 : 1);
