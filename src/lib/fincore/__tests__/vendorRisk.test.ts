import { describe, expect, it } from "vitest";
import { getInvoicesByVendor, getPaymentsByVendor, getVendor, getVendorBankChanges, getDecisionsByCompany } from "@/data/fincoreStore";
import { computeVendorRisk } from "../vendorRisk";
import { DEFAULT_THRESHOLDS } from "../thresholds";

// VEN-0096 changed its bank account on 2026-04-01, ten days before it
// submitted INV-00327 (docs/seed-data/vendor_bank_changes.csv) — a real
// post_bank_change_invoice case from the labeled dataset.
describe("computeVendorRisk against the labeled demo dataset", () => {
  it("flags a vendor's recent bank account change", () => {
    const vendor = getVendor("VEN-0096")!;
    const invoices = getInvoicesByVendor(vendor.vendor_id);
    const payments = getPaymentsByVendor(vendor.vendor_id);
    const bankChanges = getVendorBankChanges(vendor.vendor_id);
    const decisions = getDecisionsByCompany(vendor.company_id);

    const result = computeVendorRisk(vendor, invoices, payments, bankChanges, decisions, "2026-04-11", DEFAULT_THRESHOLDS.bankChangeLookbackDays);

    expect(result.recentBankChange).toBe(true);
    expect(result.daysSinceBankChange).toBeCloseTo(10, 0);
    expect(result.reasons.some((r) => r.toLowerCase().includes("bank"))).toBe(true);
  });

  it("does not flag a bank change outside the lookback window", () => {
    const vendor = getVendor("VEN-0096")!;
    const invoices = getInvoicesByVendor(vendor.vendor_id);
    const payments = getPaymentsByVendor(vendor.vendor_id);
    const bankChanges = getVendorBankChanges(vendor.vendor_id);
    const decisions = getDecisionsByCompany(vendor.company_id);

    // Same change, but evaluated a year later — well outside any lookback window.
    const result = computeVendorRisk(vendor, invoices, payments, bankChanges, decisions, "2027-04-11", DEFAULT_THRESHOLDS.bankChangeLookbackDays);
    expect(result.recentBankChange).toBe(false);
  });
});
