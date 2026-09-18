import { describe, expect, it } from "vitest";
import { detectCredentialStuffingPattern, detectInvoiceAnomalies } from "../anomaly";
import { DEFAULT_THRESHOLDS } from "../thresholds";
import type { AuthLogEntry, Invoice } from "@/types/fincore";
import type { BudgetImpactResult } from "../budgetImpact";

function baseInvoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    invoice_id: "TEST-INV-1",
    company_id: "COMP-01",
    vendor_id: "VEN-0001",
    department: "Engineering",
    gl_account: "6100",
    amount: 10000,
    currency: "INR",
    tax_amount: 0,
    date: "2026-01-15",
    due_date: "2026-02-15",
    payment_terms: "Net 30",
    status: "Pending",
    po_number: "PO-1",
    contract_id: null,
    submitted_by: "USR-0001",
    submitted_at: "2026-01-15T12:00:00.000Z",
    source_channel: "whatsapp_bot",
    ocr_confidence: 0.95,
    is_recurring: false,
    notes: null,
    ...overrides,
  };
}

const healthyBudget: BudgetImpactResult = {
  found: true,
  department: "Engineering",
  period: "2026-01",
  allocated: 100000,
  spentBefore: 10000,
  remainingBefore: 90000,
  utilizationBeforePct: 10,
  invoiceAmount: 10000,
  projectedSpent: 20000,
  projectedRemaining: 80000,
  projectedUtilizationPct: 20,
  impact: "low",
};

function baseAnomalyInput() {
  return {
    invoice: baseInvoice(),
    invoiceTotal: 10000,
    historicalAvgAmount: 10000,
    historicalInvoiceCount: 5,
    duplicateScore: 0,
    recentBankChange: false,
    daysSinceBankChange: null,
    budgetImpact: healthyBudget,
    sameVendorNearbyInvoices: [] as Invoice[],
    thresholds: DEFAULT_THRESHOLDS,
  };
}

describe("detectInvoiceAnomalies", () => {
  it("scores a clean, in-line invoice as low risk", () => {
    const result = detectInvoiceAnomalies(baseAnomalyInput());
    expect(result.score).toBeLessThan(DEFAULT_THRESHOLDS.anomalyReviewThreshold);
  });

  it("flags a vendor spend spike when the amount is far above the vendor average", () => {
    const input = { ...baseAnomalyInput(), invoiceTotal: 40000, invoice: baseInvoice({ amount: 40000 }) };
    const result = detectInvoiceAnomalies(input);
    expect(result.signals.some((s) => s.type === "vendor_spend_spike")).toBe(true);
  });

  it("flags a missing PO on a high-value invoice", () => {
    const input = { ...baseAnomalyInput(), invoiceTotal: 600_000, invoice: baseInvoice({ amount: 600_000, po_number: null }) };
    const result = detectInvoiceAnomalies(input);
    expect(result.signals.some((s) => s.type === "missing_po_high_value")).toBe(true);
  });

  it("flags a recent vendor bank account change", () => {
    const input = { ...baseAnomalyInput(), recentBankChange: true, daysSinceBankChange: 5 };
    const result = detectInvoiceAnomalies(input);
    expect(result.signals.some((s) => s.type === "post_bank_change_invoice")).toBe(true);
  });

  it("flags a suspiciously round amount", () => {
    const input = { ...baseAnomalyInput(), invoiceTotal: 50000, invoice: baseInvoice({ amount: 50000 }) };
    const result = detectInvoiceAnomalies(input);
    expect(result.signals.some((s) => s.type === "round_number_pattern")).toBe(true);
  });

  it("flags an off-hours submission", () => {
    const input = { ...baseAnomalyInput(), invoice: baseInvoice({ submitted_at: "2026-01-15T02:30:00.000Z" }) };
    const result = detectInvoiceAnomalies(input);
    expect(result.signals.some((s) => s.type === "off_hours_submission")).toBe(true);
  });

  it("flags low OCR confidence", () => {
    const input = { ...baseAnomalyInput(), invoice: baseInvoice({ ocr_confidence: 0.4 }) };
    const result = detectInvoiceAnomalies(input);
    expect(result.signals.some((s) => s.type === "low_ocr_confidence_needs_review")).toBe(true);
  });
});

describe("detectCredentialStuffingPattern", () => {
  function failedLogin(timestamp: string, ip: string): AuthLogEntry {
    return { log_id: `L-${timestamp}`, user_id: "USR-0001", company_id: "COMP-01", event_type: "login_failed", ip_address: ip, device: "test", success: false, timestamp };
  }

  it("detects repeated failed logins within the window", () => {
    const entries = [
      failedLogin("2026-01-01T10:00:00.000Z", "1.1.1.1"),
      failedLogin("2026-01-01T10:02:00.000Z", "1.1.1.2"),
      failedLogin("2026-01-01T10:04:00.000Z", "1.1.1.3"),
      failedLogin("2026-01-01T10:06:00.000Z", "1.1.1.4"),
    ];
    const result = detectCredentialStuffingPattern(entries, 15, 4);
    expect(result.detected).toBe(true);
  });

  it("does not flag a single failed login", () => {
    const result = detectCredentialStuffingPattern([failedLogin("2026-01-01T10:00:00.000Z", "1.1.1.1")], 15, 4);
    expect(result.detected).toBe(false);
  });
});
