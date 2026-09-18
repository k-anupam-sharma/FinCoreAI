# FinCore AI — Architecture Plan (Phase 1 deliverable)

## Context

FinCore AI is a WhatsApp-first financial intelligence assistant for SMBs. WhatsApp is only the interface; the real product is a deterministic financial engine (invoice intelligence, duplicate detection, vendor risk, budget impact, anomaly scoring, decision engine, forecasting) sitting on a Postgres database, with AI used only to *explain* facts and to *parse* natural-language questions — never to invent numbers or make the final call.

This project runs on the Enter platform: a Vite/React/Tailwind frontend + **Enter Cloud** (managed Postgres, Auth, Storage, backend functions — Supabase-compatible under the hood, always called "Enter Cloud"/"backend functions" to the user). There is no standalone Node/Python server. This plan adapts the user's requested architecture to that reality, imports the real dataset the user supplied (`datasets.zip`), and defines what phase 1–2 will build first.

**Confirmed decisions from the user:** Meta WhatsApp Cloud API (official) · Resend for OTP email · build a companion read-only admin/demo web dashboard · seed data comes from the attached `datasets.zip` (not synthetic).

---

## 1. Dataset reality check (drives the schema)

The attached `datasets.zip` contains more than the 6 files originally mentioned, and its shape is very close to this spec already (e.g. `invoices.source_channel` already includes `"whatsapp_bot"`). This is the ground truth the schema is built around:

| File | Rows | Key columns |
|---|---|---|
| `companies.csv` | 6 | company_id, name, industry, country, plan_tier |
| `users.csv` | 121 | user_id, name, email, password_hash, role, company_id, mfa_enabled, account_status, failed_login_attempts, last_login_at, created_at |
| `vendors.csv` | 111 | vendor_id, company_id, name, category, risk_profile, status, bank_name, bank_account_number, tax_id, onboarded_date |
| `invoices.csv` | 338 | invoice_id, company_id, vendor_id, department, gl_account, amount, currency, tax_amount, date, due_date, payment_terms, status, po_number, contract_id, submitted_by, submitted_at, source_channel, ocr_confidence, is_recurring, notes |
| `payments.csv` | 322 | payment_id, company_id, invoice_id, amount, status, payment_method, bank_reference, payment_date |
| `budgets.csv` | 901 | budget_id, company_id, department, period (YYYY-MM), allocated, spent, remaining |
| `decisions.csv` | 301 | decision_id, company_id, invoice_id, recommendation, reasoning, confidence_score, decided_by, timestamp |
| `cash_transactions.csv` | 5461 | transaction_id, company_id, date, type (inflow/outflow), category, amount — **this is the "transactions" table** required for anomaly/forecasting (§19), already provided |
| `gl_accounts.csv` | 13 | gl_code, category, description — lookup table |
| `vendor_bank_changes.csv` | 17 | change_id, vendor_id, company_id, old/new account, old/new bank, changed_at, changed_by — **fraud signal source** (post-bank-change invoice) |
| `auth_log.csv` | 516 | log_id, user_id, company_id, event_type (login_success/failed/mfa_verified/password_reset), ip_address, device, success, timestamp |
| `anomaly_answer_key.csv` | 110 | id, source_table, related_id, anomaly_type, description — **labeled ground truth for testing only** |

`anomaly_answer_key.anomaly_type` values map directly onto the anomaly signals required in §9: `duplicate_invoice`, `new_vendor_large_invoice`, `missing_po_high_value`, `post_bank_change_invoice`, `round_number_pattern`, `split_invoice_suspected`, `vendor_spend_spike`, `off_hours_submission`, `low_ocr_confidence_needs_review`, `credential_stuffing_pattern`. This becomes the anomaly engine's spec — each signal is a named, testable function.

All CSV `*_id` columns are kept as **text primary keys** exactly as given (e.g. `COMP-01`, `INV-00001`) — this preserves every existing relationship with zero remapping risk. New tables that have no CSV equivalent use `uuid` primary keys (`gen_random_uuid()`).

