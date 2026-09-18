// Vendor risk intelligence — computed from real history, never a pass-through
// of the vendor's static `risk_profile` label.

import type { Decision, Invoice, Payment, Vendor, VendorBankChange } from "@/types/fincore";

export interface VendorRiskResult {
  vendorId: string;
  invoiceCount: number;
  totalSpend: number;
  avgInvoiceAmount: number;
  recentInvoiceCount90d: number;
  onTimePaymentRate: number | null; // null when no completed payments to measure
  priorDuplicateFlags: number;
  recentBankChange: boolean;
  daysSinceBankChange: number | null;
  computedRisk: "Low" | "Medium" | "High";
  score: number; // 0-100
  reasons: string[];
}

export function computeVendorRisk(
  vendor: Vendor,
  vendorInvoices: Invoice[],
  vendorPayments: Payment[],
  bankChanges: VendorBankChange[],
  vendorDecisions: Decision[],
  referenceDateISO: string,
  bankChangeLookbackDays: number
): VendorRiskResult {
  const reasons: string[] = [];
  let score = 0;

  const invoiceCount = vendorInvoices.length;
  const totalSpend = vendorInvoices.reduce((sum, i) => sum + i.amount + i.tax_amount, 0);
  const avgInvoiceAmount = invoiceCount > 0 ? totalSpend / invoiceCount : 0;

  const referenceDate = new Date(referenceDateISO).getTime();
  const recentInvoiceCount90d = vendorInvoices.filter((i) => {
    const d = new Date(i.date).getTime();
    return !Number.isNaN(d) && referenceDate - d <= 90 * 24 * 60 * 60 * 1000 && referenceDate - d >= 0;
  }).length;

  const completedPayments = vendorPayments.filter((p) => p.status === "Completed");
  let onTimePaymentRate: number | null = null;
  if (completedPayments.length > 0) {
    let onTime = 0;
    for (const payment of completedPayments) {
      const invoice = vendorInvoices.find((i) => i.invoice_id === payment.invoice_id);
      if (!invoice?.due_date) continue;
      if (new Date(payment.payment_date).getTime() <= new Date(invoice.due_date).getTime()) onTime++;
    }
    onTimePaymentRate = onTime / completedPayments.length;
  }

  const priorDuplicateFlags = vendorDecisions.filter((d) => d.recommendation === "Hold - Duplicate Suspected").length;

  let recentBankChange = false;
  let daysSinceBankChange: number | null = null;
  for (const change of bankChanges) {
    const days = (referenceDate - new Date(change.changed_at).getTime()) / (1000 * 60 * 60 * 24);
    if (days >= 0 && days <= bankChangeLookbackDays) {
      recentBankChange = true;
      daysSinceBankChange = daysSinceBankChange === null ? days : Math.min(daysSinceBankChange, days);
    }
  }

  if (vendor.status === "Blacklisted") {
    score += 60;
    reasons.push("Vendor is currently blacklisted");
  } else if (vendor.status === "Under Review") {
    score += 30;
    reasons.push("Vendor is under review");
  }

  if (onTimePaymentRate !== null && onTimePaymentRate < 0.7) {
    score += 20;
    reasons.push(`On-time payment rate is low (${Math.round(onTimePaymentRate * 100)}%)`);
  }

  if (priorDuplicateFlags > 0) {
    score += Math.min(20, priorDuplicateFlags * 10);
    reasons.push(`${priorDuplicateFlags} prior invoice(s) flagged as suspected duplicates`);
  }

  if (recentBankChange) {
    score += 25;
    reasons.push(`Bank account changed ${Math.round(daysSinceBankChange ?? 0)} day(s) ago`);
  }

  if (invoiceCount > 0 && invoiceCount <= 2 && avgInvoiceAmount > 200_000) {
    score += 15;
    reasons.push("New vendor relationship with a large average invoice amount");
  }

  score = Math.min(100, score);
  const computedRisk: VendorRiskResult["computedRisk"] = score >= 60 ? "High" : score >= 30 ? "Medium" : "Low";

  if (reasons.length === 0) reasons.push("No elevated risk indicators found in vendor history");

  return {
    vendorId: vendor.vendor_id,
    invoiceCount,
    totalSpend,
    avgInvoiceAmount,
    recentInvoiceCount90d,
    onTimePaymentRate,
    priorDuplicateFlags,
    recentBankChange,
    daysSinceBankChange,
    computedRisk,
    score,
    reasons,
  };
}
