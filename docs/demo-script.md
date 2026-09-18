# Demo script — Phase 3: WhatsApp webhook

Reproducible verification steps for the `whatsapp-webhook` backend function.
Replace `<VERIFY_TOKEN>` and `<APP_SECRET>` with the real values stored via
`supabase_add_secret` — never commit real secret values here.

Base URL: `https://spb-t4nh1r2458mb8j8t.supabase.opentrust.net/functions/v1/whatsapp-webhook`

## 1. GET verification handshake

```bash
BASE="https://spb-t4nh1r2458mb8j8t.supabase.opentrust.net/functions/v1/whatsapp-webhook"

# Correct token -> 200, echoes the challenge
curl -s -o /tmp/out.txt -w "HTTP_STATUS:%{http_code}" "$BASE?hub.mode=subscribe&hub.verify_token=<VERIFY_TOKEN>&hub.challenge=CHALLENGE_ACCEPTED_123"; cat /tmp/out.txt

# Wrong token -> 403, no challenge echoed
curl -s -o /tmp/out.txt -w "HTTP_STATUS:%{http_code}" "$BASE?hub.mode=subscribe&hub.verify_token=wrong-token&hub.challenge=SHOULD_NOT_APPEAR"; cat /tmp/out.txt
```

## 2. POST with a valid signed payload

```bash
cat > /tmp/payload.json << 'EOF'
{"entry":[{"changes":[{"value":{"messages":[{"from":"911234567890","id":"wamid.TESTMSG001","timestamp":"1700000000","type":"text","text":{"body":"Hi"}}],"contacts":[{"wa_id":"911234567890","profile":{"name":"Test User"}}]}}]}]}
EOF

APP_SECRET="<APP_SECRET>"
BODY=$(cat /tmp/payload.json)
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$APP_SECRET" | sed 's/^.* //')

curl -s -w "HTTP_STATUS:%{http_code}" -X POST "$BASE" -H "Content-Type: application/json" -H "X-Hub-Signature-256: sha256=$SIG" --data-raw "$BODY"
# Expect: {"received":true} / HTTP 200
```

Verify the write in the database:

```sql
select * from conversation_sessions where wa_id = '911234567890';
select * from conversation_messages
  where session_id in (select id from conversation_sessions where wa_id = '911234567890')
  order by created_at;
-- Expect: one session, one inbound row ("Hi"), one outbound row (the main menu text)
```

## 3. POST with an invalid signature (negative test)

```bash
curl -s -w "HTTP_STATUS:%{http_code}" -X POST "$BASE" -H "Content-Type: application/json" -H "X-Hub-Signature-256: sha256=0000000000000000000000000000000000000000000000000000000000000000" --data-raw "$BODY"
# Expect: "Invalid signature" / HTTP 401, and no new rows written to either table
```

## 4. Live end-to-end test (real Meta credentials)

1. In Meta's App Dashboard, WhatsApp, Configuration: set the callback URL to the base URL above and the verify token to the value stored as `WHATSAPP_VERIFY_TOKEN`.
2. Subscribe to the `messages` webhook field.
3. From a real WhatsApp number, send "Hi" to the connected test business number.
4. Expect the 8-item main menu back within a few seconds; sending arbitrary text gets an echo/not-yet-implemented notice; sending an image gets an acknowledgement-only reply.

Verified live on 2026-09-18 — see the architecture plan's Phase 3 verification checklist.

## Status of later phases

Invoice analysis, duplicate/vendor/anomaly detection, the decision
engine, Q&A, alerts, and forecasting are not yet wired into this webhook.
They currently exist only as the client-side demo at `/assistant`
(`src/lib/fincore/*`, `src/data/fincoreStore.ts`) and will be ported to
real backend functions phase by phase, per
`.enter/plans/fincore-ai-architecture.md`.

---

# Demo script — Phase 4: Onboarding + account creation

Requires `RESEND_API_KEY` in addition to the Phase 3 WhatsApp secrets.
Replace `<APP_SECRET>` with the real value.

## 1. Full onboarding conversation (new company)

Send each message as a separate signed POST (see the `send()` helper pattern
from Phase 3, one request at a time — do not batch requests in a loop with
`date`-based unique IDs, which was flaky in testing):

