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
  alert_type text not null,
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
  disclaimer text not null default 'Estimate based on historical patterns - not a guaranteed forecast.'
);

create table decision_rules_config (
  id uuid primary key default gen_random_uuid(),
  company_id text references companies(company_id),
  rule_key text not null,
  threshold_value numeric not null,
  description text,
  updated_at timestamptz not null default now(),
  unique (company_id, rule_key)
);

create table dashboard_admins (
  user_id uuid primary key,
  company_id text not null references companies(company_id),
  role text not null,
  created_at timestamptz not null default now()
);

create table demo_anomaly_answer_key (
  id text primary key,
  source_table text not null,
  related_id text not null,
  anomaly_type text not null,
  description text
);