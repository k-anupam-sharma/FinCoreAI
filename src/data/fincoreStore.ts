// FinCore AI — client-side data store.
//
// Enter Cloud is not provisioned yet, so this stands in for the database:
// it loads the user's seeded dataset (docs/seed-data -> src/data/seed/*.json)
// and layers session-created records (new demo companies/users/invoices/
// decisions) on top, persisted to localStorage so a demo survives a reload.
//
// This is a stopgap. Every function here is written so a real backend
// function can replace the body with a Postgres query later without
// changing the call sites in the logic engine or the conversation layer.

import type {
  AnomalyAnswerKeyEntry,
  AuthLogEntry,
  Budget,
  Company,
  Decision,
  FinUser,
  GlAccount,
  Invoice,
  InvoiceAction,
  InvoiceStatus,
  Payment,
  Transaction,
  Vendor,
  VendorBankChange,
  WhatsappAccount,
} from "@/types/fincore";

import companiesSeed from "./seed/companies.json";
import usersSeed from "./seed/users.json";
import vendorsSeed from "./seed/vendors.json";
import vendorBankChangesSeed from "./seed/vendor_bank_changes.json";
import glAccountsSeed from "./seed/gl_accounts.json";
import invoicesSeed from "./seed/invoices.json";
import paymentsSeed from "./seed/payments.json";
import budgetsSeed from "./seed/budgets.json";
import transactionsSeed from "./seed/cash_transactions.json";
import decisionsSeed from "./seed/decisions.json";
import authLogSeed from "./seed/auth_log.json";
import anomalyAnswerKeySeed from "./seed/anomaly_answer_key.json";

const OVERLAY_KEY = "fincore_demo_overlay_v1";

interface Overlay {
  companies: Company[];
  users: FinUser[];
  invoices: Invoice[];
  decisions: Decision[];
  invoiceActions: InvoiceAction[];
  whatsappAccounts: WhatsappAccount[];
}

function emptyOverlay(): Overlay {
  return { companies: [], users: [], invoices: [], decisions: [], invoiceActions: [], whatsappAccounts: [] };
}

function loadOverlay(): Overlay {
  if (typeof localStorage === "undefined") return emptyOverlay();
  try {
    const raw = localStorage.getItem(OVERLAY_KEY);
    if (!raw) return emptyOverlay();
    const parsed = JSON.parse(raw);
    return { ...emptyOverlay(), ...parsed };
  } catch {
    return emptyOverlay();
  }
}

function saveOverlay() {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(OVERLAY_KEY, JSON.stringify(overlay));
}

const overlay = loadOverlay();

// gl_account / gl_code arrive as numbers from the CSV->JSON conversion; the
// schema treats them as text, so normalize here once.
const companies: Company[] = [...(companiesSeed as Company[]), ...overlay.companies];
const users: FinUser[] = [...(usersSeed as unknown as FinUser[]), ...overlay.users];
const vendors: Vendor[] = vendorsSeed as unknown as Vendor[];
const vendorBankChanges: VendorBankChange[] = vendorBankChangesSeed as unknown as VendorBankChange[];
const glAccounts: GlAccount[] = (glAccountsSeed as any[]).map((g) => ({ ...g, gl_code: String(g.gl_code) }));
const invoices: Invoice[] = [
  ...(invoicesSeed as any[]).map((i) => ({ ...i, gl_account: String(i.gl_account) })),
  ...overlay.invoices,
] as Invoice[];
const payments: Payment[] = paymentsSeed as unknown as Payment[];
const budgets: Budget[] = budgetsSeed as unknown as Budget[];
const transactions: Transaction[] = transactionsSeed as unknown as Transaction[];
const decisions: Decision[] = [...(decisionsSeed as unknown as Decision[]), ...overlay.decisions];
const invoiceActions: InvoiceAction[] = [...overlay.invoiceActions];
const authLog: AuthLogEntry[] = authLogSeed as unknown as AuthLogEntry[];
const demoAnomalyAnswerKey: AnomalyAnswerKeyEntry[] = anomalyAnswerKeySeed as unknown as AnomalyAnswerKeyEntry[];
const whatsappAccounts: WhatsappAccount[] = [...overlay.whatsappAccounts];