```bash
BASE="https://spb-t4nh1r2458mb8j8t.supabase.opentrust.net/functions/v1/whatsapp-webhook"
APP_SECRET="<APP_SECRET>"
WAID="<a wa_id never seen before>"

send() {
  local text="$1" id="$2"
  local body='{"entry":[{"changes":[{"value":{"messages":[{"from":"'"$WAID"'","id":"wamid.'"$id"'","timestamp":"1700000000","type":"text","text":{"body":"'"$text"'"}}]}}]}]}'
  local sig=$(printf '%s' "$body" | openssl dgst -sha256 -hmac "$APP_SECRET" | sed 's/^.* //')
  curl -s --max-time 30 -w "\nHTTP_STATUS:%{http_code}\n" -X POST "$BASE" -H "Content-Type: application/json" -H "X-Hub-Signature-256: sha256=$sig" --data-raw "$body"
}

send "Hi" "1"                                # -> onboarding_name
send "Your Name" "2"                          # -> onboarding_company
send "Your Company Name" "3"                  # -> onboarding_role (new or existing company detected here)
send "Your Role" "4"                          # -> onboarding_industry
send "Your Industry" "5"                      # -> onboarding_spend
send "500000" "6"                             # -> onboarding_email
send "you@example.com" "7"                    # -> onboarding_otp (OTP emailed via Resend)
```

Check progress at any point:

```sql
select state, context from conversation_sessions where wa_id = '<WAID>';
select id, otp_hash, status, attempt_count from otp_sessions where destination = '<the email used>';
```

## 2. Completing verification

With the real Resend sandbox sender, the code only reliably reaches the
developer's own verified Resend account email — check that inbox for the
6-digit code, then:

```bash
send "<the 6-digit code>" "8"
```

Expect the reply to include "Your FinCore account has been created." followed
by the main menu. Verify:

```sql
select * from companies where company_id = (select context->>'resolvedCompanyId' from conversation_sessions where wa_id = '<WAID>');
select * from users where email = '<the email used>';
select * from auth_methods where value = '<the email used>';
select * from whatsapp_accounts where wa_id = '<WAID>';
```

## 3. Negative / boundary cases verified during Phase 4 development

- Invalid email (no `@`) at the `onboarding_email` step re-prompts without creating an `otp_sessions` row or advancing state.
- A wrong OTP code increments `otp_sessions.attempt_count` and creates no account rows.
- 5 wrong OTP codes in a row sets `otp_sessions.status='locked'` and resets the session to `state='new'`.
- Typing a company name that case-insensitively matches an existing company (tested against both a freshly-created company and a real CSV-seeded company, e.g. "nimbusworks pvt ltd" -> `COMP-01`) joins as `role='viewer'` against the existing `company_id` — no duplicate company row.
- A brand-new company name creates exactly one new `companies` row and the joining user gets `role='admin'`.
- A `wa_id` that already completed onboarding (has an active `whatsapp_accounts` link) skips onboarding entirely on its next message and gets the Phase 3 menu/echo behavior instead.
- Typing "login" or "recover account" from an unidentified sender returns a "coming in a later phase" reply instead of being swallowed into the `name` field.

All of the above were verified via direct `supabase_read_query` checks against the real database during development (2026-09-18), then the test rows were deleted. A live end-to-end run from a real, never-before-seen WhatsApp number is still recommended before considering this phase fully demo-ready.

---

# Demo script — Phase 5: OTP account recovery + number linking

Recovery is available for an unlinked WhatsApp number. It verifies the registered recovery email, then links the number to the existing FinCore account.

## 1. Recovery conversation

From an unlinked WhatsApp number, send these messages as separate signed webhook POSTs (or use a real WhatsApp number):

```bash
send "login" "recovery-1"                    # -> recovery_email
send "registered@example.com" "recovery-2"   # -> recovery_otp; OTP is emailed
send "<the 6-digit code>" "recovery-3"       # -> Welcome back + main menu
```

For a real live test, use the recovery email that was verified during onboarding. The sender number becomes the active WhatsApp link for that existing user.

## 2. Database checks

```sql
select state, context from conversation_sessions where wa_id = '<new wa_id>';
select status, user_id, wa_id, phone_number, linked_at
  from whatsapp_accounts where user_id = '<existing user id>' order by linked_at desc;
select event_type, success, user_id, timestamp
  from auth_log where user_id = '<existing user id>' order by timestamp desc;
```

Expect the new number to be `active`, the prior active number to be `unlinked`, the session to be `active`, and `auth_log` entries for `otp_requested`, `otp_verified`, and `login_success`.

## 3. Recovery security cases

- An unknown email stays in `recovery_email` and does not create an OTP session.
- A locked or suspended account is rejected and the conversation resets to `new`.
- Five incorrect codes mark the OTP `locked`, mark the user account `Locked`, write `account_locked`, and reset the conversation.
- A sixth recovery OTP request from the same WhatsApp number within one hour is blocked without creating another OTP session.
- OTP values and internal email/API errors are never included in WhatsApp replies.

Phase 5 was live-verified on 2026-09-18: the existing Phase 4 test account received an OTP by email, accepted the code from WhatsApp, reused its unique existing phone-number row safely, and received the `Welcome back` reply plus the main menu.

