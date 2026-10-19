import assert from "node:assert/strict";
import test from "node:test";

import {
  recordDirectEntry,
  recordExpense,
  recordGoalFunding,
  recordIncome,
  recordOneTimeDebtPayment,
  recordRecurringDebtPayment,
  recordTransfer,
} from "../src/transactions.ts";
import { buildTransactionLogReport, renderReportToHtml } from "../src/reports.ts";
import type { Account, JournalEntry } from "../src/types.ts";

const source: Account = { id: "income", name: "دخل", category: "income_source", openingBalance: 0, status: "active" };
const expense: Account = { id: "expense", name: "مصروف", category: "expense", openingBalance: 0, status: "active" };
const pot: Account = { id: "pot", name: "وعاء", category: "pot", openingBalance: 1000, status: "active" };
const otherPot: Account = { id: "other-pot", name: "وعاء آخر", category: "pot", openingBalance: 0, status: "active" };
const recurringDebt: Account = { id: "recurring", name: "دين مستمر", category: "recurring_debt", openingBalance: 500, status: "active" };
const oneTimeDebt: Account = { id: "one-time", name: "دين لمرة واحدة", category: "one_time_debt", openingBalance: 500, status: "active" };
const goal: Account = { id: "goal", name: "هدف", category: "goal", openingBalance: 0, status: "active" };

const amount = 25;
const date = "2026-10-20";
const periodId = "period-test";
const note = "دفعة شهر أكتوبر";

function makeEntries(description?: string): JournalEntry[] {
  return [
    recordIncome(source, pot, amount, date, periodId, description),
    recordExpense(expense, pot, amount, date, periodId, false, 100, description),
    recordTransfer(pot, otherPot, amount, date, periodId, description),
    recordRecurringDebtPayment(recurringDebt, pot, amount, date, periodId, description),
    recordOneTimeDebtPayment(oneTimeDebt, pot, amount, date, periodId, 100, description),
    recordGoalFunding(goal, pot, amount, date, periodId, description),
    recordDirectEntry(expense, pot, amount, date, periodId, description),
  ];
}

test("all supported transaction factories preserve the optional description and balanced lines", () => {
  const entries = makeEntries(note);
  assert.deepEqual(entries.map((entry) => entry.transactionType), [
    "income",
    "expense",
    "transfer",
    "debt_payment",
    "debt_payment",
    "goal_funding",
    "direct_entry",
  ]);

  for (const entry of entries) {
    assert.equal(entry.description, note);
    assert.equal(
      entry.lines.filter((line) => line.direction === "DEBIT").reduce((sum, line) => sum + line.amount, 0),
      entry.lines.filter((line) => line.direction === "CREDIT").reduce((sum, line) => sum + line.amount, 0),
    );
  }
});

test("description remains optional for old callers and old operations", () => {
  for (const entry of makeEntries()) assert.equal(entry.description, undefined);
});

test("transaction reports include descriptions as text and escape markup in HTML", () => {
  const maliciousNote = "<script>alert('x')</script>";
  const entry = {
    ...recordExpense(expense, pot, amount, date, periodId, false, 100, maliciousNote),
    displayOperationNumber: "0001",
  };
  const report = buildTransactionLogReport({
    entries: [entry],
    accounts: [expense, pot],
    accountCurrencies: new Map(),
  });

  assert.equal(report.document.rows[0][2], `مصروف — ${maliciousNote}`);
  const html = renderReportToHtml(report.document);
  assert.ok(html.includes("&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;"));
  assert.ok(!html.includes("<script>"));
});
