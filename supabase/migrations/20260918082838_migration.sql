create table companies (
  company_id text primary key,
  name text not null,
  industry text,
  country text,
  plan_tier text,
  created_at timestamptz not null default now()
);

create table gl_accounts (
  gl_code text primary key,
  category text not null,
  description text
);

create table users (
  user_id text primary key,
  name text not null,
  email text not null unique,
  legacy_password_hash text,
  role text not null check (role in ('admin','ap_clerk','auditor','department_head','finance_manager','viewer')),
  company_id text not null references companies(company_id),
  mfa_enabled boolean not null default false,
  account_status text not null default 'Active' check (account_status in ('Active','Locked','Suspended')),
  failed_login_attempts int not null default 0,
  last_login_at timestamptz,
  created_at timestamptz not null default now()
);

create table vendors (
  vendor_id text primary key,
  company_id text not null references companies(company_id),
  name text not null,
  category text,
  risk_profile text check (risk_profile in ('Low','Medium','High')),
  status text not null default 'Active' check (status in ('Active','Blacklisted','Under Review')),
  bank_name text,
  bank_account_number text,
  tax_id text,
  onboarded_date date
);

create table vendor_bank_changes (
  change_id text primary key,
  vendor_id text not null references vendors(vendor_id),
  company_id text not null references companies(company_id),
  old_account_number text,
  new_account_number text,
  old_bank_name text,
  new_bank_name text,
  changed_at date not null,
  changed_by text
);

create table invoices (
  invoice_id text primary key,
  company_id text not null references companies(company_id),
  vendor_id text not null references vendors(vendor_id),
  department text,
  gl_account text references gl_accounts(gl_code),
  subtotal numeric(14,2) not null,
  tax_amount numeric(14,2) not null default 0,
  total_amount numeric(14,2) not null,
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
  file_storage_path text
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
);

create table payments (
  payment_id text primary key,
  company_id text not null references companies(company_id),
  invoice_id text not null references invoices(invoice_id),
  amount numeric(14,2) not null,
  status text not null check (status in ('Completed','Failed','Pending','Refunded')),
  payment_method text check (payment_method in ('UPI','RTGS','NEFT','Bank Transfer','Cheque')),
  bank_reference text,
  payment_date date
);

create table budgets (
  budget_id text primary key,
  company_id text not null references companies(company_id),
  department text not null,
  period text not null,
  allocated numeric(14,2) not null,
  spent numeric(14,2) not null default 0,
  remaining numeric(14,2) not null
);

create table transactions (
  transaction_id text primary key,
  company_id text not null references companies(company_id),
  date date not null,
  type text not null check (type in ('inflow','outflow')),
  category text not null,
  amount numeric(14,2) not null
);

create table decisions (
  decision_id text primary key,
  company_id text not null references companies(company_id),
  invoice_id text not null references invoices(invoice_id),
  recommendation text not null,
  reasoning text,
  confidence_score numeric(4,3),
  decided_by text not null default 'system_ai',
  "timestamp" timestamptz not null default now()
);