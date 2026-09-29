// WhatsApp-friendly explanation formatting.
//
// Enter AI Capability is not enabled yet, so these are deterministic
// templates over the pipeline's computed facts (no invented numbers). Once
// AI Capability is available, a backend function can replace only this
// formatting layer with an LLM call that restates the same facts in nicer
// prose — the facts themselves (validation/duplicate/vendorRisk/
// budgetImpact/anomaly/decision) never change.

import type { InvoiceAnalysis } from "./pipeline";

export function formatCurrency(amount: number, currency = "INR"): string {
  try {
    return new Intl.NumberFormat("en-IN", { style: "currency", currency, maximumFractionDigits: 0 }).format(amount);
  } catch {
    return `${currency} ${Math.round(amount).toLocaleString("en-IN")}`;
  }
}

const ACTION_LABEL: Record<InvoiceAnalysis["decision"]["action"], string> = {
  APPROVE: "APPROVE",
  REVIEW: "REVIEW",
  DEFER: "DEFER",
  REJECT: "REJECT",
};

export function conciseInvoiceMessage(analysis: InvoiceAnalysis): string {
  const { invoice, invoiceTotal, decision, vendorRisk, budgetImpact, anomaly, duplicate } = analysis;
  const lines: string[] = [];
  lines.push(`*Invoice ${invoice.invoice_id}*`);
  lines.push(`Vendor: ${vendorRisk.vendorId}  |  Amount: ${formatCurrency(invoiceTotal, invoice.currency)}`);
  lines.push("");
  lines.push(`*Recommendation: ${ACTION_LABEL[decision.action]}*`);
  lines.push("");
  lines.push("Why:");
  decision.reasons.slice(0, 4).forEach((r, i) => lines.push(`${i + 1}. ${r}`));
  lines.push("");
  lines.push(`Risk score: ${Math.round(anomaly.score)}/100`);
  if (duplicate.score > 0) lines.push(`Duplicate similarity: ${Math.round(duplicate.score)}%`);
  if (budgetImpact.found) lines.push(`Budget utilization after payment: ${Math.round(budgetImpact.projectedUtilizationPct)}%`);
  lines.push("");
  lines.push('Reply "Approve INV-x", "Review INV-x", "Defer INV-x", "Reject INV-x", or "Details" to see the full breakdown.');
  return lines.join("\n");
}

export function detailedInvoiceMessage(analysis: InvoiceAnalysis): string {
  const { invoice, invoiceTotal, validation, duplicate, vendorRisk, budgetImpact, anomaly, decision } = analysis;
  const lines: string[] = [];
  lines.push(`*Full analysis — ${invoice.invoice_id}*`);
  lines.push("");
  lines.push("*Validation*");
  if (validation.issues.length === 0) lines.push("No issues found.");
  else validation.issues.forEach((i) => lines.push(`- [${i.severity}] ${i.message}`));
  lines.push("");
  lines.push("*Duplicate check*");
  if (duplicate.bestMatch) {
    lines.push(`Closest match: ${duplicate.bestMatch.invoiceId} (${duplicate.bestMatch.similarity}% similar)`);
    duplicate.bestMatch.evidence.forEach((e) => lines.push(`- ${e}`));
  } else {
    lines.push("No similar invoices found.");
  }
  lines.push("");
  lines.push("*Vendor risk*");
  lines.push(`Computed risk: ${vendorRisk.computedRisk} (score ${vendorRisk.score}/100)`);
  lines.push(`History: ${vendorRisk.invoiceCount} invoice(s), total spend ${formatCurrency(vendorRisk.totalSpend, invoice.currency)}, avg ${formatCurrency(vendorRisk.avgInvoiceAmount, invoice.currency)}`);
  if (vendorRisk.onTimePaymentRate !== null) lines.push(`On-time payment rate: ${Math.round(vendorRisk.onTimePaymentRate * 100)}%`);
  vendorRisk.reasons.forEach((r) => lines.push(`- ${r}`));
  lines.push("");
  lines.push("*Budget impact*");
  if (budgetImpact.found) {
    lines.push(`Department: ${budgetImpact.department} (${budgetImpact.period})`);
    lines.push(`Allocated: ${formatCurrency(budgetImpact.allocated, invoice.currency)}  |  Spent so far: ${formatCurrency(budgetImpact.spentBefore, invoice.currency)} (${Math.round(budgetImpact.utilizationBeforePct)}%)`);
    lines.push(`After this invoice: ${formatCurrency(budgetImpact.projectedSpent, invoice.currency)} (${Math.round(budgetImpact.projectedUtilizationPct)}%), remaining ${formatCurrency(budgetImpact.projectedRemaining, invoice.currency)}`);
  } else {
    lines.push(`No budget record found for ${budgetImpact.department} in ${budgetImpact.period}.`);
  }
  lines.push("");
  lines.push("*Anomaly signals*");
  if (anomaly.signals.length === 0) lines.push("None triggered.");
  else anomaly.signals.forEach((s) => lines.push(`- ${s.description} (+${s.weight})`));
  lines.push(`Total anomaly score: ${anomaly.score}/100`);
  lines.push("");
  lines.push(`*Final recommendation: ${decision.action}*`);
  decision.reasons.forEach((r) => lines.push(`- ${r}`));
  return lines.join("\n");
}
