// Anomaly scoring — transparent, signal-based, never an LLM guess.
//
// Each signal is a named, independently-testable function; the total score
// is the sum of triggered signal weights (capped at 100). The signal names
// intentionally match the labels used in docs/seed-data (anomaly_answer_key)
// so the automated test suite can score precision/recall against them.

import type { AuthLogEntry, Invoice } from "@/types/fincore";
import type { BudgetImpactResult } from "./budgetImpact";
import type { DecisionThresholds } from "./thresholds";

export interface AnomalySignal {
  type: string;
  description: string;
  weight: number;
}

export interface AnomalyResult {
  score: number; // 0-100
  signals: AnomalySignal[];
}

export interface AnomalyInput {
  invoice: Invoice;
  invoiceTotal: number;
  historicalAvgAmount: number;
  historicalInvoiceCount: number;
  duplicateScore: number;
  recentBankChange: boolean;
  daysSinceBankChange: number | null;
  budgetImpact: BudgetImpactResult;
  sameVendorNearbyInvoices: Invoice[]; // other invoices, same vendor, within a few days (excludes self)
  thresholds: DecisionThresholds;
}

export function detectInvoiceAnomalies(input: AnomalyInput): AnomalyResult {
  const signals: AnomalySignal[] = [];
  const { invoice, invoiceTotal, historicalAvgAmount, historicalInvoiceCount, duplicateScore, recentBankChange, daysSinceBankChange, budgetImpact, sameVendorNearbyInvoices, thresholds } = input;

  if (duplicateScore >= 40) {
    signals.push({
      type: "duplicate_invoice",
      description: `${Math.round(duplicateScore)}% similarity to a prior invoice from the same vendor`,
      weight: Math.round(duplicateScore * 0.4),
    });
  }

  if (historicalAvgAmount > 0) {
    const multiplier = invoiceTotal / historicalAvgAmount;
    if (multiplier >= thresholds.vendorAmountMultiplierThreshold) {
      signals.push({
        type: "vendor_spend_spike",
        description: `Amount is ${multiplier.toFixed(1)}x this vendor's historical average invoice`,
        weight: Math.min(30, Math.round(multiplier * 5)),
      });
    }
  }

  if (historicalInvoiceCount <= 1 && invoiceTotal > 200_000) {
    signals.push({
      type: "new_vendor_large_invoice",
      description: "Large invoice from a vendor with little or no prior history",
      weight: 20,
    });
  }

  if (!invoice.po_number && invoiceTotal > 500_000) {
    signals.push({
      type: "missing_po_high_value",
      description: "High-value invoice submitted without a purchase order",
      weight: 15,
    });
  }

  if (recentBankChange) {
    signals.push({
      type: "post_bank_change_invoice",
      description: `Vendor changed bank account ${Math.round(daysSinceBankChange ?? 0)} day(s) before this invoice`,
      weight: 25,
    });
  }

  if (invoiceTotal > 0 && invoiceTotal % 10_000 === 0) {
    signals.push({
      type: "round_number_pattern",
      description: "Invoice amount is a suspiciously round number",
      weight: 10,
    });
  }

  const nearbySameDept = sameVendorNearbyInvoices.filter((i) => i.department === invoice.department);
  if (nearbySameDept.length >= 2) {
    const combined = invoiceTotal + nearbySameDept.reduce((sum, i) => sum + i.amount + i.tax_amount, 0);
    const allBelowThreshold = invoiceTotal <= 500_000 && nearbySameDept.every((i) => i.amount + i.tax_amount <= 500_000);
    if (allBelowThreshold && combined > 500_000) {
      signals.push({
        type: "split_invoice_suspected",
        description: `${nearbySameDept.length} similar invoices from this vendor nearby whose combined total (${Math.round(combined).toLocaleString("en-IN")}) exceeds a single approval threshold`,
        weight: 20,
      });
    }
  }

  if (invoice.submitted_at) {
    const hour = new Date(invoice.submitted_at).getHours();
    if (!Number.isNaN(hour) && (hour < 7 || hour >= 21)) {
      signals.push({
        type: "off_hours_submission",
        description: `Submitted off-hours (${String(hour).padStart(2, "0")}:00)`,
        weight: 10,
      });
    }
  }

  if (invoice.ocr_confidence !== null && invoice.ocr_confidence !== undefined && invoice.ocr_confidence < 0.7) {
    signals.push({
      type: "low_ocr_confidence_needs_review",
      description: `OCR extraction confidence is low (${Math.round(invoice.ocr_confidence * 100)}%)`,
      weight: 10,
    });
  }

  if (budgetImpact.found && budgetImpact.projectedUtilizationPct >= thresholds.budgetReviewThresholdPct) {
    signals.push({
      type: "abnormal_budget_impact",
      description: `Projected department budget utilization would reach ${Math.round(budgetImpact.projectedUtilizationPct)}%`,
      weight: 15,
    });
  }

  const score = Math.min(100, signals.reduce((sum, s) => sum + s.weight, 0));
  return { score, signals };
}

/** Auth-side anomaly: repeated failed logins/OTP attempts in a short window. */
export function detectCredentialStuffingPattern(entries: AuthLogEntry[], windowMinutes = 15, failureThreshold = 4): { detected: boolean; reason: string | null } {
  const sorted = [...entries].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  for (let i = 0; i < sorted.length; i++) {
    const windowStart = new Date(sorted[i].timestamp).getTime();
    let failures = 0;
    const ips = new Set<string>();
    for (let j = i; j < sorted.length; j++) {
      const t = new Date(sorted[j].timestamp).getTime();
      if ((t - windowStart) / 60000 > windowMinutes) break;
      if (sorted[j].event_type === "login_failed") {
        failures++;
        if (sorted[j].ip_address) ips.add(sorted[j].ip_address as string);
      }
    }
    if (failures >= failureThreshold) {
      return { detected: true, reason: `${failures} failed login attempts within ${windowMinutes} minutes${ips.size > 1 ? ` from ${ips.size} different IP addresses` : ""}` };
    }
  }
  return { detected: false, reason: null };
}