---

# Demo script — Phase 6: WhatsApp invoice upload + Enter Cloud Storage

Phase 6 accepts invoice media from an active WhatsApp account only. OCR and financial extraction are intentionally deferred to Phase 7.

## 1. Live WhatsApp upload

1. From a WhatsApp number with an active FinCore account, send a PDF, JPG, or PNG invoice to the FinCore business number.
2. Keep the file at or below 10 MB.
3. Expect a reply containing `Invoice INV-... received and queued for analysis.`
4. The uploaded original is stored privately under `invoices/{company_id}/{invoice_id}.{ext}` in the `fincore-invoices` bucket.

## 2. Database checks

```sql
select invoice_id, company_id, vendor_id, status, source_channel,
       file_storage_path, subtotal, tax_amount, total_amount, submitted_by
  from invoices
 where source_channel = 'whatsapp_bot'
 order by submitted_at desc;

select vendor_id, company_id, name
  from vendors
 where name = 'Pending Vendor';
```

Expect `status='Pending'`, `source_channel='whatsapp_bot'`, a private `file_storage_path`, zero financial totals pending extraction, and one reusable company-scoped `Pending Vendor`.

## 3. Rejection cases

- A file over 10 MB is rejected without an invoice row or stored object.
- A non-PDF/JPG/PNG file is rejected without an invoice row or stored object.
- An unlinked number sending media receives onboarding guidance and does not create an invoice.
- Meta download errors return a safe retry message; internal Graph/Storage/database details are logged server-side only.

---

# Demo script — Phase 8: Duplicate detection + vendor intelligence

After a successful image extraction, FinCore now sends a second message with deterministic history-based intelligence.

## 1. WhatsApp response

Expect two final lines after the OCR interim message:

- `Duplicate score: <0-100>%` with the strongest match evidence when available.
- `Vendor risk: Low|Medium|High (<score>/100)` with the strongest computed reason.

The invoice remains `Pending`; Phase 8 does not approve or reject it.

## 2. Database checks

```sql
select invoice_id, duplicate_score, duplicate_evidence,
       vendor_risk_snapshot
  from invoice_analysis
 where invoice_id = '<invoice id>';
```

Duplicate scoring compares the same-company, same-vendor history using invoice number, amount, date, purchase order, and description signals. Vendor risk uses vendor status, spend history, recent activity, completed payment timing, prior duplicate flags, and recent bank changes.

The `whatsapp_message_receipts` table makes Meta message processing idempotent. If Meta retries the same inbound message ID, no second invoice or reply is created.

---

# Demo script — Phase 9: Budget impact + anomaly detection

After duplicate and vendor intelligence, FinCore sends a final deterministic budget/anomaly summary.

```sql
select invoice_id, budget_impact, anomaly_score, anomaly_reasons
  from invoice_analysis
 where invoice_id = '<invoice id>';
```

The response reports projected department utilization when a matching budget exists, otherwise explicitly says no budget was found. Anomaly reasons are named signals with weights; no approval or rejection is issued in this phase.

---

# Demo script — Phase 10: Deterministic decision engine

After the budget/anomaly summary, FinCore sends a deterministic recommendation:

- `APPROVE` when no review/defer/reject rule fires.
- `REVIEW` for high duplicate similarity, critical validation, high vendor risk, recent bank changes, budget review threshold, or anomaly threshold.
- `DEFER` at/above the budget defer threshold.
- `REJECT` when at least two critical validation errors are present.

```sql
select decision_id, invoice_id, recommendation, reasoning,
       confidence_score, decided_by
  from decisions
 where invoice_id = '<invoice id>';
```

The invoice remains `Pending`; the decision is an auditable recommendation only.

---

# Demo script — Phase 11: Natural-language financial Q&A

From the active WhatsApp number, send questions such as:

```text
How much did we spend this month?
Which vendor has the highest spend?
Show pending invoices
Are there any risky invoices?
How much budget is left?
Can we afford an INR 300000 invoice?
What is our cash flow?
```

FinCore responds from company-scoped database facts and uses Qwen only to explain those facts. Unknown questions return the supported-topic list. Q&A is read-only and does not change invoices, budgets, vendors, or decisions.

---

# Demo script — Phase 12: Risk alerts + workflow actions

From an active WhatsApp account:

```text
alerts
approve INV-<id>
review INV-<id>
defer INV-<id>
reject INV-<id>
resolve alert <alert-id>
```

`alerts` creates/reuses company-scoped open `risk_alerts` rows and lists the highest-severity items. Workflow actions require `admin`, `finance_manager`, or `department_head`; viewers and auditors are denied. Every accepted action is written to `invoice_actions`, while the invoice remains in its existing schema-valid status until a later payment/status workflow.

