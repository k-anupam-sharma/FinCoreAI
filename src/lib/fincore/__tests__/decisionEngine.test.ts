import { describe, expect, it } from "vitest";
import { decideInvoice } from "../decisionEngine";
import { DEFAULT_THRESHOLDS } from "../thresholds";
import type { ValidationResult } from "../validation";
import type { BudgetImpactResult } from "../budgetImpact";

const cleanValidation: ValidationResult = { valid: true, hasCriticalFailure: false, issues: [] };
const healthyBudget: BudgetImpactResult = {
  found: true,
  department: "Engineering",
  period: "2026-06",
  allocated: 100000,
  spentBefore: 20000,
  remainingBefore: 80000,
  utilizationBeforePct: 20,
  invoiceAmount: 5000,
  projectedSpent: 25000,
  projectedRemaining: 75000,
  projectedUtilizationPct: 25,
  impact: "low",
};

function baseInput() {
  return {
    validation: cleanValidation,
    duplicateScore: 0,
    vendorComputedRisk: "Low" as const,
    recentBankChange: false,
    budgetImpact: healthyBudget,
    anomalyScore: 0,
    thresholds: DEFAULT_THRESHOLDS,
  };
}

describe("decideInvoice", () => {
  it("approves a clean invoice with no risk indicators", () => {
    const result = decideInvoice(baseInput());
    expect(result.action).toBe("APPROVE");
  });

  it("reviews (duplicate hold) when duplicate score is at or above the threshold", () => {
    const result = decideInvoice({ ...baseInput(), duplicateScore: 75 });
    expect(result.action).toBe("REVIEW");
    expect(result.csvLabel).toBe("Hold - Duplicate Suspected");
  });

  it("rejects when there are two or more critical validation failures", () => {
    const validation: ValidationResult = {
      valid: false,
      hasCriticalFailure: true,
      issues: [
        { field: "amount", severity: "critical", message: "Amount must be greater than zero" },
        { field: "vendor_id", severity: "critical", message: "Missing required field: vendor_id" },
      ],
    };
    const result = decideInvoice({ ...baseInput(), validation });
    expect(result.action).toBe("REJECT");
  });

  it("reviews when there is exactly one critical validation failure", () => {
    const validation: ValidationResult = {
      valid: false,
      hasCriticalFailure: true,
      issues: [{ field: "amount", severity: "critical", message: "Amount must be greater than zero" }],
    };
    const result = decideInvoice({ ...baseInput(), validation });
    expect(result.action).toBe("REVIEW");
  });

  it("reviews when vendor computed risk is High", () => {
    const result = decideInvoice({ ...baseInput(), vendorComputedRisk: "High" });
    expect(result.action).toBe("REVIEW");
  });

  it("reviews when the vendor changed bank details recently", () => {
    const result = decideInvoice({ ...baseInput(), recentBankChange: true });
    expect(result.action).toBe("REVIEW");
  });

  it("defers when projected budget utilization is at or above the defer threshold", () => {
    const budgetImpact: BudgetImpactResult = { ...healthyBudget, projectedUtilizationPct: 96 };
    const result = decideInvoice({ ...baseInput(), budgetImpact });
    expect(result.action).toBe("DEFER");
  });

  it("reviews when projected budget utilization is at or above the review threshold but below defer", () => {
    const budgetImpact: BudgetImpactResult = { ...healthyBudget, projectedUtilizationPct: 88 };
    const result = decideInvoice({ ...baseInput(), budgetImpact });
    expect(result.action).toBe("REVIEW");
  });

  it("reviews when the anomaly score is at or above the review threshold", () => {
    const result = decideInvoice({ ...baseInput(), anomalyScore: 65 });
    expect(result.action).toBe("REVIEW");
  });
});
