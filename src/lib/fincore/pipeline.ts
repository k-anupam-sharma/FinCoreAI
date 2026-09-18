// Invoice analysis pipeline — orchestrates the deterministic steps in order:
// validate -> duplicate -> vendor risk -> budget impact -> anomaly -> decide.
// This is the single place that produces the "facts" record every WhatsApp
// reply and dashboard view is built from.

import * as store from "@/data/fincoreStore";
import type { Invoice } from "@/types/fincore";
import { validateInvoice, type ValidationResult } from "./validation";
import { detectDuplicates, type DuplicateResult } from "./duplicate";
import { computeVendorRisk, type VendorRiskResult } from "./vendorRisk";
import { computeBudgetImpact, type BudgetImpactResult } from "./budgetImpact";
import { detectInvoiceAnomalies, type AnomalyResult } from "./anomaly";
import { decideInvoice, type DecisionEngineResult } from "./decisionEngine";
import { DEFAULT_THRESHOLDS, type DecisionThresholds } from "./thresholds";

export interface InvoiceAnalysis {
  invoice: Invoice;
  invoiceTotal: number;
  validation: ValidationResult;
  duplicate: DuplicateResult;
  vendorRisk: VendorRiskResult;
  budgetImpact: BudgetImpactResult;
  anomaly: AnomalyResult;
  decision: DecisionEngineResult;
}

function daysBetween(a: string, b: string): number {
  const da = new Date(a).getTime();
  const db = new Date(b).getTime();
  if (Number.isNaN(da) || Number.isNaN(db)) return Infinity;
  return Math.abs(da - db) / (1000 * 60 * 60 * 24);
}

export function analyzeInvoice(invoiceId: string, thresholds: DecisionThresholds = DEFAULT_THRESHOLDS): InvoiceAnalysis | null {
  const invoice = store.getInvoice(invoiceId);
  if (!invoice) return null;

  const vendor = store.getVendor(invoice.vendor_id);
  if (!vendor) return null;

  const invoiceTotal = invoice.amount + invoice.tax_amount;
  const vendorInvoicesAll = store.getInvoicesByVendor(vendor.vendor_id);
  const historicalInvoices = vendorInvoicesAll.filter((i) => i.invoice_id !== invoice.invoice_id);
  const historicalAvgAmount =
    historicalInvoices.length > 0 ? historicalInvoices.reduce((s, i) => s + i.amount + i.tax_amount, 0) / historicalInvoices.length : 0;

  const validation = validateInvoice(invoice);
  const duplicate = detectDuplicates(invoice, vendorInvoicesAll);

  const vendorPayments = store.getPaymentsByVendor(vendor.vendor_id);
  const bankChanges = store.getVendorBankChanges(vendor.vendor_id);
  const vendorInvoiceIds = new Set(vendorInvoicesAll.map((i) => i.invoice_id));
  const vendorDecisions = store.getDecisionsByCompany(invoice.company_id).filter((d) => vendorInvoiceIds.has(d.invoice_id));

  const vendorRisk = computeVendorRisk(vendor, vendorInvoicesAll, vendorPayments, bankChanges, vendorDecisions, invoice.date, thresholds.bankChangeLookbackDays);

  const period = invoice.date.slice(0, 7);
  const budget = store.getBudget(invoice.company_id, invoice.department, period);
  const budgetImpact = computeBudgetImpact(budget, invoice.department, period, invoiceTotal);

  const sameVendorNearbyInvoices = historicalInvoices.filter((i) => daysBetween(i.date, invoice.date) <= 5);

  const anomaly = detectInvoiceAnomalies({
    invoice,
    invoiceTotal,
    historicalAvgAmount,
    historicalInvoiceCount: historicalInvoices.length,
    duplicateScore: duplicate.score,
    recentBankChange: vendorRisk.recentBankChange,
    daysSinceBankChange: vendorRisk.daysSinceBankChange,
    budgetImpact,
    sameVendorNearbyInvoices,
    thresholds,
  });

  const decision = decideInvoice({
    validation,
    duplicateScore: duplicate.score,
    vendorComputedRisk: vendorRisk.computedRisk,
    recentBankChange: vendorRisk.recentBankChange,
    budgetImpact,
    anomalyScore: anomaly.score,
    thresholds,
  });

  return { invoice, invoiceTotal, validation, duplicate, vendorRisk, budgetImpact, anomaly, decision };
}
