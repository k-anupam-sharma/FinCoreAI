import { describe, expect, it } from "vitest";
import { validateInvoice } from "../validation";
import type { Invoice } from "@/types/fincore";

function baseInvoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    invoice_id: "TEST-INV-1",
    company_id: "COMP-01",
    vendor_id: "VEN-0001",
    department: "Engineering",
    gl_account: "6100",
    amount: 10000,
    currency: "INR",
    tax_amount: 1800,
    date: "2026-01-15",
    due_date: "2026-02-15",
    payment_terms: "Net 30",
    status: "Pending",
    po_number: "PO-1",
    contract_id: null,
    submitted_by: "USR-0001",
    submitted_at: "2026-01-15T10:00:00.000Z",
    source_channel: "whatsapp_bot",
    ocr_confidence: 0.95,
    is_recurring: false,
    notes: null,
    ...overrides,
  };
}

describe("validateInvoice", () => {
  it("passes a well-formed invoice with no issues", () => {
    const result = validateInvoice(baseInvoice());
    expect(result.valid).toBe(true);
    expect(result.hasCriticalFailure).toBe(false);
  });

  it("flags a missing vendor as a critical failure", () => {
    const result = validateInvoice(baseInvoice({ vendor_id: "" }));
    expect(result.hasCriticalFailure).toBe(true);
    expect(result.issues.some((i) => i.field === "vendor_id")).toBe(true);
  });

  it("flags a non-positive amount as a critical failure", () => {
    const result = validateInvoice(baseInvoice({ amount: 0 }));
    expect(result.hasCriticalFailure).toBe(true);
  });

  it("flags a due date before the invoice date as a critical failure", () => {
    const result = validateInvoice(baseInvoice({ date: "2026-02-15", due_date: "2026-01-15" }));
    expect(result.hasCriticalFailure).toBe(true);
  });

  it("warns (not critical) on a high-value invoice missing a PO number", () => {
    const result = validateInvoice(baseInvoice({ po_number: null, amount: 600_000 }));
    expect(result.hasCriticalFailure).toBe(false);
    expect(result.issues.some((i) => i.field === "po_number" && i.severity === "warning")).toBe(true);
  });
});
