// Read-only aggregation queries used by the menu features and by the
// natural-language Q&A router. Everything here is plain arithmetic over the
// data store — no LLM is involved in computing any number.

import * as store from "@/data/fincoreStore";
import { computeVendorRisk, type VendorRiskResult } from "./vendorRisk";
import { forecastCashFlow, type ForecastResult } from "./forecast";
import { analyzeInvoice, type InvoiceAnalysis } from "./pipeline";
import { computeBudgetImpact } from "./budgetImpact";
import { DEFAULT_THRESHOLDS } from "./thresholds";
import { formatCurrency } from "./explain";

export interface FinancialOverview {
  period: string;
  currency: string;
  monthlySpend: number;
  budgetAllocated: number;
  budgetSpent: number;
  budgetUsedPct: number;
  pendingInvoicesCount: number;
  riskAlertsCount: number;
  upcomingPaymentsCount: number;
  upcomingPaymentsTotal: number;
}

function daysBetween(a: string, b: string): number {
  return (new Date(a).getTime() - new Date(b).getTime()) / (1000 * 60 * 60 * 24);
}

export function getFinancialOverview(companyId: string): FinancialOverview {
  const period = store.getDemoCurrentPeriod();
  const now = store.getDemoNowDate();
  const invoices = store.getInvoicesByCompany(companyId);
  const currency = invoices[0]?.currency ?? "INR";

  const monthlySpend = invoices.filter((i) => i.date.startsWith(period)).reduce((s, i) => s + i.amount + i.tax_amount, 0);

  const budgets = store.getBudgetsByCompany(companyId).filter((b) => b.period === period);
  const budgetAllocated = budgets.reduce((s, b) => s + b.allocated, 0);
  const budgetSpent = budgets.reduce((s, b) => s + b.spent, 0);

  const pendingInvoicesCount = invoices.filter((i) => i.status === "Pending").length;
  const riskAlerts = scanRiskAlerts(companyId);

  const upcoming = invoices.filter((i) => {
    if (!i.due_date || (i.status !== "Pending" && i.status !== "Overdue")) return false;
    const d = daysBetween(i.due_date, now);
    return d >= -3650 && d <= 14 && d >= 0;
  });

  return {
    period,
    currency,
    monthlySpend,
    budgetAllocated,
    budgetSpent,
    budgetUsedPct: budgetAllocated > 0 ? (budgetSpent / budgetAllocated) * 100 : 0,
    pendingInvoicesCount,
    riskAlertsCount: riskAlerts.length,
    upcomingPaymentsCount: upcoming.length,
    upcomingPaymentsTotal: upcoming.reduce((s, i) => s + i.amount + i.tax_amount, 0),
  };
}

/** Re-runs the full pipeline on every pending invoice and returns the ones the engine did not auto-approve, worst first. */
export function scanRiskAlerts(companyId: string, limit = 5): InvoiceAnalysis[] {
  const pending = store.getInvoicesByCompany(companyId).filter((i) => i.status === "Pending" || i.status === "Overdue");
  const analyzed = pending.map((i) => analyzeInvoice(i.invoice_id)).filter((a): a is InvoiceAnalysis => a !== null);
  return analyzed
    .filter((a) => a.decision.action !== "APPROVE")
    .sort((a, b) => b.anomaly.score - a.anomaly.score)
    .slice(0, limit);
}

export interface VendorRiskSummary {
  vendorId: string;
  vendorName: string;
  category: string;
  legacyRiskProfile: string;
  risk: VendorRiskResult;
}

