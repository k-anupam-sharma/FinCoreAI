import { describe, expect, it } from "vitest";
import { getDemoAnomalyAnswerKey, getInvoicesByCompany } from "@/data/fincoreStore";
import { analyzeInvoice } from "../pipeline";

describe("analyzeInvoice end-to-end", () => {
  it("produces a complete, internally-consistent analysis for a real seeded invoice", () => {
    const [invoice] = getInvoicesByCompany("COMP-01");
    const analysis = analyzeInvoice(invoice.invoice_id);
    expect(analysis).not.toBeNull();
    expect(analysis!.invoiceTotal).toBeCloseTo(invoice.amount + invoice.tax_amount, 5);
    expect(["APPROVE", "REVIEW", "DEFER", "REJECT"]).toContain(analysis!.decision.action);
    expect(analysis!.decision.reasons.length).toBeGreaterThan(0);
  });

  it("returns null for an unknown invoice id", () => {
    expect(analyzeInvoice("INV-DOES-NOT-EXIST")).toBeNull();
  });

  it("flags a majority of the labeled duplicate_invoice pairs when re-analyzed", () => {
    const duplicateLabels = getDemoAnomalyAnswerKey().filter((a) => a.anomaly_type === "duplicate_invoice" && a.source_table === "invoices");
    let flagged = 0;
    for (const label of duplicateLabels) {
      const analysis = analyzeInvoice(label.related_id);
      if (analysis && analysis.duplicate.score > 0) flagged++;
    }
    // Sanity threshold, not a strict precision claim — this is a heuristic
    // multi-signal detector, not a guarantee. See docs/database-schema.sql
    // and the architecture plan for how this evaluation set is intended to
    // be used (test-only, never by runtime bot logic).
    expect(flagged / Math.max(1, duplicateLabels.length)).toBeGreaterThan(0.5);
  });
});
