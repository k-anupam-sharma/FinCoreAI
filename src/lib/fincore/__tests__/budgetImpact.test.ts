import { describe, expect, it } from "vitest";
import { computeBudgetImpact } from "../budgetImpact";
import type { Budget } from "@/types/fincore";

const budget: Budget = {
  budget_id: "BUD-TEST",
  company_id: "COMP-01",
  department: "Engineering",
  period: "2026-06",
  allocated: 100000,
  spent: 60000,
  remaining: 40000,
};

describe("computeBudgetImpact", () => {
  it("computes utilization before and after the invoice", () => {
    const result = computeBudgetImpact(budget, "Engineering", "2026-06", 20000);
    expect(result.found).toBe(true);
    expect(result.utilizationBeforePct).toBeCloseTo(60, 5);
    expect(result.projectedSpent).toBe(80000);
    expect(result.projectedUtilizationPct).toBeCloseTo(80, 5);
    expect(result.projectedRemaining).toBe(20000);
    expect(result.impact).toBe("medium");
  });

  it("classifies high impact once projected utilization crosses 95%", () => {
    const result = computeBudgetImpact(budget, "Engineering", "2026-06", 40000);
    expect(result.projectedUtilizationPct).toBe(100);
    expect(result.impact).toBe("high");
  });

  it("returns found=false when no budget exists for the department/period", () => {
    const result = computeBudgetImpact(undefined, "Legal", "2026-06", 5000);
    expect(result.found).toBe(false);
    expect(result.projectedRemaining).toBe(-5000);
  });
});