function persist() {
  overlay.companies = companies.filter((c) => c.company_id.startsWith("DEMO-"));
  overlay.users = users.filter((u) => u.user_id.startsWith("DEMO-"));
  overlay.invoices = invoices.filter((i) => i.invoice_id.startsWith("DEMO-"));
  overlay.decisions = decisions.filter((d) => d.decision_id.startsWith("DEMO-"));
  overlay.invoiceActions = invoiceActions;
  overlay.whatsappAccounts = whatsappAccounts;
  saveOverlay();
}

// ---- Companies -----------------------------------------------------------

export function getCompanies(): Company[] {
  return companies;
}
export function getCompany(companyId: string): Company | undefined {
  return companies.find((c) => c.company_id === companyId);
}
export function findCompanyByName(name: string): Company | undefined {
  const needle = name.trim().toLowerCase();
  return companies.find((c) => c.name.trim().toLowerCase() === needle);
}
export function createCompany(name: string, industry: string): Company {
  const company: Company = {
    company_id: `DEMO-CO-${crypto.randomUUID().slice(0, 8)}`,
    name,
    industry,
    country: "India",
    plan_tier: "Growth",
  };
  companies.push(company);
  persist();
  return company;
}

// ---- Users ----------------------------------------------------------------

export function getUser(userId: string): FinUser | undefined {
  return users.find((u) => u.user_id === userId);
}
export function getUsersByCompany(companyId: string): FinUser[] {
  return users.filter((u) => u.company_id === companyId);
}
export function findUserByEmail(email: string): FinUser | undefined {
  const needle = email.trim().toLowerCase();
  return users.find((u) => u.email.trim().toLowerCase() === needle);
}
export function createUser(input: Omit<FinUser, "user_id" | "account_status" | "failed_login_attempts" | "created_at" | "last_login_at" | "mfa_enabled">): FinUser {
  const user: FinUser = {
    ...input,
    user_id: `DEMO-USR-${crypto.randomUUID().slice(0, 8)}`,
    account_status: "Active",
    failed_login_attempts: 0,
    last_login_at: null,
    mfa_enabled: false,
    created_at: new Date().toISOString(),
  };
  users.push(user);
  persist();
  return user;
}

// ---- Vendors ----------------------------------------------------------------

export function getVendor(vendorId: string): Vendor | undefined {
  return vendors.find((v) => v.vendor_id === vendorId);
}
export function getVendorsByCompany(companyId: string): Vendor[] {
  return vendors.filter((v) => v.company_id === companyId);
}
export function findVendorByName(companyId: string, name: string): Vendor | undefined {
  const needle = name.trim().toLowerCase();
  return vendors.find((v) => v.company_id === companyId && v.name.trim().toLowerCase() === needle);
}
export function getVendorBankChanges(vendorId: string): VendorBankChange[] {
  return vendorBankChanges.filter((c) => c.vendor_id === vendorId);
}

// ---- GL accounts ----------------------------------------------------------

export function getGlAccount(code: string): GlAccount | undefined {
  return glAccounts.find((g) => g.gl_code === code);
}
export function getGlAccounts(): GlAccount[] {
  return glAccounts;
}

// ---- Invoices ---------------------------------------------------------------

export function getInvoice(invoiceId: string): Invoice | undefined {
  return invoices.find((i) => i.invoice_id === invoiceId);
}
export function getInvoicesByCompany(companyId: string): Invoice[] {
  return invoices.filter((i) => i.company_id === companyId);
}
export function getInvoicesByVendor(vendorId: string): Invoice[] {
  return invoices.filter((i) => i.vendor_id === vendorId);
}
export function createInvoice(input: Omit<Invoice, "invoice_id" | "submitted_at" | "status" | "source_channel">): Invoice {
  const invoice: Invoice = {
    ...input,
    invoice_id: `DEMO-INV-${crypto.randomUUID().slice(0, 8)}`,
    status: "Pending",
    source_channel: "whatsapp_bot",
    submitted_at: new Date().toISOString(),
  };
  invoices.push(invoice);
  persist();
  return invoice;
}
export function updateInvoiceStatus(invoiceId: string, status: InvoiceStatus) {
  const invoice = getInvoice(invoiceId);
  if (invoice) {
    invoice.status = status;
    persist();
  }
}

