// Cash-flow forecasting — a simple, clearly-labeled estimate, not a prediction
// with claimed accuracy. Projects trailing daily inflow/outflow rates forward.

import type { Transaction } from "@/types/fincore";

export interface ForecastResult {
  horizonDays: 30 | 60 | 90;
  lookbackDays: number;
  avgDailyInflow: number;
  avgDailyOutflow: number;
  projectedInflow: number;
  projectedOutflow: number;
  projectedNet: number;
  cumulativePositionToDate: number;
  projectedCashPosition: number;
  topInflowContributors: Array<{ category: string; amount: number }>;
  topOutflowContributors: Array<{ category: string; amount: number }>;
  disclaimer: string;
}

const DISCLAIMER = "Estimate based on recent historical patterns in your transaction data — not a guaranteed forecast.";

function topCategories(transactions: Transaction[], type: "inflow" | "outflow", limit = 3): Array<{ category: string; amount: number }> {
  const totals = new Map<string, number>();
  for (const t of transactions) {
    if (t.type !== type) continue;
    totals.set(t.category, (totals.get(t.category) ?? 0) + t.amount);
  }
  return [...totals.entries()]
    .map(([category, amount]) => ({ category, amount }))
    .sort((a, b) => b.amount - a.amount)
    .slice(0, limit);
}

export function forecastCashFlow(allTransactions: Transaction[], referenceDateISO: string, horizonDays: 30 | 60 | 90, lookbackDays = 90): ForecastResult {
  const referenceDate = new Date(referenceDateISO).getTime();
  const lookbackStart = referenceDate - lookbackDays * 24 * 60 * 60 * 1000;

  const lookbackTx = allTransactions.filter((t) => {
    const d = new Date(t.date).getTime();
    return !Number.isNaN(d) && d >= lookbackStart && d <= referenceDate;
  });

  const inflowTotal = lookbackTx.filter((t) => t.type === "inflow").reduce((s, t) => s + t.amount, 0);
  const outflowTotal = lookbackTx.filter((t) => t.type === "outflow").reduce((s, t) => s + t.amount, 0);
  const avgDailyInflow = inflowTotal / lookbackDays;
  const avgDailyOutflow = outflowTotal / lookbackDays;

  const projectedInflow = avgDailyInflow * horizonDays;
  const projectedOutflow = avgDailyOutflow * horizonDays;
  const projectedNet = projectedInflow - projectedOutflow;

  const cumulativePositionToDate = allTransactions
    .filter((t) => new Date(t.date).getTime() <= referenceDate)
    .reduce((s, t) => s + (t.type === "inflow" ? t.amount : -t.amount), 0);

  return {
    horizonDays,
    lookbackDays,
    avgDailyInflow,
    avgDailyOutflow,
    projectedInflow,
    projectedOutflow,
    projectedNet,
    cumulativePositionToDate,
    projectedCashPosition: cumulativePositionToDate + projectedNet,
    topInflowContributors: topCategories(lookbackTx, "inflow"),
    topOutflowContributors: topCategories(lookbackTx, "outflow"),
    disclaimer: DISCLAIMER,
  };
}
