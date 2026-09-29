import { describe, expect, it } from "vitest";
import { getInvoice, getInvoicesByVendor } from "@/data/fincoreStore";
import { detectDuplicates } from "../duplicate";

// INV-00231 / INV-00232 are labeled as a duplicate pair in
// docs/seed-data/anomaly_answer_key.csv (AK-0001 / AK-0002) — same vendor,
// close amounts, three days apart. This is a regression test against real
// labeled data, not a synthetic fixture.
describe("detectDuplicates against the labeled demo dataset", () => {
  it("flags INV-00232 as the top match for INV-00231", () => {
    const invoice = getInvoice("INV-00231")!;
    const candidates = getInvoicesByVendor(invoice.vendor_id);
    const result = detectDuplicates(invoice, candidates);

    expect(result.bestMatch?.invoiceId).toBe("INV-00232");
    expect(result.score).toBeGreaterThanOrEqual(40);
  });

  it("returns no matches for an invoice with no similar sibling", () => {
    const invoice = getInvoice("INV-00001")!;
    const candidates = getInvoicesByVendor(invoice.vendor_id);
    const result = detectDuplicates(invoice, candidates.filter((c) => c.invoice_id === invoice.invoice_id));
    expect(result.score).toBe(0);
    expect(result.bestMatch).toBeNull();
  });
});
