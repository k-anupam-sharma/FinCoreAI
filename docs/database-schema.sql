-- FinCore AI — Database schema (Phase 1 draft)
--
-- STATUS: NOT YET APPLIED. Enter Cloud is not provisioned for this project yet.
-- This file is a ready-to-run reference. Once Enter Cloud is enabled, this
-- content will be applied via the `supabase_migration` tool (in reviewable
-- chunks, with RLS verified after creation) rather than by hand-editing
-- migration files. Do not run this file directly against any database.
--
-- Source of truth for field lists: /.enter/plans/fincore-ai-architecture.md

-- =========================================================================
-- SECTION 1 — Core business entities (imported from datasets.zip)
-- =========================================================================

create table companies (
  company_id text primary key,           -- e.g. 'COMP-01' (kept from CSV)
  name text not null,
  industry text,
  country text,
  plan_tier text,
  created_at timestamptz not null default now()
);

create table gl_accounts (
  gl_code text primary key,              -- e.g. '6100'
  category text not null,
  description text
);

create table users (
  user_id text primary key,              -- 'USR-0001' from CSV, or new uuid text for WhatsApp signups
  name text not null,
  email text not null unique,
  legacy_password_hash text,             -- imported for provenance ONLY — never used by any login path
  role text not null check (role in ('admin','ap_clerk','auditor','department_head','finance_manager','viewer')),
  company_id text not null references companies(company_id),
  mfa_enabled boolean not null default false,
  account_status text not null default 'Active' check (account_status in ('Active','Locked','Suspended')),
  failed_login_attempts int not null default 0,
  last_login_at timestamptz,
  created_at timestamptz not null default now()
);

create table vendors (
  vendor_id text primary key,            -- 'VEN-0001'
  company_id text not null references companies(company_id),
  name text not null,
  category text,
  risk_profile text check (risk_profile in ('Low','Medium','High')), -- legacy label, NOT the computed risk (see vendorRisk.ts)
  status text not null default 'Active' check (status in ('Active','Blacklisted','Under Review')),
  bank_name text,
  bank_account_number text,
  tax_id text,
  onboarded_date date
);

create table vendor_bank_changes (
  change_id text primary key,            -- 'BC-0001'
  vendor_id text not null references vendors(vendor_id),
  company_id text not null references companies(company_id),
  old_account_number text,
  new_account_number text,
  old_bank_name text,
  new_bank_name text,
  changed_at date not null,
  changed_by text                        -- free text in source data (e.g. 'email_request')
);

create table invoices (
  invoice_id text primary key,           -- 'INV-00001'
  company_id text not null references companies(company_id),
  vendor_id text not null references vendors(vendor_id),
  department text,
  gl_account text references gl_accounts(gl_code),
  subtotal numeric(14,2) not null,       -- = CSV 'amount'
  tax_amount numeric(14,2) not null default 0,
  total_amount numeric(14,2) not null,   -- = subtotal + tax_amount
  currency text not null default 'INR',
  date date not null,
  due_date date,
  payment_terms text,
  status text not null default 'Pending' check (status in ('Pending','Paid','Overdue','Disputed','Cancelled')),
  po_number text,
  contract_id text,
  submitted_by text references users(user_id),
  submitted_at timestamptz,
  source_channel text check (source_channel in ('whatsapp_bot','email_upload','portal_upload','scanned_document')),
  ocr_confidence numeric(4,3),
  is_recurring boolean not null default false,
  notes text,
  file_storage_path text                 -- populated once real WhatsApp uploads land in Storage (Phase 6+)
);

create table invoice_items (
  id uuid primary key default gen_random_uuid(),
  invoice_id text not null references invoices(invoice_id),
  line_no int not null,
  description text,
  quantity numeric(12,2),
  unit_price numeric(14,2),
  amount numeric(14,2),
  gl_account text references gl_accounts(gl_code)
  -- left empty for CSV-seeded invoices: the dataset has no line-item breakdown.
  -- populated by the OCR pipeline for real WhatsApp-submitted invoices (Phase 7).
);