export function getVendorRiskSummary(companyId: string, vendorNameOrId: string): VendorRiskSummary | null {
  const vendors = store.getVendorsByCompany(companyId);
  const vendor = vendors.find((v) => v.vendor_id === vendorNameOrId) ?? vendors.find((v) => v.name.toLowerCase().includes(vendorNameOrId.trim().toLowerCase()));
  if (!vendor) return null;

  const vendorInvoices = store.getInvoicesByVendor(vendor.vendor_id);
  const vendorPayments = store.getPaymentsByVendor(vendor.vendor_id);
  const bankChanges = store.getVendorBankChanges(vendor.vendor_id);
  const vendorInvoiceIds = new Set(vendorInvoices.map((i) => i.invoice_id));
  const vendorDecisions = store.getDecisionsByCompany(companyId).filter((d) => vendorInvoiceIds.has(d.invoice_id));
  const referenceDate = store.getDemoNowDate();

  const risk = computeVendorRisk(vendor, vendorInvoices, vendorPayments, bankChanges, vendorDecisions, referenceDate, DEFAULT_THRESHOLDS.bankChangeLookbackDays);

  return { vendorId: vendor.vendor_id, vendorName: vendor.name, category: vendor.category, legacyRiskProfile: vendor.risk_profile, risk };
}

export interface BudgetSummaryRow {
  department: string;
  allocated: number;
  spent: number;
  remaining: number;
  utilizationPct: number;
}

export function getBudgetSummary(companyId: string, period = store.getDemoCurrentPeriod()): BudgetSummaryRow[] {
  return store
    .getBudgetsByCompany(companyId)
    .filter((b) => b.period === period)
    .map((b) => ({
      department: b.department,
      allocated: b.allocated,
      spent: b.spent,
      remaining: b.remaining,
      utilizationPct: b.allocated > 0 ? (b.spent / b.allocated) * 100 : 0,
    }))
    .sort((a, b) => b.utilizationPct - a.utilizationPct);
}

export function getForecast(companyId: string, horizonDays: 30 | 60 | 90 = 30): ForecastResult {
  const transactions = store.getTransactionsByCompany(companyId);
  return forecastCashFlow(transactions, store.getDemoNowDate(), horizonDays);
}

// ---- Natural-language question routing (rule-based, not an LLM) -----------
//
// This intentionally does NOT call an LLM or execute arbitrary queries: each
// branch maps to one of the controlled read functions above. Enter AI
// Capability is not enabled yet; once it is, this can be upgraded to an LLM
// intent classifier that still only ever calls these same controlled
// functions — never raw SQL, never invented numbers.

function extractAmount(text: string): number | null {
  const match = text.replace(/,/g, "").match(/(\d+(\.\d+)?)/);
  return match ? Number(match[1]) : null;
}

function extractDepartment(text: string, companyId: string): string | null {
  const departments = new Set(store.getBudgetsByCompany(companyId).map((b) => b.department));
  const lower = text.toLowerCase();
  for (const dept of departments) {
    if (lower.includes(dept.toLowerCase())) return dept;
  }
  return null;
}

const NEWLINE = String.fromCharCode(10);