`password_hash` in `users.csv` is legacy/synthetic and is imported for provenance only — it is never wired to any login path. WhatsApp auth uses phone-linking + email OTP (§3); the admin dashboard uses Enter Cloud Auth's own credential store. `anomaly_answer_key` is imported into a clearly-labeled `demo_anomaly_answer_key` table used only by the test suite to score precision/recall of the anomaly engine — it is never read by runtime bot logic.

---

## 2. Two access paths (key architecture decision)

WhatsApp users are **not** Supabase/Enter Cloud Auth users — they're identified purely by our own `users` + `whatsapp_accounts` tables. This means two distinct, separately secured paths into the same database:

```
Path A — WhatsApp (primary product surface)
Meta WhatsApp Cloud API
   -> POST /functions/v1/whatsapp-webhook   (verify_jwt = false, Meta signature verified manually)
   -> identify sender (whatsapp_accounts.phone_number)
   -> load/advance conversation_sessions state
   -> route: onboarding | menu | media(invoice) | OTP recovery | NL question | workflow action
   -> service-role DB access, company_id scoping enforced IN CODE (no browser ever touches this)
   -> call AI (extraction / Q&A parsing / explanation) via Enter AI
   -> POST back to Meta Graph API (send message) via whatsapp-send helper
   -> persist everything (conversation_messages, invoice_analysis, decisions, alerts...)

Path B — Admin/demo dashboard (secondary, read-only for MVP)
Browser -> Enter Cloud Auth (email/password) -> dashboard_admins row (company_id, role)
   -> RLS-scoped reads straight from Postgres (no service role in the browser)
   -> visualizes the same companies/invoices/vendors/budgets/decisions/forecasts
```

Because path A always goes through backend functions using the service role, **every WhatsApp-facing table gets RLS enabled with a default-deny policy** (per Enter Cloud rules) and all real access happens inside functions, which enforce `company_id` scoping explicitly in TypeScript. Path B's RLS policies are scoped to `auth.uid()` via `dashboard_admins`.

---

## 3. Data model

Legend: **[csv]** = imported from `datasets.zip` as-is (extended with a few nullable columns where noted), **[new]** = new table with no CSV source.

### Core business entities
- **companies** [csv] — company_id (pk, text), name, industry, country, plan_tier, created_at
- **users** [csv+] — user_id (pk, text), name, email (unique), legacy_password_hash (unused), role (admin/ap_clerk/auditor/department_head/finance_manager/viewer), company_id (fk), mfa_enabled, account_status (Active/Locked/Suspended), failed_login_attempts, last_login_at, created_at
- **vendors** [csv] — vendor_id (pk, text), company_id (fk), name, category, risk_profile (legacy label — real risk is computed, see §7), status (Active/Blacklisted/Under Review), bank_name, bank_account_number, tax_id, onboarded_date
- **vendor_bank_changes** [csv] — change_id (pk), vendor_id (fk), company_id (fk), old/new_account_number, old/new_bank_name, changed_at, changed_by
- **gl_accounts** [csv] — gl_code (pk), category, description
- **invoices** [csv+] — invoice_id (pk, text), company_id (fk), vendor_id (fk), department, gl_account (fk), amount, currency, tax_amount, subtotal (derived), total_amount (derived), date, due_date, payment_terms, status (Pending/Paid/Overdue/Disputed/Cancelled), po_number, contract_id, submitted_by (fk users), submitted_at, source_channel (whatsapp_bot/email_upload/portal_upload/scanned_document), ocr_confidence, is_recurring, notes, file_storage_path (new, nullable)
- **invoice_items** [new] — id (uuid pk), invoice_id (fk), line_no, description, quantity, unit_price, amount, gl_account — populated by OCR going forward; empty for CSV-seeded invoices (no line-item data exists in the dataset)
- **payments** [csv] — payment_id (pk), company_id (fk), invoice_id (fk), amount, status, payment_method, bank_reference, payment_date
- **budgets** [csv] — budget_id (pk), company_id (fk), department, period (text, "YYYY-MM"), allocated, spent, remaining
- **transactions** [csv, from cash_transactions.csv] — transaction_id (pk), company_id (fk), date, type (inflow/outflow), category, amount — powers anomaly + forecasting
- **decisions** [csv] — decision_id (pk), company_id (fk), invoice_id (fk), recommendation, reasoning, confidence_score, decided_by (system_ai or user_id), timestamp — **AI/engine recommendation log**

