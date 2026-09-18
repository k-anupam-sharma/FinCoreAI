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

**Version control note:** this environment auto-commits every turn to its own managed history; I cannot run `git push`/`git remote` or mirror commits to an external GitHub repository (`k-anupam-sharma/FinCoreAI`). Secrets themselves never live in source regardless — they're stored server-side via `supabase_add_secret` and read with `Deno.env.get()`. As a defense-in-depth step, Phase 1 also hardens `.gitignore` (adding `.env`, `.env.*.local`, and key/credential file patterns) even though no secret is ever committed by this workflow.

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

- [x] Harden `.gitignore` with `.env`, `.env.*.local`, and generic key/credential file patterns (defense-in-depth; no secret is ever committed by this workflow regardless).
- [x] Stage the provided dataset at `docs/seed-data/*.csv` with import/mapping notes in `docs/seed-data/README.md`.
- [x] Draft the full schema (all tables + RLS policies + default `decision_rules_config` seed) at `docs/database-schema.sql`, ready to run once Enter Cloud is available.
- [ ] **Blocked:** Enable Enter Cloud (`supabase_enable`) — provisioning has failed on the platform side (`Enter Cloud failed to start`); retry when the platform issue clears.
- [ ] Once Enter Cloud is up: apply `docs/database-schema.sql` via `supabase_migration` (in reviewable chunks).
- [ ] Import all CSVs from `docs/seed-data/` preserving foreign keys, in the order listed in `docs/seed-data/README.md`.
- [ ] Verify imported row counts match source CSVs and spot-check a few FK joins (e.g. an invoice's vendor_id and company_id resolve correctly).

## Verification checklist

- [ ] `supabase_get_table_schema` confirms RLS is enabled with policies on every new table (no table left readable by default app roles).
- [ ] A read query as an unauthenticated/anon role against any WhatsApp-facing table returns zero rows (default-deny confirmed).
- [ ] Row counts per table match the corresponding CSV row counts exactly.
- [ ] Spot-check: an invoice's `vendor_id`/`company_id` join resolves to the correct vendor/company name from the CSVs.
- [ ] `decision_rules_config` has at least one default row per threshold key referenced in the decision engine design (duplicate, budget, anomaly, vendor-risk).

---

## Interim workaround shipped while Enter Cloud is unavailable

Enter Cloud provisioning is still failing (`Enter Cloud failed to start`) as of this update. Per the user's direction, the deterministic financial engine and a dedicated WhatsApp-styled chatbot were built as a fully client-side stopgap, so the product is demonstrable now and the real backend can be dropped in later with minimal rework:

- **`src/lib/fincore/*`** — pure TypeScript, framework-agnostic: `validation.ts`, `duplicate.ts`, `vendorRisk.ts`, `budgetImpact.ts`, `anomaly.ts`, `decisionEngine.ts`, `forecast.ts`, `explain.ts`, `pipeline.ts`, `queries.ts` (rule-based NL Q&A router), `conversation.ts` (the bot's state machine), `session.ts`, `thresholds.ts`. These are the same functions a real backend function would import — only the data access needs to change later.
- **`src/data/fincoreStore.ts`** — stands in for the database: loads `src/data/seed/*.json` (converted from `docs/seed-data/*.csv`) and layers session-created records on top, persisted to `localStorage`.
- **`src/components/whatsapp/*` + `src/pages/Assistant.tsx`** (route `/assistant`) — the dedicated chat UI, WhatsApp-styled via new `whatsapp`/`chat`/`risk`/`decision` design tokens in `index.css`/`tailwind.config.ts`.
- **`src/lib/fincore/__tests__/*.test.ts`** (Vitest, `pnpm test`) — 35 tests, several run against the real labeled dataset (`demo_anomaly_answer_key`, a known vendor bank-change, a known duplicate-invoice pair).

**Explicitly not real yet, and clearly labeled as such in the UI:** no real WhatsApp/Meta connection (browser chat only), no database (localStorage only, per-browser), no OCR/AI (new invoices are entered via guided prompts, not scanned; explanations are templated, not LLM-generated), no real OTP email delivery (demo code is shown inline in the chat). All of this remains blocked on Enter Cloud (+ AI Capability) and is unchanged from the rest of this plan — resume there once Enter Cloud provisions successfully.

---

## Enter Cloud is live — Phase 1–2 verified, Phase 3 plan below

Enter Cloud provisioned successfully. Verified against the real backend (not a plan claim):

- All 24 tables from `docs/database-schema.sql` exist with RLS enabled and the designed policies (`supabase_get_table_schema`).
- Every seeded table's row count matches its source CSV exactly (companies 5, users 120, vendors 110, vendor_bank_changes 16, invoices 337, payments 321, budgets 900, transactions 5460, decisions 300, auth_log 515, demo_anomaly_answer_key 109, gl_accounts 12).
- Spot-checked FK joins (invoice → vendor → company) resolve correctly, and `subtotal + tax_amount = total_amount` holds for all 337 invoices (0 mismatches).

Phase 1–2 of the original milestone list are complete. The client-side stopgap (`/assistant`, `src/lib/fincore/*`, `src/data/fincoreStore.ts`) stays as-is for now — it is a self-contained demo the user already has, and nothing in Phase 3 requires touching it. Phase 3 below moves to the real backend, per the original milestone order.

### Context for Phase 3

The user confirmed they have real Meta WhatsApp Cloud API credentials ready. Per the original milestone order ("Phase 3: WhatsApp webhook + basic message handling — signature verification, conversation_sessions bootstrap, echo/menu only"), this phase is intentionally narrow: it does **not** yet wire up onboarding, invoice analysis, or NL Q&A — those are later milestones and will extend this same webhook's routing once they have real DB-backed implementations (the current `/assistant` demo logic is client-only and is not the source that gets ported in; each later phase gets a fresh, backend-function-native implementation per the architecture in this plan).

### Design decisions

- **`whatsapp-send` becomes a shared module, not a separately deployed function.** The original API list (§9) proposed it as its own deployed function. Since Deno edge functions support plain relative imports, a shared `supabase/functions/_shared/whatsapp.ts` module (exporting `sendWhatsAppText()`) is imported directly by any function that needs to send — the webhook now, `invoice-analyze`/`alerts-scan`/`invoice-action` etc. in later phases. This avoids an extra network hop and avoids passing service keys between functions, with no loss of reusability (still one implementation, many call sites).
- **Signature verification** uses `WHATSAPP_APP_SECRET` to compute HMAC-SHA256 over the raw request body and compare against the `X-Hub-Signature-256` header, per Meta's webhook spec. Requests that fail this check are rejected before any DB write.
- **`conversation_sessions` bootstrap**: every inbound message upserts a session keyed by `wa_id` (create with `state='new'` if none exists, else load and touch `last_message_at`). Identity resolution against `whatsapp_accounts` is looked up but not required to exist yet — that linkage is created starting Phase 4 (onboarding). This keeps Phase 3 decoupled from onboarding logic.
- **Echo/menu-only reply logic** (matches the milestone's explicit scope): if the inbound text matches hi/hello/menu/help (case-insensitive), reply with the static main menu list (§4 of this plan); for any other text, reply with a plain echo plus a note that full processing arrives in a later phase; for image/document messages, acknowledge receipt without processing. Every inbound and outbound message is persisted to `conversation_messages`.
- **`verify_jwt = false`** on `whatsapp-webhook` only (Meta calls it unauthenticated); no other function changes this default.

### Files

- `supabase/functions/_shared/cors.ts` — shared CORS headers (per `enter_cloud` skill convention).
- `supabase/functions/_shared/whatsapp.ts` — `verifyMetaSignature()`, `sendWhatsAppText()`, and minimal Graph API payload types.
- `supabase/functions/whatsapp-webhook/index.ts` — GET verification handshake; POST: verify signature → parse `entry[].changes[].value.messages[]` → bootstrap `conversation_sessions` → persist inbound `conversation_messages` → echo/menu reply → persist outbound `conversation_messages` → send via `sendWhatsAppText()`.
- `supabase/config.toml` — add `[functions.whatsapp-webhook]` with `verify_jwt = false`.
- `docs/demo-script.md` (new) — curl examples for the GET handshake and a signed POST payload, plus the negative case (bad signature → rejected, no DB row written).

### Secrets (collected via `supabase_add_secret` before writing code)

`WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_APP_SECRET`.

## Implementation checklist (Phase 3)

- [x] Collect `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_APP_SECRET` via `supabase_add_secret`.
- [x] Create `supabase/functions/_shared/cors.ts` with the standard CORS headers and `OPTIONS` handling shape (kept as documented reference; see note below on inlining).
- [x] Create `supabase/functions/_shared/whatsapp.ts`: `verifyMetaSignature(rawBody, signatureHeader, appSecret)` (HMAC-SHA256, timing-safe compare) and `sendWhatsAppText(to, text)` (Graph API call using `WHATSAPP_ACCESS_TOKEN` / `WHATSAPP_PHONE_NUMBER_ID`).
- [x] Create `supabase/functions/whatsapp-webhook/index.ts`:
  - [x] GET: validate `hub.verify_token` against `WHATSAPP_VERIFY_TOKEN`; return `hub.challenge` on match, 403 otherwise.
  - [x] POST: reject (401/403) when the signature check fails, before any DB access.
  - [x] POST: on a valid signed request, upsert `conversation_sessions` by `wa_id`.
  - [x] POST: insert one `conversation_messages` row per inbound message (text/image/document/interactive).
  - [x] POST: reply with the static menu on hi/hello/menu/help, otherwise an echo/not-yet-implemented notice; image/document gets an acknowledgement only.
  - [x] POST: insert the corresponding outbound `conversation_messages` row and call `sendWhatsAppText()`.
  - [x] Never leak secrets or stack traces in any response body; log detail server-side only.
- [x] Update `supabase/config.toml` to set `verify_jwt = false` for `whatsapp-webhook` only.
- [x] Deploy via `supabase_deploy_edge_function` and confirm the platform reports `verify_jwt = false` for this function.
- [x] Write `docs/demo-script.md` with the curl commands used for verification below.

**Platform constraint discovered during implementation:** this project's Edge Function bundler packages only the single `index.ts` per function — cross-function relative imports to `_shared/*.ts` are not resolved at deploy time (`Module not found "file:///.../_shared/cors.ts"`). `supabase/functions/_shared/{cors,whatsapp}.ts` are kept as the documented reference implementation; `whatsapp-webhook/index.ts` inlines the same logic directly. Future functions that need these helpers (`invoice-analyze`, `alerts-scan`, `invoice-action`, etc.) will need to inline-copy from `_shared/` too — flagging this so it's a deliberate, visible choice each time rather than a silent drift risk.

## Verification checklist (Phase 3)

- [x] GET handshake with the correct `hub.verify_token` returns the `hub.challenge` value with HTTP 200. (Verified via curl: `CHALLENGE_ACCEPTED_123` / `HTTP_STATUS:200`.)
- [x] GET handshake with an incorrect `hub.verify_token` returns a non-200 and does not echo the challenge. (Verified via curl: `Forbidden` / `HTTP_STATUS:403`.)
- [x] POST with a valid HMAC-SHA256 signature (computed from the real `WHATSAPP_APP_SECRET`) results in exactly one new `conversation_sessions` row (first contact) and two `conversation_messages` rows (inbound + outbound), verified via `supabase_read_query`. (Confirmed: one session for test wa_id `911234567890`, inbound "Hi" + outbound main-menu text.)
- [x] POST with an invalid/missing signature is rejected and writes zero rows (negative test). (Confirmed: `401 Invalid signature`, no additional rows beyond the valid-signature test.)
- [x] Sending "Hi" from the user's real WhatsApp number to the connected test number produces a real reply on their phone within a few seconds, and the exchange is visible in `conversation_messages`. (User confirmed live: received the menu reply.)
- [x] Sending "menu" produces the 8-item main menu reply; sending arbitrary text produces the echo/not-yet-implemented reply; sending an image produces the acknowledgement-only reply. (Logic verified in code and via the curl test; live-confirmed for the menu case.)
- [ ] `supabase_search_edge_function_logs` for `whatsapp-webhook` shows no unhandled errors across the above test messages. **Blocked:** the log search tool itself returned a platform-side `HTTP 500` on every query attempted; functional correctness was instead confirmed directly via database row verification above. Retry log inspection in a later phase if the tool recovers.

---

## Phase 4 — Onboarding + account creation

### Context

Phase 3 shipped signature verification and an echo/menu-only reply. Phase 4 turns the webhook into a real conversation state machine that creates a genuine FinCore account (company, user, recovery email, WhatsApp link) instead of a static reply. This is the first phase that writes to `companies`/`users`/`auth_methods`/`whatsapp_accounts`/`otp_sessions` from a live backend function.

**Confirmed with the user:**
- If the typed company name matches an existing company, the new user joins instantly as `role='viewer'` — no admin-approval gate. (Simpler than the "notify an existing admin" idea floated in §6/§14 of this plan; that idea is dropped, not deferred.)
- Recovery-email verification uses Resend's shared sandbox sender for now — real delivery is only guaranteed to the developer's own verified Resend account email until a custom domain is verified. This is a demo-time limitation, not a code gap.

### Design decisions

- **No new deployed function.** The original §9 API list proposed a separate `onboarding` function. Given the Phase-3-discovered bundler constraint (no cross-function shared imports) and that onboarding is invoked exclusively from inside the webhook's own per-message loop, it is implemented as local functions inside `supabase/functions/whatsapp-webhook/index.ts` directly — no internal HTTP hop, no service-role token passing between functions. This deviates from the original plan's function list; flagging it the same way the `_shared/` inlining constraint was flagged.
- **State machine lives in `conversation_sessions.state` + `.context` (jsonb).** States added: `onboarding_name` → `onboarding_company` → `onboarding_role` → `onboarding_industry` → `onboarding_spend` → `onboarding_email` → `onboarding_otp` → `active`. `context` holds the in-progress draft answers plus the current OTP's hash/expiry/attempt count, mirroring the shape already proven in the client-side `ChatDraft` (`src/lib/fincore/conversation.ts`) but persisted server-side instead of `localStorage`.
- **Identity check on every inbound message:** look up `whatsapp_accounts` by `wa_id` with `status='active'`. If found, the sender is already onboarded — fall through to the existing Phase 3 menu/echo logic unchanged. If not found and `conversation_sessions.state` is `new` or an `onboarding_*` state, run the onboarding step for that state. If not found and the message is `login`/`recover account`, reply that recovery is coming in a later phase (Phase 5) — do not silently swallow that text into the `name` field.
- **OTP generation/verification is a same-file helper, not a separate function** (same reasoning as above): 6-digit code, SHA-256 hashed (Web Crypto `digest`, no external dependency) before storing in `otp_sessions.otp_hash`, `expires_at = now()+10min`, `max_attempts=5`, `purpose='signup_email_verify'`. Verification compares the hash of the input digits, increments `attempt_count` on mismatch, marks `status='locked'` and resets the session to `state='new'` after 5 failures, and marks `status='expired'` (session reset to `state='new'`) past `expires_at`.
- **Email delivery via Resend's REST API** (`https://api.resend.com/emails`), called directly with `fetch` — no SDK needed for a single call. From address: `FinCore AI <onboarding@resend.dev>` (Resend's shared sandbox sender, per the user's confirmed choice).
- **IDs:** new `company_id` as `CO-<8 hex chars>`, new `user_id` as `USR-<8 hex chars>` (distinct prefixes from the CSV-seeded `COMP-XX`/`USR-XXXX` patterns, so origin is visually obvious in the data without needing a separate flag column).
- **Validation** mirrors the already-proven client-side rules (`src/lib/fincore/conversation.ts`): non-empty name/role/industry/spend text, and an email-shape regex before triggering the OTP send.

### Files

- `supabase/functions/whatsapp-webhook/index.ts` — add: `whatsapp_accounts` identity lookup, the `onboarding_*` state handlers, `sha256Hex()`, `generateOtp()`, `sendOtpEmail()` (Resend call), and the state-dispatch branch that runs before the existing Phase 3 `buildReply()` fallback (which still fires once a session reaches `state='active'`).
- `supabase/config.toml` — no changes (still just the one function).
- `docs/demo-script.md` — append a Phase 4 section with the same signed-curl pattern used for Phase 3, walking through one full onboarding conversation.

### Secrets (collected via `supabase_add_secret` before writing code)

`RESEND_API_KEY`.

## Implementation checklist (Phase 4)

- [x] Collect `RESEND_API_KEY` via `supabase_add_secret`.
- [x] In `whatsapp-webhook/index.ts`, add an identity lookup against `whatsapp_accounts` (`wa_id`, `status='active'`) before the existing Phase 3 reply logic; identified senders skip onboarding entirely.
- [x] Add `onboarding_name` → `onboarding_company` → `onboarding_role` → `onboarding_industry` → `onboarding_spend` → `onboarding_email` state handlers, each validating input and writing the answer into `conversation_sessions.context`, then advancing `state`.
- [x] Add company resolution in the `onboarding_company` step: case-insensitive match against `companies.name`; store `isNewCompany` + `resolvedCompanyId` (if matched) in `context`.
- [x] Add email-shape validation in `onboarding_email`; on a valid email, generate + SHA-256-hash a 6-digit OTP, insert an `otp_sessions` row (`purpose='signup_email_verify'`, `expires_at=now()+10min`, `max_attempts=5`), send it via Resend, advance to `onboarding_otp`.
- [x] Add `onboarding_otp` handling: expiry check, hash comparison, attempt increment/lockout (5 attempts), and on success — create the company (if new) or reuse the resolved one, create the `users` row (`role='admin'` for a new company, `role='viewer'` when joining an existing one), create `auth_methods` (`method_type='recovery_email'`, `verified_at=now()`), create `whatsapp_accounts` (`status='active'`), set `conversation_sessions.state='active'`, clear `context`, and reply "Your FinCore account has been created."
- [x] Add a guard: an unidentified sender typing `login`/`recover account` gets a "coming in a later phase" reply instead of being onboarded on that text.
- [x] Never leak the OTP value, Resend errors, or stack traces in any WhatsApp-visible reply; log detail server-side only.
- [x] Deploy via `supabase_deploy_edge_function`.
- [x] Append the Phase 4 walkthrough to `docs/demo-script.md`.

**Implementation note:** this project's `write_file`/`edit_file` tooling flags files containing many literal `\n`/`\"` escape sequences as likely mistakes past a certain count, which blocked writing this file directly with normal JS string escapes. Worked around by introducing a `const NL = String.fromCharCode(10)` constant and building multi-line replies via `[...].join(NL)` instead of embedding `\n` in string literals. Future functions with multi-line WhatsApp replies should use the same pattern.

## Verification checklist (Phase 4)

- [x] A signed curl POST simulating a brand-new `wa_id` sending "Hi" creates a `conversation_sessions` row with `state='onboarding_name'` and gets the "what's your name" prompt (verified via `supabase_read_query` + response body).
- [x] Walking a full simulated conversation (name → company → role → industry → spend → email) advances `state` correctly at each step, confirmed by reading `conversation_sessions.state`/`.context` after each curl POST.
- [x] Submitting an invalid email (no `@`) re-prompts without advancing state or creating an `otp_sessions` row.
- [x] Submitting a valid email creates exactly one `otp_sessions` row with a hashed (not plaintext) code and `purpose='signup_email_verify'`.
- [x] Submitting the wrong OTP code increments `attempt_count` and does not create any `users`/`companies`/`whatsapp_accounts` row.
- [x] Submitting the wrong OTP code 5 times sets the `otp_sessions.status='locked'` and resets `conversation_sessions.state='new'`.
- [x] Submitting the correct OTP code creates exactly one `companies` row (new-company path) or zero new `companies` rows (existing-company path), exactly one `users` row, one `auth_methods` row, and one `whatsapp_accounts` row — confirmed via `supabase_read_query`. (Tested both paths: new company "Sharma Textiles Pvt Ltd" with `role='admin'`, and joining that same company as `role='viewer'`.)
- [x] Re-running the same `wa_id` through onboarding a second time (after already completing it) is skipped — the identity lookup finds the active `whatsapp_accounts` link and Phase 3's menu/echo logic runs instead.
- [x] Typing a company name that matches an existing seeded company (e.g. one from `companies.csv`) joins as `role='viewer'` against that existing `company_id`, not a new one. (Tested: "nimbusworks pvt ltd" correctly resolved to real seeded `COMP-01`.)
- [ ] Live test: a real WhatsApp number that has never messaged this business number before completes the full onboarding flow end-to-end and receives "Your FinCore account has been created." **Not yet run** — all verification above used simulated signed curl requests (with a direct-hash-injection technique to complete the OTP step without depending on Resend sandbox delivery reachability). Recommend the user run one live onboarding conversation from their own phone before considering this phase demo-ready; all test rows created during simulated testing were deleted from the database afterward.

All test companies/users/sessions created during verification (`Sharma Textiles Pvt Ltd`, `Lockout Co`, and associated wa_ids `919999888877`/`917777666655`/`915555444433`/`916666555544`) were deleted after verification — the database contains only the original seed data plus whatever the user creates live.

Phase 4 live verification is complete: a real Meta WhatsApp webhook delivery gap (WABA was subscribed to Meta's own internal app, not ours) was found and fixed by calling `POST /{waba_id}/subscribed_apps`; the outbound `WHATSAPP_ACCESS_TOKEN`/`WHATSAPP_PHONE_NUMBER_ID` secrets were refreshed; and one full live onboarding run (name → company → role → industry → spend → recovery email → OTP via Resend, using the tester's own Resend-account email since no verified sending domain exists yet) completed end-to-end with "Your FinCore account has been created." received on the real phone.

---

## Phase 5 — OTP account recovery + number linking

### Context

A user who already has a FinCore account (created via Phase 4 onboarding) needs a way to keep using FinCore after switching to a new WhatsApp number — currently that number is unrecognized and the `state==='new'` branch's `login`/`recover account` guard just replies "coming in a later phase." This phase implements the real recovery flow from §6 of this plan: verify the caller owns the registered recovery email via OTP, then link this new `wa_id` to their existing `user_id` (deactivating the old number's link).

### Design decisions

- **Two new conversation states**, following the exact same same-file state-machine pattern as Phase 4: `recovery_email` (ask for + resolve the registered recovery email) → `recovery_otp` (verify the code, then link).
- **Trigger**: in the existing `state === "new"` branch, replace the current "coming in a later phase" stub for `/^(login|recover( account)?)/i` with a transition to `recovery_email`. No change to the onboarding trigger (any other text still starts fresh onboarding).
- **Email resolution**: look up `auth_methods` where `method_type='recovery_email'`, `value ilike <input>`, `verified_at is not null`, `limit(1)` — then load the matching `users` row for `name`/`company_id`/`account_status`. Not found → stay in `recovery_email`, reply that no account was found, suggest `Hi` to sign up or retry with a different email (no separate lockout for lookup misses, matching the literal spec — only OTP attempts are rate-limited/locked). `account_status` of `Locked`/`Suspended` → reply that the account is locked, reset to `state='new'`.
- **Rate limiting** (§6.5): before creating a new `otp_sessions` row, count rows where `requester_phone = waId AND purpose = 'account_recovery' AND created_at > now() - interval '1 hour'`; if `>= 5`, reply to try again later without creating a new row or sending an email (no DB write beyond the read).
- **OTP mechanics reuse Phase 4's helpers as-is**: `generateOtp()`, `sha256Hex()`, `sendOtpEmail()`, same 10-minute expiry / 5-attempt lockout shape as `onboarding_otp`, but `purpose='account_recovery'` and `otp_sessions.user_id` set to the resolved user (nullable field Phase 4 left null — recovery is the first case that populates it).
- **Lockout has one extra effect not present in Phase 4**: on the 5th wrong attempt, also set `users.account_status='Locked'` for the resolved user (mirrors the seeded `failed_login_attempts` semantics from §6.3) and write an `account_locked` row to `auth_log`. Phase 4's onboarding lockout never touches `users` because no `users` row exists yet at that point.
- **`auth_log` writes** (event types already allowed by the existing `auth_log_event_type_check` constraint — no migration needed): `otp_requested` when the recovery code is sent, `otp_verified` on correct code, `login_success` once the number is linked, `login_failed` when the email lookup fails or the account is locked/suspended, `account_locked` on 5th wrong attempt. `ip_address` is not available from a WhatsApp inbound payload — left `null`; `device='whatsapp'`. `log_id` generated with the existing `newId("LOG")` convention.
- **On successful verification**: set any existing `whatsapp_accounts` rows for that `user_id` with `status='active'` to `status='unlinked'` (deactivate the old number), insert a new `whatsapp_accounts` row for this `wa_id` (`status='active'`, `linked_at=now()`), set `conversation_sessions.state='active'`, clear `context`, reply "Welcome back, {name}!" + `MENU_TEXT`.
- **No new tables/columns/migrations** — `otp_sessions.user_id`, `otp_sessions.purpose='account_recovery'`, and all `auth_log` event types used here already exist in the schema (confirmed via `supabase_get_table_schema` + constraint definitions).

### Files

- `supabase/functions/whatsapp-webhook/index.ts` — extend `OnboardingContext` with `recoveryUserId`, `recoveryName`, `recoveryCompanyId`; change the `state === "new"` recovery-trigger branch; add `recovery_email` and `recovery_otp` cases to the `switch` in `handleOnboardingMessage` (same function, no new file — consistent with the Phase 3/4 rationale already documented above for why onboarding/OTP logic stays same-file).
- `docs/demo-script.md` — append curl walkthrough for: recovery trigger, email-not-found, locked-account, correct-email OTP send, wrong-code, 5x-lockout (confirms `users.account_status` flips), correct-code (confirms old number's `whatsapp_accounts` row flips to `unlinked` and the new one is `active`).
- `.enter/plans/fincore-ai-architecture.md` (this file) — check off items below as completed.

### Implementation checklist (Phase 5)

- [x] In the `state === "new"` branch of `handleOnboardingMessage`, replace the "coming in a later phase" stub with a transition to `recovery_email` for input matching `/^(login|recover( account)?)/i`.
- [x] Add `recovery_email` case: validate email shape (reuse `isValidEmail`); resolve via `auth_methods` (`method_type='recovery_email'`, `verified_at is not null`, case-insensitive match) joined to `users`.
- [x] Not-found path: reply without creating any row, session stays in `recovery_email`.
- [x] Locked/Suspended account path: reply account is locked, reset `state='new'`, insert `auth_log(event_type='login_failed')`.
- [x] Rate-limit check (≥5 `otp_sessions` rows with `purpose='account_recovery'` from this `requester_phone` in the last hour) before creating a new OTP; reply to wait, no new row created if exceeded.
- [x] On a resolvable, unlocked account under the rate limit: generate + hash OTP, insert `otp_sessions` (`purpose='account_recovery'`, `user_id=<resolved>`, `requester_phone=waId`, `expires_at=now()+10min`, `max_attempts=5`), send via `sendOtpEmail`, insert `auth_log(event_type='otp_requested')`, advance to `recovery_otp` with `recoveryUserId`/`recoveryName`/`recoveryCompanyId` in context.
- [x] Add `recovery_otp` case mirroring `onboarding_otp`'s expiry/hash-mismatch/attempt-increment logic.
- [x] On the 5th wrong attempt: `otp_sessions.status='locked'`, `users.account_status='Locked'` for `recoveryUserId`, `auth_log(event_type='account_locked')`, reset `state='new'`.
- [x] On correct code: `otp_sessions.status='verified'`, `auth_log(event_type='otp_verified')`, set prior active `whatsapp_accounts` row(s) for `recoveryUserId` to `status='unlinked'`, reuse an existing unique phone-number row or insert a new `whatsapp_accounts` row (`status='active'`), `auth_log(event_type='login_success')`, set `conversation_sessions.state='active'` and clear `context`, reply "Welcome back" + `MENU_TEXT`.
- [x] Never leak the OTP value or internal errors in any WhatsApp-visible reply; log detail server-side only (same rule as Phase 4).
- [x] Deploy via `supabase_deploy_edge_function`.
- [ ] Append the Phase 5 walkthrough to `docs/demo-script.md`.

### Verification checklist (Phase 5)

- [x] Signed curl simulating an unlinked `wa_id` sending "login" transitions `conversation_sessions.state` to `recovery_email` and gets the email prompt.
- [x] Submitting an email with no matching `auth_methods` row replies with the not-found message and creates zero `otp_sessions` rows.
- [x] Submitting the recovery email of a seeded/created account whose `users.account_status` is not `Active` replies with the locked/suspended message and resets `state='new'` without creating an `otp_sessions` row.
- [x] Submitting a valid, resolvable, active-account email creates exactly one `otp_sessions` row (`purpose='account_recovery'`, hashed code, `user_id` set) and one `auth_log` row (`event_type='otp_requested'`).
- [x] Submitting the wrong code increments `attempt_count` and does not modify `whatsapp_accounts` or `users`.
- [x] Submitting the wrong code 5 times sets `otp_sessions.status='locked'`, flips `users.account_status='Locked'` for that user, inserts an `auth_log(event_type='account_locked')` row, and resets `conversation_sessions.state='new'`.
- [x] Submitting the correct code links the new `wa_id` (`whatsapp_accounts.status='active'`) to the existing `user_id`, flips any prior active `whatsapp_accounts` row for that same `user_id` to `status='unlinked'`, inserts `auth_log` rows for `otp_verified` and `login_success`, and returns the full user to the menu (`state='active'`).
- [x] Requesting a 6th OTP within one hour from the same `wa_id` is blocked by the rate limit with no new `otp_sessions` row created.
- [x] A number that recovers into an account, then sends ordinary text afterward, is routed through `buildReply` (Phase 3 menu/echo) rather than onboarding — confirms the identity lookup at the top of the webhook now finds the newly linked `whatsapp_accounts` row.
- [x] All synthetic test rows created during this verification (test companies/users/otp_sessions/whatsapp_accounts/auth_log/conversation_sessions) are deleted afterward, leaving only seed data plus real user-created rows.
- [x] Live test: the user completed one real recovery conversation from the existing Phase 4 WhatsApp number after simulating an unlinked number, received the OTP by email, submitted it on WhatsApp, and received `Welcome back` + the full menu; the unique-number relink conflict was fixed and redeployed.

---

## Phase 6 — WhatsApp invoice upload + Enter Cloud Storage

### Context

Onboarded users currently receive only a placeholder when they send an image or document. Phase 6 turns that path into a real invoice-ingest flow: accept PDF/JPG/PNG media from WhatsApp, fetch the media from Meta using the media ID, enforce the confirmed 10 MB limit, store the original privately in Enter Cloud Storage, create the existing `invoices` record with `status='Pending'` and `source_channel='whatsapp_bot'`, and reply with the created invoice ID. OCR, validation, duplicate detection, vendor risk, budgeting, anomaly scoring, and decisions remain Phase 7+ work.

### Confirmed scope

- **Input channel:** WhatsApp only in this phase; no dashboard upload UI.
- **Allowed types:** PDF, JPEG/JPG, PNG.
- **Maximum size:** 10 MB (10,485,760 bytes).
- **Storage:** private bucket `fincore-invoices`; object path `invoices/{company_id}/{invoice_id}.{ext}`. Never expose a public URL; persist only the storage path in `invoices.file_storage_path`.
- **Invoice metadata:** because extraction is not yet available, create a Pending invoice using one company-scoped placeholder vendor named `Pending Vendor` (reuse it if already present; otherwise create exactly one `VEN-PENDING-<company suffix>` vendor row with neutral metadata). Leave extracted financial fields at safe zero/null values only where the existing schema permits them. Do not invent invoice totals or vendor facts.

### Design

- Extend the webhook's media model to retain `media.id`, MIME type, filename, and caption; the existing `summarizeInboundMessage` result can remain the user-facing content summary while the full message is passed to a same-file ingest helper.
- For an identified active sender, route `image`/`document` before `buildReply` to `ingestWhatsAppInvoice`. Unidentified senders continue receiving the onboarding text-only prompt and must not create invoice rows.
- `ingestWhatsAppInvoice` calls Meta Graph `/{media_id}` with the WhatsApp access token, then downloads the returned media URL with the same token. It rejects unsupported MIME types, missing media IDs, download failures, and bodies over 10 MB before storage/database writes.
- Generate an `INV-<8 hex>` ID using the established `newId` helper. Upload bytes to the private `fincore-invoices` bucket with the service-role Storage client, then insert `invoices` using the identified user's `company_id` and `submitted_by`; if the database insert fails, remove the just-uploaded object to avoid orphaned files.
- Store a `conversation_messages` outbound reply only after the ingest result is known; reply with success (`Invoice INV-... received and queued for analysis.`) or a concise user-safe rejection. Log technical details server-side only.
- Keep all implementation in `supabase/functions/whatsapp-webhook/index.ts` initially because this project's bundler does not resolve cross-function `_shared/` imports. A separate `invoice-ingest` backend function remains a later refactor once the platform bundler constraint is addressed.

### Files

- `supabase/functions/whatsapp-webhook/index.ts` — media fields, Meta media fetch/download helper, size/type validation, Storage upload, invoice insert, and active-sender routing.
- `supabase/migrations/<phase-6-migration>` — create the private `fincore-invoices` storage bucket and narrowly scoped Storage policies only if the platform's Storage schema requires SQL provisioning; preserve all existing tables/data.
- `docs/demo-script.md` — media upload walkthrough and rejection cases.
- `.enter/plans/fincore-ai-architecture.md` — phase checklist and verification evidence.

### Implementation checklist (Phase 6)

- [x] Inspect current Storage bucket/policy state before provisioning `fincore-invoices`; preserve any existing buckets and rows (bucket was absent; creation is lazy and private on first valid upload).
- [x] Extend the inbound WhatsApp types and extraction path to retain media ID, MIME type, filename, and caption for image/document messages.
- [x] Add `ingestWhatsAppInvoice` with Meta media metadata fetch, authenticated binary download, allowed-type validation, and 10 MB byte-limit validation.
- [x] Provision/use private `fincore-invoices` Storage and upload to `invoices/{company_id}/{invoice_id}.{ext}` without public URLs.
- [x] Reuse or create exactly one company-scoped `Pending Vendor` row (`VEN-PENDING-<company suffix>`) for invoices whose vendor is not yet extracted; do not create fabricated vendor financial data.
- [x] Insert a Pending `invoices` row with `source_channel='whatsapp_bot'`, `file_storage_path`, company/user ownership, and only schema-valid placeholder fields.
- [x] Delete the uploaded object when a later database insert fails; never leave an orphaned object from a failed ingest.
- [x] Route active-sender images/documents into ingest and leave onboarding media behavior unchanged for unidentified senders.
- [x] Return user-safe success/rejection messages and keep Meta/Storage/database error details server-side only.
- [x] Deploy the updated backend function and append the Phase 6 demo steps.

### Verification checklist (Phase 6)

- [x] Signed simulated active-user image payload with a valid Meta media ID creates one Pending invoice and one private Storage object at the expected company path (confirmed through the live Meta delivery path).
- [ ] Signed simulated active-user PDF payload creates one Pending invoice and preserves the original filename extension.
- [ ] Unsupported MIME type is rejected without an invoice row or Storage object.
- [ ] A downloaded body exactly at 10 MB is accepted; a body at 10 MB + 1 byte is rejected without a database row or object.
- [ ] Meta metadata/download failure returns a safe WhatsApp reply and creates no invoice/object.
- [ ] Database insert failure removes the just-uploaded object.
- [ ] An unlinked sender's image/document still receives onboarding guidance and creates no invoice/object.
- [x] Existing seeded invoices, vendors, companies, and prior live account/recovery rows remain unchanged by the live upload.
- [x] Lint, TypeScript, production build, backend deployment, and the real test number's invoice queued acknowledgement all passed; database verification confirmed `status='Pending'`, `source_channel='whatsapp_bot'`, private bucket `fincore-invoices`, path `invoices/CO-4907F5EF/INV-59684708.jpg`, and `VEN-PENDING-4907F5EF`. 

Phase 6 live verification is complete for a real WhatsApp image upload on 2026-09-18. The source image is stored privately and the invoice is intentionally awaiting Phase 7 extraction.

---

## Phase 7 — AI OCR/extraction + deterministic validation

### Context

The first live invoice (`INV-59684708`) is safely stored but still has zero placeholder totals and a `Pending Vendor`. Phase 7 uses the enabled Enter AI All capability with the selected **Qwen 3.7 Plus** model to read the stored invoice image, return structured fields, validate the extracted facts deterministically, and persist the result to the existing `invoice_analysis` table. AI may extract and describe facts visible in the document, but it must not invent missing values or make approval/risk decisions; duplicate detection, vendor risk, budget impact, anomaly scoring, and the decision engine remain later phases.

### Design decisions

- **Model/protocol:** Qwen 3.7 Plus through Enter AI All's OpenAI Chat Completions protocol (`POST https://api.enter.pro/code/api/v1/ai/chat/completions`), using the project AI secret server-side and `X-Enter-Project-ID`; no user-supplied provider key.
- **Input:** read the private Storage object with the service-role client, encode it as a data URL, and send it to Qwen as an image content part. JPG/PNG are supported for this phase. PDF remains stored/Pending and receives a clear "PDF extraction will be enabled in the next extraction update" response unless a verified PDF-to-image path is added; do not send unsupported PDF content to the model.
- **Strict output:** prompt for one JSON object only: invoice number, vendor name, invoice date, due date, currency, subtotal, tax amount, total amount, PO number, payment terms, department, description, confidence, and line items. Missing values must be `null`; never guess. Parse defensively and reject malformed/non-object output.
- **Validation:** deterministic checks after parsing: required invoice date/total, non-negative numeric amounts, subtotal + tax approximately equals total, valid date ordering, confidence range 0–1, and line-item sum consistency when line items are present. Store a `validation_result` object with `valid`, `errors`, and `warnings` regardless of validity.
- **Persistence:** update `invoices` with extracted vendor-independent fields and `ocr_confidence`; insert one `invoice_analysis` row with `extracted_fields` and `validation_result`. Keep `status='Pending'` until the later decision engine. Update the placeholder vendor name only when the extracted vendor name is non-empty and a safe same-company vendor match exists; do not create a new vendor from OCR yet.
- **Failure behavior:** if AI is unavailable, output is malformed, or the image cannot be read, preserve the stored invoice and respond that extraction needs retry; do not delete the invoice or fabricate values. Technical errors remain server-side logs.
- **Execution location:** extend the existing webhook path after successful Phase 6 ingestion, keeping implementation in the same file because this project's backend bundler does not resolve `_shared/` imports. The first implementation may run synchronously for the live demo; a later refactor can move long-running analysis to a separate chained backend function.

### Files

- `supabase/functions/whatsapp-webhook/index.ts` — Enter AI request, image data URL preparation, strict JSON parsing, deterministic validation, invoice/invoice_analysis persistence, and post-upload response.
- `docs/demo-script.md` — Phase 7 OCR walkthrough and malformed/low-confidence cases.
- `.enter/plans/fincore-ai-architecture.md` — Phase 7 checklist and verification evidence.

### Implementation checklist (Phase 7)

- [ ] Add server-only AI constants using `AI_API_TOKEN_207130282296` and the exact Enter AI All base URL/project header.
- [ ] Add a Qwen 3.7 Plus OpenAI Chat Completions request with image data URL content, `stream:false`, strict JSON extraction instructions, and a stable session ID.
- [ ] Add defensive JSON parsing that accepts a fenced JSON response only when the decoded value is an object and rejects missing/guessed fields safely.
- [ ] Implement deterministic validation for totals, dates, numeric ranges, confidence, and line-item consistency.
- [ ] Persist `invoice_analysis.extracted_fields` and `.validation_result`, update extracted invoice columns and `ocr_confidence`, and preserve `status='Pending'`.
- [ ] Keep the existing company-scoped Pending Vendor unless a same-company vendor match is already present; never create a vendor solely from an unverified OCR name.
- [ ] Return a WhatsApp success message with invoice number, extracted total/currency, and validation status without exposing raw model output.
- [ ] Return a safe retry response on AI timeout/error/malformed output while preserving the Phase 6 invoice and Storage object.
- [ ] Deploy the updated backend function and append the Phase 7 demo steps.

### Verification checklist (Phase 7)

- [ ] The live stored JPG invoice produces one `invoice_analysis` row with structured extracted fields and a confidence value between 0 and 1.
- [ ] A valid extraction updates the existing invoice's date, totals, currency, due date/PO when present, and leaves `status='Pending'`.
- [ ] Validation marks the live invoice valid or records explicit errors/warnings without inventing values.
- [ ] A malformed model response creates no partial analysis row and leaves the invoice safely Pending.
- [ ] An AI timeout/4xx response produces a safe WhatsApp message and preserves the source object and invoice row.
- [ ] A PDF upload remains stored and Pending without being sent through the unsupported image-only extraction path.
- [ ] Existing invoices, vendors, companies, account links, and recovery records remain unchanged except for the explicitly analyzed invoice.
- [ ] Lint, TypeScript, production build, backend deployment, and one real WhatsApp extraction response pass.

---

## Phase 8 — Duplicate detection + vendor intelligence

### Context

Phase 7 now extracts invoice facts and validates them, but it does not compare the invoice against company history or explain vendor risk. Phase 8 adds deterministic duplicate scoring and computed vendor intelligence using the existing invoices, payments, vendor bank changes, prior analyses, and decisions. The result is persisted into the same `invoice_analysis` row and reported in WhatsApp; AI is not used for scoring or approval decisions.

### Design decisions

- **Execution:** run immediately after successful Phase 7 extraction for image invoices; PDFs remain stored/Pending until extraction is available. Keep the first implementation in `whatsapp-webhook/index.ts` because of the current bundler constraint.
- **Duplicate scope:** compare only invoices in the same company and same resolved vendor, excluding the current invoice. Score explainable signals: exact invoice number match (highest weight), amount proximity, date proximity, PO match, and normalized description similarity. Return a 0–100 score, best match, top five matches, and evidence strings.
- **Vendor risk scope:** compute from current vendor status, invoice count/total/average, recent 90-day activity, completed payment on-time rate, prior duplicate flags in `invoice_analysis`, and bank-account changes within 30 days. Never use `vendors.risk_profile` as the computed result; retain it only as a static reference.
- **Persistence:** update the existing `invoice_analysis` row with `duplicate_score`, `duplicate_evidence`, and `vendor_risk_snapshot`; do not create a second analysis row. Keep invoice `status='Pending'` until the decision engine phase.
- **User response:** after OCR validation, send a second concise WhatsApp result containing duplicate score, vendor risk (`Low`/`Medium`/`High`), and the strongest reason. Do not claim approval/rejection yet.
- **No destructive cleanup:** the five duplicate invoices already created by the earlier Meta retry are preserved. The new receipt guard prevents future duplicate processing; Phase 8 scoring must treat them as history and surface their similarity transparently.

### Files

- `supabase/functions/whatsapp-webhook/index.ts` — deterministic scoring helpers, history queries, analysis update, and WhatsApp summary.
- `docs/demo-script.md` — duplicate and vendor-risk walkthrough with boundary cases.
- `.enter/plans/fincore-ai-architecture.md` — Phase 8 checklist and verification evidence.

### Implementation checklist (Phase 8)

- [x] Add deterministic duplicate scoring helpers with exact invoice-number, amount, date, PO, and description signals plus evidence.
- [x] Query same-company vendor history, payments, bank changes, prior analysis rows, and current vendor metadata through the Enter Cloud client.
- [x] Add computed vendor-risk scoring with explicit points and reasons for blacklist/review status, payment performance, duplicate history, recent bank changes, and new-vendor spend.
- [x] Update the existing `invoice_analysis` row without creating a duplicate analysis record.
- [x] Keep invoice status Pending and do not create approval/decision rows in Phase 8.
- [x] Send a second WhatsApp message with duplicate score, vendor risk, and top evidence after extraction.
- [x] Preserve existing invoices and duplicate history; use the new receipt table to prevent repeated Meta message processing.
- [x] Deploy the updated backend function and append the Phase 8 demo steps.

### Verification checklist (Phase 8)

- [ ] A newly extracted invoice with no comparable history receives duplicate score 0 and a low-risk/no-history explanation.
- [ ] An exact invoice-number match scores at the configured high-similarity boundary and includes explicit matching evidence.
- [ ] Near-equal amount plus nearby date plus matching PO produces a higher score than any single signal alone.
- [ ] A blacklisted/under-review vendor or recent bank change raises computed risk with explicit reasons.
- [ ] Completed payments with due dates produce a correct on-time payment rate; missing payment dates do not crash the calculation.
- [ ] `invoice_analysis` remains one row per invoice after Phase 8 enrichment.
- [ ] The five previously created duplicate invoices remain untouched and are used only as comparison history.
- [ ] Lint, TypeScript, production build, backend deployment, and one real WhatsApp duplicate/vendor-risk response pass.

---

## Phase 9 — Budget impact + anomaly detection

### Context

Phase 8 now produces duplicate and vendor-risk facts, but it does not show how a new invoice affects the department budget or whether multiple transparent anomaly signals are present. Phase 9 adds deterministic budget projection and anomaly scoring, using the existing `budgets`, invoice history, bank changes, OCR confidence, duplicate score, and vendor history. It persists explainable results without creating an approval decision.

### Design decisions

- **Execution:** run after Phase 8 enrichment for image invoices in the existing webhook path. PDFs remain stored/Pending until extraction.
- **Budget period:** use the extracted invoice date's `YYYY-MM` and the invoice department. If no matching budget exists, persist `found=false` with a medium-impact default and explicit `Budget not found` warning; never invent an allocation.
- **Budget math:** `projectedSpent = spent + invoice total`, `projectedRemaining = allocated - projectedSpent`, utilization percentages from allocated, and impact `low`/`medium`/`high` at 70%/95% projected utilization. Reuse the same arithmetic as `src/lib/fincore/budgetImpact.ts`.
- **Anomaly signals:** port the deterministic signals from `src/lib/fincore/anomaly.ts`: duplicate invoice, vendor spend spike, new-vendor-large-invoice, missing PO high value, recent bank change, round-number pattern, split-invoice suspicion, off-hours submission, low OCR confidence, and abnormal budget impact. Each signal carries a named description and explicit weight; cap total at 100.
- **Thresholds:** read company-specific rows from `decision_rules_config` when available, otherwise use the established defaults (`budgetReviewThresholdPct=85`, `vendorAmountMultiplierThreshold=3`, `bankChangeLookbackDays=30`, `anomalyReviewThreshold=60`). No decision row is created in Phase 9.
- **Persistence:** update the existing `invoice_analysis` row with `budget_impact`, `anomaly_score`, and `anomaly_reasons`; leave invoice `status='Pending'`.
- **User response:** add a final WhatsApp message with projected utilization, anomaly score, and the top one or two signal reasons. Keep OCR, duplicate/vendor, budget, and anomaly stages separate so a later stage failure preserves prior results.

### Files

- `supabase/functions/whatsapp-webhook/index.ts` — budget query, anomaly helpers, thresholds, analysis update, and final WhatsApp summary.
- `docs/demo-script.md` — Phase 9 examples and boundary cases.
- `.enter/plans/fincore-ai-architecture.md` — Phase 9 checklist and verification evidence.

### Implementation checklist (Phase 9)

- [x] Add budget projection arithmetic with explicit no-budget behavior.
- [x] Load applicable company thresholds with safe defaults.
- [x] Add deterministic anomaly signal helpers and cap the score at 100.
- [x] Query same-company nearby invoice history needed for split-invoice and spend-spike signals.
- [x] Update the existing `invoice_analysis` row with `budget_impact`, `anomaly_score`, and `anomaly_reasons` without changing invoice status.
- [x] Send a final WhatsApp response containing budget utilization and anomaly score/reasons.
- [x] Preserve prior OCR, duplicate, and vendor-risk facts if Phase 9 encounters an error.
- [x] Deploy and append the Phase 9 demo walkthrough.

### Verification checklist (Phase 9)

- [ ] A matching department/period budget returns correct before/after utilization and remaining amount.
- [ ] A missing budget returns `found=false` and does not invent allocation or spend.
- [ ] A high projected utilization triggers the budget anomaly signal with explicit evidence.
- [ ] A low OCR confidence invoice triggers `low_ocr_confidence_needs_review`.
- [ ] A recent bank change, duplicate score, large vendor multiplier, or missing high-value PO triggers the corresponding named signal.
- [ ] Anomaly score is capped at 100 and every persisted signal has a description and weight.
- [ ] `invoice_analysis` remains one row per invoice and invoice status remains `Pending`.
- [ ] Lint, TypeScript, production build, backend deployment, and one real WhatsApp budget/anomaly response pass.

---

## Phase 10 — Deterministic decision engine + explainable recommendation

### Context

Phases 7–9 now persist validation, duplicate similarity, vendor risk, budget impact, and anomaly facts. Phase 10 applies the established deterministic decision rules to those facts and records an auditable recommendation. The model is not asked to decide; its only prior role was extracting visible invoice facts.

### Design decisions

- **Rule order:** reuse the exact precedence from `src/lib/fincore/decisionEngine.ts`: duplicate threshold → critical validation issues → high vendor risk → recent bank change → budget defer/review thresholds → anomaly threshold → APPROVE default.
- **Thresholds:** use the same company-specific `decision_rules_config` values with established defaults when absent.
- **Persistence:** insert exactly one `decisions` row per invoice using a deterministic `DEC-<8 hex>` ID; if a decision already exists for that invoice, update it rather than creating a second row. Store action, recommendation, reasons, confidence, and `decided_by='system_rules'`.
- **Invoice status:** do not change invoice status automatically; the action is a recommendation until Phase 12's explicit workflow action path. This avoids silently approving or rejecting user financial records.
- **Explanation:** send a final WhatsApp message with action, recommendation, and ordered reasons from the engine. No new AI call is needed; the reasons list is the source of truth.
- **Failure isolation:** if decision persistence fails, preserve all prior analysis rows and send a safe retry message rather than claiming a decision was saved.

### Files

- `supabase/functions/whatsapp-webhook/index.ts` — rule evaluation, decision upsert, and final WhatsApp response.
- `docs/demo-script.md` — Phase 10 examples and threshold-boundary cases.
- `.enter/plans/fincore-ai-architecture.md` — Phase 10 checklist and verification evidence.

### Implementation checklist (Phase 10)

- [x] Add deterministic decision evaluation matching `decisionEngine.ts` precedence and labels.
- [x] Load validation, duplicate, vendor-risk, budget, and anomaly facts from the existing invoice records.
- [x] Load company thresholds with the same safe defaults used in Phase 9.
- [x] Upsert exactly one `decisions` row with recommendation, action-derived label, reasons, and `decided_by='system_rules'`.
- [x] Keep invoice status unchanged and do not perform approval/rejection side effects.
- [x] Send a WhatsApp summary with action and explainable reasons.
- [x] Deploy and append the Phase 10 demo walkthrough.

### Verification checklist (Phase 10)

- [ ] A high duplicate score produces `REVIEW` / `Hold - Duplicate Suspected` before other rules.
- [ ] Two critical validation issues produce `REJECT`; one critical issue produces `REVIEW`.
- [ ] High vendor risk or recent bank change produces `REVIEW`.
- [ ] Budget utilization at/above defer threshold produces `DEFER`; review threshold produces `REVIEW`.
- [ ] Anomaly score at/above threshold produces `REVIEW`; otherwise the default is `APPROVE`.
- [ ] Reprocessing the same invoice updates one decision row rather than inserting duplicates.
- [ ] Invoice status remains `Pending` for every recommendation.
- [ ] Lint, TypeScript, production build, backend deployment, and one real WhatsApp decision response pass.

---

## Phase 11 — Natural-language financial Q&A

### Context

The current active-user text path still returns a generic echo. Phase 11 lets an onboarded user ask controlled financial questions in normal language, such as monthly spend, remaining budget, pending invoices, risky invoices, top vendors, and cash flow. Numbers are computed from Enter Cloud data by fixed query branches; Qwen 3.7 Plus may only turn the returned facts into a concise explanation and may not invent or calculate values.

### Design decisions

- **Identity/security:** only active `whatsapp_accounts` links can access Q&A; all queries are scoped by the linked user's `company_id`. Unlinked text remains onboarding behavior.
- **Intent routing:** implement a deterministic keyword/regex router ported from `src/lib/fincore/queries.ts`: overview/spend, top vendor, pending invoices, risk alerts, over-budget departments, remaining budget, affordability, cash flow forecast, and spend contributors. Unknown questions receive a supported-topics prompt.
- **Controlled data access:** each intent uses explicit Supabase client queries with fixed selected columns and bounded result sizes. No raw SQL, user-provided table/column names, arbitrary filters, or client-side privilege decisions.
- **AI explanation:** send the structured fact payload plus the original question to Qwen 3.7 Plus using the existing OpenAI Chat Completions integration, `stream:false`, temperature 0, and a strict instruction to quote only supplied facts. If AI fails, return the deterministic fact summary instead of failing the Q&A request.
- **Response limits:** keep WhatsApp responses concise and cap lists to five rows. Preserve forecast disclaimers and clearly state when no budget or data exists.
- **No writes:** Phase 11 only reads business data; it does not create decisions, change invoice status, or mutate budgets.

### Files

- `supabase/functions/whatsapp-webhook/index.ts` — controlled Q&A intent router, company-scoped queries, Qwen explanation, and active-user text routing.
- `docs/demo-script.md` — Q&A examples, unsupported questions, and company-isolation checks.
- `.enter/plans/fincore-ai-architecture.md` — Phase 11 checklist and verification evidence.

### Implementation checklist (Phase 11)

- [ ] Add explicit Q&A intent classification for overview, spend, vendors, pending invoices, risks, budgets, affordability, and forecast questions.
- [ ] Add company-scoped read-only query handlers with bounded output and no arbitrary SQL.
- [ ] Add a deterministic fallback response for unknown intents and empty datasets.
- [ ] Add Qwen fact-grounded explanation using the existing AI secret and project attribution headers.
- [ ] Route active-user text through Q&A before the generic echo fallback, while preserving `menu` behavior.
- [ ] Keep Q&A read-only and preserve forecast disclaimers.
- [ ] Deploy and append the Phase 11 demo walkthrough.

### Verification checklist (Phase 11)

- [ ] "How much did we spend this month?" returns the scoped company's spend and budget utilization.
- [ ] "Which vendor has the highest spend?" returns bounded ranked vendors from that company only.
- [ ] Pending/risk/budget/affordability/forecast questions return the corresponding controlled facts.
- [ ] Unknown questions return supported topics without an AI hallucinated answer.
- [ ] AI failure still returns deterministic facts and never exposes internal errors.
- [ ] A user linked to Company A cannot receive Company B's invoices, vendors, budgets, or transactions.
- [ ] Q&A does not insert/update any business rows.
- [ ] Lint, TypeScript, production build, backend deployment, and real WhatsApp Q&A responses pass.
