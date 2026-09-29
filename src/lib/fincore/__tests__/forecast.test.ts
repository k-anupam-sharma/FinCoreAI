import { describe, expect, it } from "vitest";
import { forecastCashFlow } from "../forecast";
import type { Transaction } from "@/types/fincore";

function tx(date: string, type: "inflow" | "outflow", amount: number, category = "General"): Transaction {
  return { transaction_id: `T-${date}-${type}-${amount}`, company_id: "COMP-01", date, type, category, amount };
}

describe("forecastCashFlow", () => {
  it("scales projected inflow/outflow linearly with the horizon", () => {
    // 10 days of history: 1000 inflow/day, 400 outflow/day.
    const transactions: Transaction[] = [];
    for (let d = 1; d <= 10; d++) {
      const date = `2026-06-${String(d).padStart(2, "0")}`;
      transactions.push(tx(date, "inflow", 1000));
      transactions.push(tx(date, "outflow", 400));
    }

    const forecast30 = forecastCashFlow(transactions, "2026-06-10", 30, 10);
    const forecast60 = forecastCashFlow(transactions, "2026-06-10", 60, 10);

    expect(forecast30.avgDailyInflow).toBeCloseTo(1000, 5);
    expect(forecast30.avgDailyOutflow).toBeCloseTo(400, 5);
    expect(forecast30.projectedInflow).toBeCloseTo(30000, 5);
    expect(forecast60.projectedInflow).toBeCloseTo(60000, 5);
    expect(forecast30.disclaimer).toMatch(/estimate/i);
  });

  it("ignores transactions outside the lookback window", () => {
    const transactions: Transaction[] = [tx("2020-01-01", "inflow", 1_000_000), tx("2026-06-05", "inflow", 500)];
    const forecast = forecastCashFlow(transactions, "2026-06-10", 30, 10);
    expect(forecast.avgDailyInflow).toBeCloseTo(50, 5); // 500 / 10 days
  });
});