### Auth / WhatsApp / conversation (new)
- **auth_methods** — id (uuid pk), user_id (fk), method_type (recovery_email / dashboard_auth), value (email, or Enter Cloud auth.uid()), verified_at, created_at
- **whatsapp_accounts** — id (uuid pk), user_id (fk, nullable until onboarding completes), phone_number (unique, E.164), wa_id, display_name, status (active/unlinked), last_inbound_at (drives the 24h free-form-message window), linked_at
- **otp_sessions** — id (uuid pk), user_id (fk, nullable pre-identification), channel (email), destination, otp_hash, purpose (signup_email_verify / account_recovery / link_new_number), expires_at, attempt_count, max_attempts (default 5), status (pending/verified/expired/locked), requester_phone, created_at
- **conversation_sessions** — id (uuid pk), wa_id, user_id (fk, nullable), state (text — state machine step), context (jsonb — partial onboarding answers / pending confirmation payload), last_message_at, expires_at
- **conversation_messages** — id (uuid pk), session_id (fk), direction (inbound/outbound), message_type (text/image/document/interactive), content, media_url, wa_message_id, created_at
- **auth_log** [csv+] — log_id (pk), user_id (fk, nullable), company_id (fk, nullable), event_type (login_success/login_failed/mfa_verified/password_reset/otp_requested/otp_verified/account_locked), ip_address, device, success, timestamp — seeded from CSV as history, appended to at runtime for every OTP/recovery/dashboard-login event; also the source for the `credential_stuffing_pattern` anomaly signal

### Intelligence / decisions (new)
- **invoice_analysis** — id (uuid pk), invoice_id (fk, unique), extracted_fields (jsonb), validation_result (jsonb), duplicate_score, duplicate_evidence (jsonb), vendor_risk_snapshot (jsonb), budget_impact (jsonb), anomaly_score, anomaly_reasons (jsonb), created_at — the full "facts" record every explanation is built from
- **invoice_actions** — id (uuid pk), invoice_id (fk), company_id (fk), action (approve/review/defer/reject), previous_status, new_status, performed_by (fk users), reason, created_at — human workflow audit trail (§16), distinct from the AI `decisions` log
- **risk_alerts** — id (uuid pk), company_id (fk), alert_type (matches anomaly types + budget_near_limit/cash_flow_pressure), severity (low/medium/high), related_invoice_id (fk, nullable), related_vendor_id (fk, nullable), message, status (open/acknowledged/resolved), created_at, resolved_at, resolved_by
- **forecast_records** — id (uuid pk), company_id (fk), generated_at, horizon_days (30/60/90), projected_inflow, projected_outflow, projected_net, projected_cash_position, top_contributors (jsonb), disclaimer (fixed "estimate, not a guarantee" text)
- **decision_rules_config** — id (uuid pk), company_id (nullable = global default), rule_key, threshold_value (numeric), description, updated_at — configurable thresholds (§10), editable later without redeploying code

### Dashboard-only (new)
- **dashboard_admins** — user_id (uuid pk = `auth.uid()`), company_id (fk), role, created_at — links an Enter Cloud Auth login to a company for RLS scoping on Path B

### Test-only (new)
- **demo_anomaly_answer_key** [csv] — id (pk), source_table, related_id, anomaly_type, description — clearly labeled synthetic evaluation set, read only by the automated test suite (§13), never by bot logic

---

## 4. Folder structure (adapted to Enter Cloud conventions)

The spec's `/src/webhooks`, `/src/auth`, `/src/database` etc. don't map onto how Enter Cloud actually runs backend code (isolated Deno functions, not a monolithic Node server). Real structure:

