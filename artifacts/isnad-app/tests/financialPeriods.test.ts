import assert from "node:assert/strict";
import test from "node:test";

import {
  FINANCIAL_PERIOD_OPTIONS,
  getCalendarPeriodDates,
  getFinancialPeriodDurationLabel,
  getNextCalendarPeriodDates,
  loadFinancialPeriodDuration,
  saveFinancialPeriodDuration,
} from "../src/financialPeriods.ts";

test("supports each configured calendar duration from October across year boundaries", () => {
  const expected = [
    { months: 1, startDate: "2026-10-01", endDate: "2026-10-31" },
    { months: 2, startDate: "2026-10-01", endDate: "2026-11-30" },
    { months: 3, startDate: "2026-10-01", endDate: "2026-12-31" },
    { months: 6, startDate: "2026-10-01", endDate: "2027-03-31" },
    { months: 12, startDate: "2026-10-01", endDate: "2027-09-30" },
  ] as const;

  assert.deepEqual(FINANCIAL_PERIOD_OPTIONS.map((option) => option.months), [1, 2, 3, 6, 12]);
  for (const period of expected) {
    assert.deepEqual(getCalendarPeriodDates("2026-10-20", period.months), {
      startDate: period.startDate,
      endDate: period.endDate,
    });
  }
});

test("uses leap-year month lengths and rolls a following period into the next year", () => {
  assert.deepEqual(getCalendarPeriodDates("2024-02-20", 1), {
    startDate: "2024-02-01",
    endDate: "2024-02-29",
  });
  assert.deepEqual(getNextCalendarPeriodDates("2026-12-31", 3), {
    startDate: "2027-01-01",
    endDate: "2027-03-31",
  });
  assert.deepEqual(getNextCalendarPeriodDates("2027-03-31", 6), {
    startDate: "2027-04-01",
    endDate: "2027-09-30",
  });
});

test("rejects invalid anchor dates and exposes user-facing duration labels", () => {
  assert.equal(getCalendarPeriodDates("2026-02-30", 1), null);
  assert.equal(getNextCalendarPeriodDates("not-a-date", 1), null);
  assert.equal(getFinancialPeriodDurationLabel(1), "شهر");
  assert.equal(getFinancialPeriodDurationLabel(12), "سنة");
});

test("persists and reloads the selected duration through app preference storage", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };

  assert.equal(loadFinancialPeriodDuration(storage), 1);
  saveFinancialPeriodDuration(storage, 6);
  assert.equal(loadFinancialPeriodDuration(storage), 6);
  values.set("isnad.financialPeriodDuration.v1", "invalid");
  assert.equal(loadFinancialPeriodDuration(storage), 1);
});
