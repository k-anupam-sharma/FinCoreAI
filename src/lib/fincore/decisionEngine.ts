// Decision engine — deterministic rules only. The LLM never computes this;
// it only turns the reasons list below into WhatsApp-friendly prose later.

import type { DecisionRecommendation } from "@/types/fincore";
import type { BudgetImpactResult } from "./budgetImpact";
import type { ValidationResult } from "./validation";
import type { DecisionThresholds } from "./thresholds";

export type EngineAction = "APPROVE" | "REVIEW" | "DEFER" | "REJECT";

export interface DecisionEngineInput {
  validation: ValidationResult;
  duplicateScore: number;
  vendorComputedRisk: "Low" | "Medium" | "High";
  recentBankChange: boolean;
  budgetImpact: BudgetImpactResult;
  anomalyScore: number;
  thresholds: DecisionThresholds;
}

export interface DecisionEngineResult {
  action: EngineAction;
  csvLabel: DecisionRecommendation;
  reasons: string[];
}

export function decideInvoice(input: DecisionEngineInput): DecisionEngineResult {
  const { validation, duplicateScore, vendorComputedRisk, recentBankChange, budgetImpact, anomalyScore, thresholds } = input;
  const reasons: string[] = [];

  if (duplicateScore >= thresholds.duplicateReviewThreshold) {
    reasons.push(`Duplicate similarity score is ${Math.round(duplicateScore)}%, at or above the review threshold (${thresholds.duplicateReviewThreshold}%)`);
    return { action: "REVIEW", csvLabel: "Hold - Duplicate Suspected", reasons };
  }

  const criticalIssues = validation.issues.filter((i) => i.severity === "critical");
  if (criticalIssues.length > 0) {
    for (const issue of criticalIssues) reasons.push(issue.message);
    if (criticalIssues.length >= 2) {
      return { action: "REJECT", csvLabel: "Reject", reasons };
    }
    return { action: "REVIEW", csvLabel: "Flag for Review", reasons };
  }

  if (vendorComputedRisk === "High") {
    reasons.push("Vendor's computed risk profile is High");
    return { action: "REVIEW", csvLabel: "Flag for Review", reasons };
  }
  if (recentBankChange) {
    reasons.push("Vendor changed bank account details recently");
    return { action: "REVIEW", csvLabel: "Flag for Review", reasons };
  }

  if (budgetImpact.found && budgetImpact.projectedUtilizationPct >= thresholds.budgetDeferThresholdPct) {
    reasons.push(`Projected budget utilization would reach ${Math.round(budgetImpact.projectedUtilizationPct)}%, at or above the defer threshold (${thresholds.budgetDeferThresholdPct}%)`);
    return { action: "DEFER", csvLabel: "Escalate", reasons };
  }
  if (budgetImpact.found && budgetImpact.projectedUtilizationPct >= thresholds.budgetReviewThresholdPct) {
    reasons.push(`Projected budget utilization would reach ${Math.round(budgetImpact.projectedUtilizationPct)}%, at or above the review threshold (${thresholds.budgetReviewThresholdPct}%)`);
    return { action: "REVIEW", csvLabel: "Flag for Review", reasons };
  }

  if (anomalyScore >= thresholds.anomalyReviewThreshold) {
    reasons.push(`Anomaly score is ${Math.round(anomalyScore)}, at or above the review threshold (${thresholds.anomalyReviewThreshold})`);
    return { action: "REVIEW", csvLabel: "Flag for Review", reasons };
  }

  reasons.push("No critical validation issues, vendor risk is acceptable, budget impact is manageable, and the anomaly score is low");
  return { action: "APPROVE", csvLabel: "Approve", reasons };
}