create table payments (
  payment_id text primary key,           -- 'PAY-00001'
  company_id text not null references companies(company_id),
  invoice_id text not null references invoices(invoice_id),
  amount numeric(14,2) not null,
  status text not null check (status in ('Completed','Failed','Pending','Refunded')),
  payment_method text check (payment_method in ('UPI','RTGS','NEFT','Bank Transfer','Cheque')),
  bank_reference text,
  payment_date date
);

create table budgets (
  budget_id text primary key,            -- 'BUD-00001'
  company_id text not null references companies(company_id),
  department text not null,
  period text not null,                  -- 'YYYY-MM'
  allocated numeric(14,2) not null,
  spent numeric(14,2) not null default 0,
  remaining numeric(14,2) not null
);

create table transactions (
  transaction_id text primary key,       -- 'CT-000001' (from cash_transactions.csv)
  company_id text not null references companies(company_id),
  date date not null,
  type text not null check (type in ('inflow','outflow')),
  category text not null,
  amount numeric(14,2) not null
);

create table decisions (
  decision_id text primary key,          -- 'DEC-00001'
  company_id text not null references companies(company_id),
  invoice_id text not null references invoices(invoice_id),
  recommendation text not null,          -- 'Approve' | 'Escalate' | 'Flag for Review' | 'Hold - Duplicate Suspected' | 'Reject'
  reasoning text,
  confidence_score numeric(4,3),
  decided_by text not null default 'system_ai',
  "timestamp" timestamptz not null default now()
);

-- =========================================================================
-- SECTION 2 — Auth / WhatsApp / conversation (new, no CSV source)
-- =========================================================================

create table auth_methods (
  id uuid primary key default gen_random_uuid(),
  user_id text not null references users(user_id),
  method_type text not null check (method_type in ('recovery_email','dashboard_auth')),
  value text not null,                   -- email address, or the Enter Cloud auth.uid() as text
  verified_at timestamptz,
  created_at timestamptz not null default now()
);

create table whatsapp_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id text references users(user_id),   -- nullable until onboarding completes
  phone_number text not null unique,         -- E.164
  wa_id text,
  display_name text,
  status text not null default 'active' check (status in ('active','unlinked')),
  last_inbound_at timestamptz,                -- drives the 24h free-form message window
  linked_at timestamptz not null default now()
);

create table otp_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id text references users(user_id),    -- nullable pre-identification
  channel text not null default 'email',
  destination text not null,
  otp_hash text not null,                     -- never store the plaintext code
  purpose text not null check (purpose in ('signup_email_verify','account_recovery','link_new_number')),
  expires_at timestamptz not null,
  attempt_count int not null default 0,
  max_attempts int not null default 5,
  status text not null default 'pending' check (status in ('pending','verified','expired','locked')),
  requester_phone text,
  created_at timestamptz not null default now()
);

create table conversation_sessions (
  id uuid primary key default gen_random_uuid(),
  wa_id text not null,
  user_id text references users(user_id),
  state text not null default 'new',
  context jsonb not null default '{}'::jsonb,
  last_message_at timestamptz not null default now(),
  expires_at timestamptz
);

create table conversation_messages (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references conversation_sessions(id),
  direction text not null check (direction in ('inbound','outbound')),
  message_type text not null check (message_type in ('text','image','document','interactive')),
  content text,
  media_url text,
  wa_message_id text,
  created_at timestamptz not null default now()
);

create table auth_log (
  log_id text primary key,               -- 'AUTH-00001' from CSV, or new uuid text going forward
  user_id text references users(user_id),
  company_id text references companies(company_id),
  event_type text not null check (event_type in
    ('login_success','login_failed','mfa_verified','password_reset','otp_requested','otp_verified','account_locked')),
  ip_address text,
  device text,
  success boolean not null,
  "timestamp" timestamptz not null default now()
);

-- =========================================================================
-- SECTION 3 — Intelligence / decisions (new, no CSV source)
-- =========================================================================

