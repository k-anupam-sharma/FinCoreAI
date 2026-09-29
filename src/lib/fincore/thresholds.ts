// Configurable decision-engine thresholds.
//
// Mirrors the `decision_rules_config` seed in docs/database-schema.sql.
// Once Enter Cloud is available, this becomes a table read instead of a
// constant — the decision engine already takes thresholds as a parameter so
// that swap requires no logic changes.

export interface DecisionThresholds {
  duplicateReviewThreshold: number; // 0-100
  budgetReviewThresholdPct: number; // 0-100
  budgetDeferThresholdPct: number; // 0-100
  anomalyReviewThreshold: number; // 0-100
  vendorAmountMultiplierThreshold: number; // x times vendor average
  bankChangeLookbackDays: number;
}

export const DEFAULT_THRESHOLDS: DecisionThresholds = {
  duplicateReviewThreshold: 70,
  budgetReviewThresholdPct: 85,
  budgetDeferThresholdPct: 95,
  anomalyReviewThreshold: 60,
  vendorAmountMultiplierThreshold: 3,
  bankChangeLookbackDays: 30,
};
