# Seed data — mapping notes

Source: `datasets.zip` (attached by the user), staged in this repo at `docs/seed-data/*.csv`. These are synthetic/demo datasets, not real financial data.

## Column derivations (CSV → schema)

- `invoices.subtotal` = CSV `invoices.amount`
- `invoices.total_amount` = CSV `invoices.amount` + CSV `invoices.tax_amount`
- All other columns are a direct 1:1 copy — see `docs/database-schema.sql` for exact target types.

## Fields intentionally imported but never used by runtime logic

- `users.legacy_password_hash` (from CSV `users.password_hash`) — provenance only. WhatsApp auth uses phone-linking + email OTP; the admin dashboard uses Enter Cloud Auth's own credential store. This column is never read by any login path.
- `demo_anomaly_answer_key` (from `anomaly_answer_key.csv`) — labeled evaluation set for testing the anomaly engine's precision/recall (Phase 14). Never queried by WhatsApp or dashboard functions.
- `auth_log` (from `auth_log.csv`) — imported as history; new rows are appended by the OTP/recovery/dashboard-login backend functions going forward.

## Import order (respects foreign keys)

1. `companies`
2. `gl_accounts`
3. `users`
4. `vendors`
5. `vendor_bank_changes`
6. `invoices`
7. `payments`
8. `budgets`
9. `cash_transactions.csv` → `transactions` table
10. `decisions`
11. `auth_log`
12. `anomaly_answer_key.csv` → `demo_anomaly_answer_key` table

`invoice_items` is created empty — the dataset has no line-item breakdown; it will be populated by the OCR pipeline for real WhatsApp-submitted invoices (Phase 7 onward).

## Status

Not yet imported — pending Enter Cloud provisioning. Once Enter Cloud is enabled: run `docs/database-schema.sql` via the `supabase_migration` tool (in reviewable chunks), verify RLS with `supabase_get_table_schema`, then import each CSV above via `supabase_insert` in the order listed, and verify row counts match the source files.