```
supabase/
  migrations/                     # schema, RLS, triggers (via supabase_migration tool)
  functions/
    _shared/
      cors.ts
      db.ts                       # typed service-role client helper
      whatsapp/                   # Graph API send + payload types
      logic/                      # PURE, deterministic, framework-agnostic TS (no Deno APIs)
        validation.ts             # invoice field validation (§5)
        duplicate.ts              # duplicate scoring (§6)
        vendorRisk.ts             # vendor risk indicators (§7)
        budgetImpact.ts           # budget math (§8)
        anomaly.ts                # anomaly signals + score (§9)
        decisionEngine.ts         # deterministic rules (§10)
        forecast.ts               # cash-flow projection (§14)
        __tests__/                # Vitest unit tests, run under Node (pure TS, no Deno globals)
    whatsapp-webhook/index.ts     # Meta verify + inbound router (verify_jwt=false)
    whatsapp-send/index.ts        # outbound message helper (text/interactive/template)
    otp-request/index.ts          # generate + email OTP (Resend)
    otp-verify/index.ts           # verify OTP, link number, restore account
    onboarding/index.ts           # onboarding state machine steps
    invoice-ingest/index.ts       # receive media -> Storage -> create invoice row
    invoice-analyze/index.ts      # OCR (AI) -> validation -> duplicate -> vendor -> budget -> anomaly -> decision -> explanation
    invoice-action/index.ts       # approve/review/defer/reject workflow
    financial-qna/index.ts        # NL question -> controlled query tool -> AI explanation
    financial-overview/index.ts   # summary numbers for menu option 2
    forecast-generate/index.ts    # 30/60/90-day projection
    alerts-scan/index.ts          # proactive alert detection (cron-triggered)
src/
  integrations/supabase/client.ts # generated, do not edit
  pages/                          # dashboard routes (Companies, Invoices, Vendors, Budgets, Decisions, Forecast)
  components/fincore/             # dashboard UI components
  hooks/                          # dashboard data hooks (react-query + supabase client)
docs/
  demo-script.md                  # the 15-step demo flow (§25) as a runbook
  decision-thresholds.md          # documents decision_rules_config keys/defaults
```

Rationale for the `_shared/logic/` split: every deterministic calculation (validation, duplicate score, anomaly score, decision engine, budget math, forecast math) is written once as pure functions with **zero Deno-only APIs**. Edge functions import them normally; the same files are also exercised directly by Vitest under Node — one implementation, two runtimes, real unit tests, and a guarantee the LLM never touches these numbers.

---

## 5. WhatsApp message flow

```
Inbound webhook payload
  -> verify Meta signature (X-Hub-Signature-256, app secret)
  -> upsert conversation_sessions by wa_id (create if new, else load state)
  -> resolve identity: whatsapp_accounts.phone_number -> user_id -> company_id (if linked)
  -> classify message: text (menu number / NL question / "Login"/"Approve INV-x") | interactive reply | image | document
  -> route by conversation state:
       state=new & unidentified          -> start onboarding
       state=onboarding_*                -> advance onboarding step, validate answer
       state=awaiting_otp                -> otp-verify
       identified & media                -> invoice-ingest -> invoice-analyze
       identified & main-menu number     -> corresponding feature function
       identified & free text            -> financial-qna (NL routing)
       identified & "Approve/Review/Defer/Reject INV-x" -> invoice-action
  -> persist inbound + outbound in conversation_messages
  -> whatsapp-send reply (respecting 24h free-form window; use approved template outside it)
```

Main menu (interactive list) and natural-language input both terminate in the same backend functions — the menu is just a shortcut into the same handlers used by NL routing.

---

## 6. Authentication / recovery flow

**Onboarding (new number, "Hi")**
1. Ask name -> company name -> role -> industry -> approx. monthly spend -> recovery email.
2. **Addition (security gap closed):** verify the recovery email immediately via the same OTP engine used for recovery, before confirming the account — otherwise a mistyped/attacker-supplied email would silently become the recovery path. This reuses `otp_sessions`/`otp-request`/`otp-verify`, no new mechanism.
3. Company resolution (**assumption, flagged for review**): match company name case-insensitively against existing `companies`. No match -> create new company, this user becomes `role=admin`. Match found -> create the user as pending, notify one existing admin on WhatsApp for a one-tap approve (simple join-request, no new UI). This resolves a gap in the literal spec: onboarding as written would fragment one real company into N company rows if two colleagues both onboard.
4. On confirmation: create `users` row, `auth_methods(recovery_email)`, `whatsapp_accounts(phone_number, status=active)`, reply "Your FinCore account has been created."