// ---- Payments ---------------------------------------------------------------

export function getPaymentsByInvoice(invoiceId: string): Payment[] {
  return payments.filter((p) => p.invoice_id === invoiceId);
}
export function getPaymentsByVendor(vendorId: string): Payment[] {
  const vendorInvoiceIds = new Set(getInvoicesByVendor(vendorId).map((i) => i.invoice_id));
  return payments.filter((p) => vendorInvoiceIds.has(p.invoice_id));
}

// ---- Budgets ------------------------------------------------------------------

export function getBudgetsByCompany(companyId: string): Budget[] {
  return budgets.filter((b) => b.company_id === companyId);
}
export function getBudget(companyId: string, department: string, period: string): Budget | undefined {
  return budgets.find((b) => b.company_id === companyId && b.department === department && b.period === period);
}

/** The dataset ends mid-2026; use its latest period/date as "now" for the demo instead of the real clock. */
export function getDemoCurrentPeriod(): string {
  return budgets.reduce((max, b) => (b.period > max ? b.period : max), budgets[0]?.period ?? "2026-01");
}
export function getDemoNowDate(): string {
  return transactions.reduce((max, t) => (t.date > max ? t.date : max), transactions[0]?.date ?? "2026-01-01");
}

// ---- Transactions ---------------------------------------------------------------

export function getTransactionsByCompany(companyId: string): Transaction[] {
  return transactions.filter((t) => t.company_id === companyId);
}

// ---- Decisions ---------------------------------------------------------------

export function getDecisionsByInvoice(invoiceId: string): Decision[] {
  return decisions.filter((d) => d.invoice_id === invoiceId);
}
export function getDecisionsByCompany(companyId: string): Decision[] {
  return decisions.filter((d) => d.company_id === companyId);
}
export function addDecision(input: Omit<Decision, "decision_id" | "timestamp">): Decision {
  const decision: Decision = {
    ...input,
    decision_id: `DEMO-DEC-${crypto.randomUUID().slice(0, 8)}`,
    timestamp: new Date().toISOString(),
  };
  decisions.push(decision);
  persist();
  return decision;
}

// ---- Invoice actions (human workflow audit trail) -------------------------------

export function addInvoiceAction(input: Omit<InvoiceAction, "id" | "created_at">): InvoiceAction {
  const action: InvoiceAction = {
    ...input,
    id: crypto.randomUUID(),
    created_at: new Date().toISOString(),
  };
  invoiceActions.push(action);
  persist();
  return action;
}
export function getInvoiceActionsByInvoice(invoiceId: string): InvoiceAction[] {
  return invoiceActions.filter((a) => a.invoice_id === invoiceId);
}

// ---- WhatsApp account linking ---------------------------------------------------

export function getWhatsappAccount(phoneNumber: string): WhatsappAccount | undefined {
  return whatsappAccounts.find((w) => w.phone_number === phoneNumber);
}
export function linkWhatsappAccount(phoneNumber: string, userId: string) {
  const existing = getWhatsappAccount(phoneNumber);
  if (existing) {
    existing.user_id = userId;
    existing.status = "active";
  } else {
    whatsappAccounts.push({ phone_number: phoneNumber, user_id: userId, status: "active", linked_at: new Date().toISOString() });
  }
  persist();
}
export function unlinkWhatsappAccount(phoneNumber: string) {
  const existing = getWhatsappAccount(phoneNumber);
  if (existing) {
    existing.status = "unlinked";
    persist();
  }
}

// ---- Auth log (audit trail; also feeds credential_stuffing_pattern signal) -----

export function getAuthLogByUser(userId: string): AuthLogEntry[] {
  return authLog.filter((a) => a.user_id === userId);
}
export function appendAuthLog(entry: Omit<AuthLogEntry, "log_id">) {
  authLog.push({ ...entry, log_id: `DEMO-AUTH-${crypto.randomUUID().slice(0, 8)}` });
}

// ---- Test-only ------------------------------------------------------------------

/** Synthetic evaluation labels — used only by the automated test suite, never by bot logic. */
export function getDemoAnomalyAnswerKey(): AnomalyAnswerKeyEntry[] {
  return demoAnomalyAnswerKey;
}
