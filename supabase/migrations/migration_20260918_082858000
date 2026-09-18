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

create or replace function public.current_dashboard_company_id()
returns text
language sql
security definer
stable
set search_path = public
as $$
  select company_id from dashboard_admins where user_id = auth.uid()
$$;

create policy "dashboard admin reads own row"
  on dashboard_admins for select
  using (user_id = auth.uid());

create policy "authenticated reads gl_accounts"
  on gl_accounts for select
  to authenticated
  using (true);

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