**Recovery ("Login"/"Recover Account" from a new number)**
1. Ask registered recovery email -> look up `auth_methods` -> `users`.
2. `otp-request`: generate 6-digit code, hash it, store in `otp_sessions` (purpose=account_recovery, expires_at = now+10min, max_attempts=5), email via Resend.
3. `otp-verify`: check hash + expiry + attempt_count; on 5th failed attempt, mark `status=locked` and write `account_locked` to `auth_log` (also flips `users.account_status=Locked` after repeated abuse — mirrors `failed_login_attempts` already in the dataset).
4. On success: link new `whatsapp_accounts` row to the existing `user_id`, mark old number inactive if replaced, restore full access to existing invoices/budgets/vendors/history.
5. Rate limiting: an IP/phone may request at most N OTPs per hour (checked against `auth_log`/`otp_sessions` timestamps in code — no extra table needed).

---

## 7. Invoice processing pipeline

`invoice-ingest` (media received) -> download from Meta -> validate file type (`pdf`, `jpg`, `png`) and size (≤10MB, **assumption, confirm before build**) -> store original in Enter Cloud Storage under `invoices/{company_id}/{invoice_id}.{ext}` -> create `invoices` row (`status=Pending`, `source_channel=whatsapp_bot`).

`invoice-analyze` (chained call) runs the deterministic pipeline, calling `_shared/logic/*` in order, persisting each result into `invoice_analysis`:
1. OCR/extraction via Enter AI vision-capable model -> structured fields (invoice number, vendor, dates, amounts, currency, department, category, description, PO).
2. `validation.ts` — missing required fields, subtotal+tax≠total, invalid/impossible dates, negative or absurd amounts.
3. `duplicate.ts` — multi-signal score (invoice number, vendor, amount±tolerance, date proximity, PO, description similarity) against this vendor's recent invoices -> score 0–100 + evidence list.
4. `vendorRisk.ts` — computed indicators from `invoices`/`payments`/`vendor_bank_changes` history (count, total spend, average, frequency, on-time-payment rate, prior duplicate flags, recent bank-account change) — never just echoes `vendors.risk_profile`.
5. `budgetImpact.ts` — current allocated/spent/remaining for the invoice's `department`+current `period`, projected utilization after this invoice.
6. `anomaly.ts` — runs each named signal (amount-vs-vendor-average multiplier, duplicate evidence, budget pressure, new-vendor-large-invoice, missing-PO-high-value, round-number pattern, split-invoice suspicion, off-hours submission, post-bank-change, low OCR confidence) -> transparent 0–100 score with reasons list (each signal contributes an explicit, logged weight).
7. `decisionEngine.ts` — deterministic thresholds (read from `decision_rules_config`, falling back to global defaults) -> APPROVE / REVIEW / DEFER / REJECT.
8. AI is called once more, only to turn steps 2–7's facts into a short WhatsApp-friendly explanation — the prompt is instructed to restate given facts, not compute new ones.
9. Persist to `invoice_analysis` + `decisions`; send concise WhatsApp result with a "View Details" follow-up option (expands the same stored record).

---

## 8. Decision engine logic

Deterministic, in `_shared/logic/decisionEngine.ts`, thresholds sourced from `decision_rules_config` (seeded with sane defaults, overridable per company):

```
IF duplicate_score >= duplicate_review_threshold           -> REVIEW ("Hold - Duplicate Suspected")
ELSE IF validation has a critical failure (missing required field, total mismatch, invalid date) -> REJECT or REVIEW (severity-dependent)
ELSE IF vendor_risk == High OR recent bank-account change within N days -> REVIEW
ELSE IF projected_budget_utilization >= budget_defer_threshold -> DEFER
ELSE IF projected_budget_utilization >= budget_review_threshold -> REVIEW
ELSE IF anomaly_score >= anomaly_review_threshold -> REVIEW
ELSE -> APPROVE
```
The engine returns the recommendation plus the ordered list of reasons that fired — this list *is* the explanation input, not a separate AI guess.

---

## 9. Backend function (API) list

