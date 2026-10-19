import assert from "node:assert/strict";
import test from "node:test";

import {
  calculateDashboardMetrics,
  getPeriodExpenseLimit,
  getPeriodMonthUnits,
  getProgressRatio,
  progressColor,
} from "../src/dashboardMetrics.ts";
import type { Account, JournalEntry } from "../src/types.ts";

const accounts: Account[] = [
  { id: "salary", name: "Salary", category: "income_source", openingBalance: 0, status: "active" },
  { id: "rent", name: "Rent", category: "expense", openingBalance: 0, status: "active" },
  { id: "food", name: "Food", category: "expense", openingBalance: 0, status: "active" },
  { id: "pot-a", name: "Pot A", category: "pot", openingBalance: 0, status: "active" },
  { id: "pot-b", name: "Pot B", category: "pot", openingBalance: 0, status: "active" },
];

function entry(
  id: string,
  transactionType: JournalEntry["transactionType"],
  lines: JournalEntry["lines"],
): JournalEntry {
  return { id, entryDate: "2026-02-10", transactionType, periodId: "p1", lines };
}

test("counts standard and direct income/expense lines and excludes transfers", () => {
  const regularIncome = entry("income-1", "income", [
    { accountId: "pot-a", direction: "DEBIT", amount: 100 },
    { accountId: "salary", direction: "CREDIT", amount: 100 },
  ]);
  const regularExpense = entry("expense-1", "expense", [
    { accountId: "rent", direction: "DEBIT", amount: 30 },
    { accountId: "pot-a", direction: "CREDIT", amount: 30 },
  ]);
  const directIncome = entry("direct-income", "direct_entry", [
    { accountId: "pot-a", direction: "DEBIT", amount: 20 },
    { accountId: "salary", direction: "CREDIT", amount: 20 },
  ]);
  const directExpense = entry("direct-expense", "direct_entry", [
    { accountId: "food", direction: "DEBIT", amount: 12 },
    { accountId: "pot-b", direction: "CREDIT", amount: 12 },
  ]);
  const transfer = entry("transfer-1", "transfer", [
    { accountId: "pot-b", direction: "DEBIT", amount: 50 },
    { accountId: "pot-a", direction: "CREDIT", amount: 50 },
  ]);

  const metrics = calculateDashboardMetrics(accounts, [
    regularIncome,
    regularExpense,
    directIncome,
    directExpense,
    transfer,
  ]);

  assert.equal(metrics.incomeActual, 120);
  assert.equal(metrics.expenseActual, 42);
  assert.equal(metrics.expenseActualByAccount.get("rent"), 30);
  assert.equal(metrics.expenseActualByAccount.get("food"), 12);
  assert.equal(metrics.incomeActual - metrics.expenseActual, 78);
});

test("does not count a duplicate stored journal entry twice", () => {
  const directExpense = entry("unique-id", "direct_entry", [
    { accountId: "rent", direction: "DEBIT", amount: 25 },
    { accountId: "pot-a", direction: "CREDIT", amount: 25 },
  ]);
  const metrics = calculateDashboardMetrics(accounts, [directExpense, { ...directExpense }]);
  assert.equal(metrics.expenseActual, 25);
  assert.equal(metrics.expenseActualByAccount.get("rent"), 25);
});

test("prorates a monthly cap by inclusive period days", () => {
  assert.equal(getPeriodMonthUnits({ startDate: "2026-02-01", endDate: "2026-02-28" }), 1);
  assert.equal(getPeriodExpenseLimit(1000, { startDate: "2026-02-01", endDate: "2026-02-28" }), 1000);
  assert.equal(getPeriodExpenseLimit(2800, { startDate: "2026-02-15", endDate: "2026-02-15" }), 100);
  assert.equal(getPeriodMonthUnits({ startDate: "2026-02-01", endDate: "2026-03-31" }), 2);
});

test("invalid dates, reversed periods, and missing limits have no planned cap", () => {
  assert.equal(getPeriodMonthUnits({ startDate: "2026-02-30", endDate: "2026-03-01" }), null);
  assert.equal(getPeriodExpenseLimit(1000, { startDate: "2026-03-01", endDate: "2026-02-01" }), null);
  assert.equal(getPeriodExpenseLimit(0, { startDate: "2026-02-01", endDate: "2026-02-28" }), null);
  assert.deepEqual(getProgressRatio(10, 0), {
    hasLimit: false,
    percentage: null,
    fillPercentage: 0,
  });
});

test("progress shows zero, near-limit, at-limit, and uncapped overrun ratios", () => {
  assert.deepEqual(getProgressRatio(0, 100), {
    hasLimit: true,
    percentage: 0,
    fillPercentage: 0,
  });
  assert.deepEqual(getProgressRatio(95, 100), {
    hasLimit: true,
    percentage: 95,
    fillPercentage: 95,
  });
  assert.deepEqual(getProgressRatio(100, 100), {
    hasLimit: true,
    percentage: 100,
    fillPercentage: 100,
  });
  assert.deepEqual(getProgressRatio(135, 100), {
    hasLimit: true,
    percentage: 135,
    fillPercentage: 100,
  });

  assert.equal(progressColor(10), "#a5d6a7");
  assert.equal(progressColor(50), "#2e7d32");
  assert.equal(progressColor(80), "#bc8f6f");
  assert.equal(progressColor(95), "#795548");
  assert.equal(progressColor(100), "#8c1f16");
  assert.equal(progressColor(135), "#8c1f16");
});