create table invoice_analysis (
  id uuid primary key default gen_random_uuid(),
  invoice_id text not null unique references invoices(invoice_id),
  extracted_fields jsonb,
  validation_result jsonb,
  duplicate_score numeric(5,2),
  duplicate_evidence jsonb,
  vendor_risk_snapshot jsonb,
  budget_impact jsonb,
  anomaly_score numeric(5,2),
  anomaly_reasons jsonb,
  created_at timestamptz not null default now()
);

create table invoice_actions (
  id uuid primary key default gen_random_uuid(),
  invoice_id text not null references invoices(invoice_id),
  company_id text not null references companies(company_id),
  action text not null check (action in ('approve','review','defer','reject')),
  previous_status text,
  new_status text,
  performed_by text references users(user_id),
  reason text,
  created_at timestamptz not null default now()
);

create table risk_alerts (
  id uuid primary key default gen_random_uuid(),
  company_id text not null references companies(company_id),
  alert_type text not null,              -- matches anomaly types + 'budget_near_limit' | 'cash_flow_pressure'
  severity text not null check (severity in ('low','medium','high')),
  related_invoice_id text references invoices(invoice_id),
  related_vendor_id text references vendors(vendor_id),
  message text not null,
  status text not null default 'open' check (status in ('open','acknowledged','resolved')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by text references users(user_id)
);

create table forecast_records (
  id uuid primary key default gen_random_uuid(),
  company_id text not null references companies(company_id),
  generated_at timestamptz not null default now(),
  horizon_days int not null check (horizon_days in (30,60,90)),
  projected_inflow numeric(14,2),
  projected_outflow numeric(14,2),
  projected_net numeric(14,2),
  projected_cash_position numeric(14,2),
  top_contributors jsonb,
  disclaimer text not null default 'Estimate based on historical patterns — not a guaranteed forecast.'
);

create table decision_rules_config (
  id uuid primary key default gen_random_uuid(),
  company_id text references companies(company_id), -- null = global default
  rule_key text not null,
  threshold_value numeric not null,
  description text,
  updated_at timestamptz not null default now(),
  unique (company_id, rule_key)
);

-- =========================================================================
-- SECTION 4 — Dashboard-only (new)
-- =========================================================================

create table dashboard_admins (
  user_id uuid primary key,              -- = auth.uid()
  company_id text not null references companies(company_id),
  role text not null,
  created_at timestamptz not null default now()
);

-- =========================================================================
-- SECTION 5 — Test-only (imported, never read by runtime bot logic)
-- =========================================================================

create table demo_anomaly_answer_key (
  id text primary key,                   -- 'AK-0001'
  source_table text not null,
  related_id text not null,
  anomaly_type text not null,
  description text
  -- SYNTHETIC EVALUATION DATA ONLY. Used exclusively by the automated test
  -- suite to score anomaly-engine precision/recall. Never queried by any
  -- WhatsApp-facing or dashboard-facing function.
);

-- =========================================================================
-- SECTION 6 — Row Level Security
-- =========================================================================
-- All WhatsApp-facing tables: RLS enabled, zero anon/authenticated policies
-- (default-deny). Only the service role, used exclusively inside backend
-- functions, can read/write them — the browser never touches them directly.
--
-- Dashboard-facing tables additionally get a SELECT policy scoped through
-- dashboard_admins via a security-definer helper (avoids recursive RLS).

alter table companies enable row level security;
alter table gl_accounts enable row level security;
alter table users enable row level security;
alter table vendors enable row level security;
alter table vendor_bank_changes enable row level security;
alter table invoices enable row level security;
alter table invoice_items enable row level security;
alter table payments enable row level security;
alter table budgets enable row level security;
alter table transactions enable row level security;
alter table decisions enable row level security;
alter table auth_methods enable row level security;
alter table whatsapp_accounts enable row level security;
alter table otp_sessions enable row level security;
alter table conversation_sessions enable row level security;
alter table conversation_messages enable row level security;
alter table auth_log enable row level security;
alter table invoice_analysis enable row level security;
alter table invoice_actions enable row level security;
alter table risk_alerts enable row level security;
alter table forecast_records enable row level security;
alter table decision_rules_config enable row level security;
alter table dashboard_admins enable row level security;
alter table demo_anomaly_answer_key enable row level security;

-- Security-definer helper: resolves the calling dashboard user's company_id
-- without triggering recursive RLS evaluation.
create or replace function public.current_dashboard_company_id()
returns text
language sql
security definer
stable
set search_path = public
as $$
  select company_id from dashboard_admins where user_id = auth.uid()
$$;

-- dashboard_admins: a user may read their own row only.
create policy "dashboard admin reads own row"
  on dashboard_admins for select
  using (user_id = auth.uid());

-- gl_accounts: global lookup, readable by any authenticated dashboard user.
create policy "authenticated reads gl_accounts"
  on gl_accounts for select
  to authenticated
  using (true);

-- Company-scoped read-only policies for the dashboard (Path B).
create policy "dashboard reads own company" on companies for select
  using (company_id = public.current_dashboard_company_id());
create policy "dashboard reads own company users" on users for select
  using (company_id = public.current_dashboard_company_id());
create policy "dashboard reads own company vendors" on vendors for select
  using (company_id = public.current_dashboard_company_id());
create policy "dashboard reads own company vendor_bank_changes" on vendor_bank_changes for select
  using (company_id = public.current_dashboard_company_id());
create policy "dashboard reads own company invoices" on invoices for select
  using (company_id = public.current_dashboard_company_id());
create policy "dashboard reads own company invoice_items" on invoice_items for select
  using (invoice_id in (select invoice_id from invoices where company_id = public.current_dashboard_company_id()));
create policy "dashboard reads own company payments" on payments for select
  using (company_id = public.current_dashboard_company_id());
create policy "dashboard reads own company budgets" on budgets for select
  using (company_id = public.current_dashboard_company_id());
create policy "dashboard reads own company transactions" on transactions for select
  using (company_id = public.current_dashboard_company_id());
create policy "dashboard reads own company decisions" on decisions for select
  using (company_id = public.current_dashboard_company_id());
create policy "dashboard reads own company invoice_analysis" on invoice_analysis for select
  using (invoice_id in (select invoice_id from invoices where company_id = public.current_dashboard_company_id()));
create policy "dashboard reads own company invoice_actions" on invoice_actions for select
  using (company_id = public.current_dashboard_company_id());
create policy "dashboard reads own company risk_alerts" on risk_alerts for select
  using (company_id = public.current_dashboard_company_id());
create policy "dashboard reads own company forecast_records" on forecast_records for select
  using (company_id = public.current_dashboard_company_id());

-- All other tables (auth_methods, whatsapp_accounts, otp_sessions,
-- conversation_sessions, conversation_messages, auth_log,
-- decision_rules_config, demo_anomaly_answer_key) intentionally get NO
-- policies at all: RLS enabled + zero policies = default-deny for every
-- app role. Only the service role (inside backend functions) can touch them.

-- =========================================================================
-- SECTION 7 — Seed: default decision-engine thresholds (global, company_id null)
-- =========================================================================

insert into decision_rules_config (company_id, rule_key, threshold_value, description) values
  (null, 'duplicate_review_threshold', 70, 'Duplicate score (0-100) at or above this triggers REVIEW / Hold - Duplicate Suspected'),
  (null, 'budget_review_threshold_pct', 85, 'Projected budget utilization %% at or above this triggers REVIEW'),
  (null, 'budget_defer_threshold_pct', 95, 'Projected budget utilization %% at or above this triggers DEFER'),
  (null, 'anomaly_review_threshold', 60, 'Anomaly score (0-100) at or above this triggers REVIEW'),
  (null, 'vendor_amount_multiplier_threshold', 3, 'Invoice amount vs vendor historical average multiplier that counts as anomalous'),
  (null, 'bank_change_lookback_days', 30, 'A vendor bank-account change within this many days of an invoice is treated as high risk');