| Function | Trigger | Purpose |
|---|---|---|
| `whatsapp-webhook` | Meta POST (verify_jwt=false) | inbound entrypoint, routing |
| `whatsapp-send` | internal | outbound Graph API calls (text/interactive/template) |
| `otp-request` | internal | generate + email OTP via Resend |
| `otp-verify` | internal | verify OTP, enforce attempts/expiry/lockout |
| `onboarding` | internal | onboarding state machine steps + company resolution |
| `invoice-ingest` | internal (from webhook on media) | download, validate, store file, create invoice row |
| `invoice-analyze` | internal (chained after ingest) | full intelligence pipeline (§7) |
| `invoice-action` | internal ("Approve INV-x" etc.) | authorize + record + update status |
| `financial-qna` | internal (NL question) | structured query tools + AI explanation |
| `financial-overview` | internal (menu option 2) | summary numbers |
| `forecast-generate` | internal (menu option 5) | 30/60/90-day projection |
| `alerts-scan` | scheduled (cron) | proactive alert detection -> `risk_alerts` + push via `whatsapp-send` |

All are Supabase-style functions at `supabase/functions/<name>/index.ts`, service-role DB access, CORS handled, deployed via `supabase_deploy_edge_function`. The dashboard (Path B) does not call these — it reads/writes Postgres directly through RLS-scoped Enter Cloud Auth sessions.

---

## 10. Environment variables / secrets

| Secret | Used by | Source |
|---|---|---|
| `WHATSAPP_ACCESS_TOKEN` | whatsapp-send, webhook verification | Meta App |
| `WHATSAPP_PHONE_NUMBER_ID` | whatsapp-send | Meta App |
| `WHATSAPP_VERIFY_TOKEN` | whatsapp-webhook (GET verification handshake) | chosen by us, registered in Meta |
| `WHATSAPP_APP_SECRET` | whatsapp-webhook (signature verification) | Meta App |
| `RESEND_API_KEY` | otp-request | Resend account |
| AI API token | invoice-analyze, financial-qna | provisioned automatically once AI Capability is enabled — not user-supplied |
| Enter Cloud service role key | all functions | provisioned automatically by Enter Cloud, never in client code |

All added via `supabase_add_secret` when each phase needs them — none hardcoded, none in client-side code.

---

## 11. External integrations required

- **Meta WhatsApp Cloud API** — user must have a Meta Business + verified WhatsApp Business number and app; must pre-approve message templates for any business-initiated alert sent outside the 24h customer-service window (flagged risk: alerts §15 are proactive and will need at least one approved template).
- **Resend** — transactional email for OTP delivery.
- **Enter AI Capability** — not yet enabled on this project; required before Phase 7 (OCR/extraction), Phase 11 (NL Q&A parsing), and explanation generation. Will be requested when we reach that phase.
- **Enter Cloud Storage** — original invoice file storage.
- **Enter Cloud Auth** — dashboard admin login only.

---

## 12. Testing strategy

