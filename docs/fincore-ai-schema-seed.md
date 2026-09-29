# FinCore AI — Apply Schema + Import Seed Data

## Context

FinCore AI's Phase 1 architecture plan (`.enter/plans/fincore-ai-architecture.md`) was completed when Enter Cloud provisioning was still blocked. Enter Cloud is now **connected** (verified: the database currently has **zero tables**), so the plan's next step is finally unblocked: apply the full schema from `docs/database-schema.sql` and import the real dataset from `docs/seed-data/*.csv`.

This session covers **only schema + seed data** (user-confirmed scope). No dashboard, webhook, or logic code.

**Ground truth confirmed during exploration** (actual CSV row counts differ slightly from the architecture doc's estimates — the CSVs win):
companies 5 · gl_accounts 12 · users 120 · vendors 110 · vendor_bank_changes 16 · invoices 337 · payments 321 · budgets 900 · transactions 5460 · decisions 300 · auth_log 515 · demo_anomaly_answer_key 109.

**Data-shape facts that drive the import approach:**
- Empty cells exist (`invoices.po_number` 45×, `invoices.contract_id` 211×) → must become `NULL`.
- Quoted fields contain commas (`gl_accounts.description`, `anomaly_answer_key.description`) → needs real CSV parsing.
- Apostrophes exist in `decisions.reasoning` (e.g. "vendor's") → escape as `''`.
- `invoices.subtotal` = CSV `amount`; `invoices.total_amount` = `amount + tax_amount`.
- Timestamps are `'YYYY-MM-DD HH:MM:SS'` text → PostgreSQL casts them to `timestamptz` natively.
- `mfa_enabled`/`is_recurring` are `True/False` text → `::boolean` cast works.
- All enum values (roles, statuses, channels, payment methods, event types, transaction types) already satisfy the schema's `check` constraints — verified.
- `decision_rules_config` seed text contains `%%` (was escaped for a doc templating context) → fix to single `%` in the applied SQL.

## Approach

### 1. Apply schema via `supabase_migration` (in reviewable chunks)
Database is empty → zero conflict risk. Run the schema from `docs/database-schema.sql` as 5 sequential migrations:
1. Core business tables (`companies` → `decisions`)
2. Auth/WhatsApp/conversation tables (`auth_methods` → `auth_log`)
3. Intelligence + dashboard + test tables (`invoice_analysis` → `demo_anomaly_answer_key`)
4. RLS enablement + `current_dashboard_company_id()` helper + all policies
5. Seed `decision_rules_config` (6 global defaults, with `%%`→`%` fix)

After each chunk, the schema is verified incrementally.

### 2. Import seed data via a generator script + `supabase_insert`
Hand-transcribing ~7,900 rows is error-prone, so write a one-time Node utility:
**`scripts/seed-sql.mjs`** — parses each CSV in `docs/seed-data/` (handles quoted fields, escapes single quotes, empty→NULL, casts True/False→boolean, computes invoice subtotal/total) and prints chunked `INSERT` statements to stdout. Chunks are sized so each printed batch stays well under the 30 KB stdout cap, then each chunk is passed to `supabase_insert` verbatim.

Mapping (source CSV → target table): `cash_transactions.csv` → `transactions`; `anomaly_answer_key.csv` → `demo_anomaly_answer_key`; all others 1:1. `invoice_items` stays empty (no line-item data exists — by design).

Import order (respects FK dependencies): companies → gl_accounts → users → vendors → vendor_bank_changes → invoices → payments → budgets → transactions → decisions → auth_log → demo_anomaly_answer_key.

### 3. Refresh the two doc status headers
After success, flip `docs/database-schema.sql` header from "NOT YET APPLIED" and `docs/seed-data/README.md` Status section from "Not yet imported" to reflect that the schema is applied and data is imported.

## Files
- `docs/database-schema.sql` — source of schema (applied via migration tool, `%%`→`%` fixed, header comment updated after apply)
- `docs/seed-data/*.csv` — source of seed data (read-only)
- `scripts/seed-sql.mjs` — **new** one-time CSV→SQL generator
- `docs/seed-data/README.md` — status note updated after import
- No changes to `src/`, no changes to any generated Supabase client files

## Implementation checklist
- [ ] Migration 1: core business tables created (companies, gl_accounts, users, vendors, vendor_bank_changes, invoices, invoice_items, payments, budgets, transactions, decisions)
- [ ] Migration 2: auth/conversation tables created (auth_methods, whatsapp_accounts, otp_sessions, conversation_sessions, conversation_messages, auth_log)
- [ ] Migration 3: intelligence/dashboard/test tables created (invoice_analysis, invoice_actions, risk_alerts, forecast_records, decision_rules_config, dashboard_admins, demo_anomaly_answer_key)
- [ ] Migration 4: RLS enabled on all 24 tables + `current_dashboard_company_id()` helper + all 14 dashboard SELECT policies
- [ ] Migration 5: `decision_rules_config` seeded with 6 global default rows (percent signs rendered as single `%`)
- [ ] `scripts/seed-sql.mjs` written: real CSV parsing (quoted commas), `''` escaping, empty→NULL, boolean/datetime casts, invoice subtotal/total computation, per-table chunked output
- [ ] Import `companies` (5) and `gl_accounts` (12)
- [ ] Import `users` (120) with `legacy_password_hash` populated from `password_hash`
- [ ] Import `vendors` (110) and `vendor_bank_changes` (16)
- [ ] Import `invoices` (337) with `subtotal`/`total_amount` computed and empty `po_number`/`contract_id` as NULL
- [ ] Import `payments` (321) and `budgets` (900)
- [ ] Import `transactions` (5460, from cash_transactions.csv) — chunked
- [ ] Import `decisions` (300, apostrophes escaped) and `auth_log` (515)
- [ ] Import `demo_anomaly_answer_key` (109)
- [ ] Update doc status headers in `docs/database-schema.sql` and `docs/seed-data/README.md`

## Verification checklist
- [ ] `supabase_get_table_schema` shows all 24 tables with RLS enabled and policies present where designed
- [ ] Row counts per table exactly match source CSVs: 5/12/120/110/16/337/321/900/5460/300/515/109 (verified by `SELECT count(*)` per table)
- [ ] Unauthenticated/anon query returns 0 rows on WhatsApp-facing tables (default-deny) — e.g. `select count(*) from otp_sessions` as anon
- [ ] FK spot-checks resolve: a sampled `invoices` row's `vendor_id`/`company_id` match the vendor/company names from the CSVs; `decisions.invoice_id` and `payments.invoice_id` resolve to real invoices
- [ ] Computed-column spot-check: `subtotal + tax_amount = total_amount` for a random sample of invoices
- [ ] `decision_rules_config` has exactly 6 rows with all keys (`duplicate_review_threshold`, `budget_review_threshold_pct`, `budget_defer_threshold_pct`, `anomaly_review_threshold`, `vendor_amount_multiplier_threshold`, `bank_change_lookback_days`)
- [ ] `invoice_items` is empty; `legacy_password_hash` is populated but never referenced in any code path