export function answerFinancialQuestion(companyId: string, question: string): string {
  const q = question.toLowerCase();
  const overview = getFinancialOverview(companyId);

  if (/(afford|can we pay|can i pay)/.test(q)) {
    const amount = extractAmount(question);
    const department = extractDepartment(question, companyId);
    if (amount === null) {
      return [
        "Tell me the invoice amount, for example:",
        "Can we afford a 300000 invoice for Marketing?",
      ].join(NEWLINE);
    }
    const period = store.getDemoCurrentPeriod();
    const budgets = store.getBudgetsByCompany(companyId).filter((b) => b.period === period && (!department || b.department === department));
    if (budgets.length === 0) return `I could not find a budget for ${department ?? "that department"} in ${period}.`;
    const budget = budgets[0];
    const impact = computeBudgetImpact(budget, budget.department, period, amount);
    return [
      `Budget check - ${budget.department} (${period})`,
      `Current budget: ${formatCurrency(impact.allocated, overview.currency)}`,
      `Current spend: ${formatCurrency(impact.spentBefore, overview.currency)} (${Math.round(impact.utilizationBeforePct)}%)`,
      `Invoice amount: ${formatCurrency(amount, overview.currency)}`,
      `Remaining after payment: ${formatCurrency(impact.projectedRemaining, overview.currency)}`,
      `Projected utilization: ${Math.round(impact.projectedUtilizationPct)}%`,
      `Impact: ${impact.impact.toUpperCase()}`,
    ].join(NEWLINE);
  }

  if (/(highest spend|top vendor|biggest vendor)/.test(q)) {
    const vendors = store.getVendorsByCompany(companyId);
    const ranked = vendors
      .map((v) => ({ v, total: store.getInvoicesByVendor(v.vendor_id).filter((i) => i.company_id === companyId).reduce((s, i) => s + i.amount + i.tax_amount, 0) }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 5);
    return ["Top vendors by total spend", ...ranked.map((r, i) => `${i + 1}. ${r.v.name} - ${formatCurrency(r.total, overview.currency)}`)].join(NEWLINE);
  }

  if (/(pending invoice)/.test(q)) {
    const pending = store.getInvoicesByCompany(companyId).filter((i) => i.status === "Pending").sort((a, b) => b.amount - a.amount).slice(0, 5);
    if (pending.length === 0) return "No pending invoices right now.";
    return [`Pending invoices (${overview.pendingInvoicesCount} total)`, ...pending.map((i) => `- ${i.invoice_id}: ${formatCurrency(i.amount + i.tax_amount, i.currency)} (${i.department})`)].join(NEWLINE);
  }

  if (/(suspicious|risky invoice|risk alert)/.test(q)) {
    const alerts = scanRiskAlerts(companyId);
    if (alerts.length === 0) return "No suspicious invoices flagged right now.";
    return ["Flagged invoices", ...alerts.map((a) => `- ${a.invoice.invoice_id}: ${a.decision.action} - anomaly score ${a.anomaly.score}/100`)].join(NEWLINE);
  }

  if (/(overspend|over budget)/.test(q)) {
    const rows = getBudgetSummary(companyId).filter((r) => r.remaining < 0);
    if (rows.length === 0) return "No department is currently over budget.";
    return ["Departments over budget", ...rows.map((r) => `- ${r.department}: ${Math.round(r.utilizationPct)}% used, over by ${formatCurrency(-r.remaining, overview.currency)}`)].join(NEWLINE);
  }

  if (/(budget left|remaining budget|how much budget)/.test(q)) {
    const department = extractDepartment(question, companyId);
    const rows = getBudgetSummary(companyId).filter((r) => !department || r.department === department);
    return ["Remaining budget", ...rows.map((r) => `- ${r.department}: ${formatCurrency(r.remaining, overview.currency)} left (${Math.round(r.utilizationPct)}% used)`)].join(NEWLINE);
  }

  if (/(cash position|cash flow|forecast)/.test(q)) {
    const f = getForecast(companyId, 30);
    return [
      "30-day cash flow estimate",
      `Projected inflow: ${formatCurrency(f.projectedInflow, overview.currency)}`,
      `Projected outflow: ${formatCurrency(f.projectedOutflow, overview.currency)}`,
      `Projected net: ${formatCurrency(f.projectedNet, overview.currency)}`,
      `Projected cash position: ${formatCurrency(f.projectedCashPosition, overview.currency)}`,
      "",
      f.disclaimer,
    ].join(NEWLINE);
  }

  if (/(why.*spending increase|spending.*increase)/.test(q)) {
    const rows = getBudgetSummary(companyId).sort((a, b) => b.spent - a.spent).slice(0, 3);
    return ["Biggest contributors to spend this period", ...rows.map((r) => `- ${r.department}: ${formatCurrency(r.spent, overview.currency)} (${Math.round(r.utilizationPct)}% of budget)`)].join(NEWLINE);
  }

  if (/(how much.*spend|spend this month|monthly spend)/.test(q)) {
    return `This month's spend is ${formatCurrency(overview.monthlySpend, overview.currency)}, against a budget utilization of ${Math.round(overview.budgetUsedPct)}%.`;
  }

  return [
    "I can help with:",
    "- spend summaries (how much did we spend this month?)",
    "- vendor rankings (which vendor has the highest spend?)",
    "- pending/suspicious invoices",
    "- budget and overspending checks",
    "- cash-flow forecasts",
    "",
    "Try rephrasing, or type menu to see all options.",
  ].join(NEWLINE);
}