- **Pure logic (highest value):** Vitest tests for every `_shared/logic/*.ts` module, run under Node against the same files the edge functions import (no Deno-only APIs in these files). Validation, duplicate scoring, vendor risk, budget math, anomaly scoring, and decision engine each get positive/negative/boundary cases, plus a scored run against `demo_anomaly_answer_key` to report precision/recall on the labeled anomaly types.
- **Auth/recovery:** unit tests for OTP expiry, wrong-code, attempt-limit lockout, rate limiting, and cross-company authorization boundaries (a user from Company A must never read/act on Company B's invoice).
- **Onboarding/company resolution:** new-company path, existing-company join-request path, returning-number path.
- **Integration (manual/documented):** `docs/demo-script.md` with curl payloads simulating Meta webhook events (text, image, document, interactive reply) against a running `whatsapp-webhook`, so the full pipeline is exercisable before a live Meta number is connected.
- **Dashboard:** RLS boundary check — a dashboard admin for Company A cannot query Company B's rows.

`vitest` is not yet a project dependency — it will be added when Phase 14 (Testing) starts.

---

## 13. MVP milestones (re-grouped from the user's 15 phases onto this architecture)

1. **Schema + seed** — migrations for all tables above (RLS on every table), import `datasets.zip` preserving IDs, seed `decision_rules_config` defaults. *(next step after this plan is approved)*
2. **Enter Cloud connection verification** — confirm schema, RLS, and row counts match source CSVs.
3. **WhatsApp webhook skeleton** — signature verification, conversation_sessions bootstrap, echo/menu only.
4. **Onboarding + account creation** (incl. email verification, company resolution).
5. **OTP recovery + number linking** (expiry, attempts, lockout, rate limiting).
6. **Invoice upload + Storage.**
7. **OCR/extraction + validation** (requires enabling Enter AI Capability).
8. **Duplicate detection + vendor risk.**
9. **Budget impact + anomaly scoring.**
10. **Decision engine + explainable recommendations.**
11. **Natural-language financial Q&A.**
12. **Alerts + approve/review/defer/reject workflow actions.**
13. **Cash-flow forecasting.**
14. **Testing (Vitest suite against `_shared/logic`) + security pass + dashboard.**
15. **Demo polishing** against the §25 script.

Each milestone is implemented, verified, and explained before the next starts — no milestone jumps ahead of schema/data it depends on.

---

## 14. Flags: assumptions, gaps, and things that need a live decision later

- Company-matching-by-name join-request flow (§6) is my resolution to a real gap in the literal onboarding spec; revisit if you want stricter company verification (e.g. invite codes).
- Email verification added to onboarding (not in the original flow) — closes a real account-takeover gap; can be removed if you want zero-friction onboarding instead.
- File limits assumed at PDF/JPG/PNG, 10MB — confirm or change before Phase 6.
- Single currency per company assumed (dataset is INR-only) — flag if multi-currency is actually needed.
- Proactive WhatsApp alerts require at least one Meta-approved message template — this is an external, non-code prerequisite you'll need to handle in Meta Business Manager.
- `password_hash` from `users.csv` and `anomaly_answer_key.csv` are imported for fidelity/testing only and are never used by runtime logic — flagging so it's an explicit choice, not a silent omission.

---

## Implementation checklist (Phase 1–2, next step after approval)

- [ ] Enable Enter Cloud (`supabase_enable`) if not already on.
- [ ] Migration: create `companies`, `users`, `vendors`, `vendor_bank_changes`, `gl_accounts`, `invoices`, `invoice_items`, `payments`, `budgets`, `transactions`, `decisions` with text PKs matching CSV IDs; RLS enabled with default-deny (service-role only) policies.
- [ ] Migration: create `auth_methods`, `whatsapp_accounts`, `otp_sessions`, `conversation_sessions`, `conversation_messages`, `auth_log` (uuid PKs except auth_log which keeps CSV `log_id`); RLS default-deny.
- [ ] Migration: create `invoice_analysis`, `invoice_actions`, `risk_alerts`, `forecast_records`, `decision_rules_config`; RLS default-deny.
- [ ] Migration: create `dashboard_admins`; RLS scoped to `auth.uid()` for Path B.
- [ ] Migration: create `demo_anomaly_answer_key`, clearly commented as test-only.
- [ ] Seed `decision_rules_config` with default thresholds for duplicate/budget/anomaly review levels.
- [ ] Import all CSVs from `datasets.zip` preserving foreign keys (companies -> users/vendors -> invoices -> payments/decisions/invoice_analysis linkage, budgets, transactions, gl_accounts, vendor_bank_changes, auth_log, demo_anomaly_answer_key).
- [ ] Verify imported row counts match source CSVs and spot-check a few FK joins (e.g. an invoice's vendor_id and company_id resolve correctly).

## Verification checklist

- [ ] `supabase_get_table_schema` confirms RLS is enabled with policies on every new table (no table left readable by default app roles).
- [ ] A read query as an unauthenticated/anon role against any WhatsApp-facing table returns zero rows (default-deny confirmed).
- [ ] Row counts per table match the corresponding CSV row counts exactly.
- [ ] Spot-check: an invoice's `vendor_id`/`company_id` join resolves to the correct vendor/company name from the CSVs.
- [ ] `decision_rules_config` has at least one default row per threshold key referenced in the decision engine design (duplicate, budget, anomaly, vendor-risk).
