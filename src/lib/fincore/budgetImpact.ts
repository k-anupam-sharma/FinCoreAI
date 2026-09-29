// Budget impact — current allocation/spend vs. what happens after this invoice
// is paid. Pure arithmetic against the department's budget for the invoice's
// period; the decision engine applies its own thresholds on top of this.

import type { Budget } from "@/types/fincore";

export interface BudgetImpactResult {
  found: boolean;
  department: string;
  period: string;
  allocated: number;
  spentBefore: number;
  remainingBefore: number;
  utilizationBeforePct: number;
  invoiceAmount: number;
  projectedSpent: number;
  projectedRemaining: number;
  projectedUtilizationPct: number;
  impact: "low" | "medium" | "high";
}

export function computeBudgetImpact(budget: Budget | undefined, department: string, period: string, invoiceTotal: number): BudgetImpactResult {
  if (!budget) {
    return {
      found: false,
      department,
      period,
      allocated: 0,
      spentBefore: 0,
      remainingBefore: 0,
      utilizationBeforePct: 0,
      invoiceAmount: invoiceTotal,
      projectedSpent: invoiceTotal,
      projectedRemaining: -invoiceTotal,
      projectedUtilizationPct: 0,
      impact: "medium",
    };
  }

  const utilizationBeforePct = budget.allocated > 0 ? (budget.spent / budget.allocated) * 100 : 0;
  const projectedSpent = budget.spent + invoiceTotal;
  const projectedRemaining = budget.allocated - projectedSpent;
  const projectedUtilizationPct = budget.allocated > 0 ? (projectedSpent / budget.allocated) * 100 : 0;

  const impact: BudgetImpactResult["impact"] = projectedUtilizationPct >= 95 ? "high" : projectedUtilizationPct >= 70 ? "medium" : "low";

  return {
    found: true,
    department,
    period,
    allocated: budget.allocated,
    spentBefore: budget.spent,
    remainingBefore: budget.remaining,
    utilizationBeforePct,
    invoiceAmount: invoiceTotal,
    projectedSpent,
    projectedRemaining,
    projectedUtilizationPct,
    impact,
  };
}
