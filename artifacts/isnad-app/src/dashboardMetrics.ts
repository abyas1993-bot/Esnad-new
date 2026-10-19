import type { Account, JournalEntry } from "./types.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface DashboardMetrics {
  incomeActual: number;
  expenseActual: number;
  expenseActualByAccount: Map<string, number>;
}

/**
 * Sum each stored journal entry once, using account IDs/categories rather than
 * transaction labels. Transfers are excluded explicitly; ordinary transfers
 * are pot-to-pot, but this also protects totals from malformed legacy entries.
 */
export function calculateDashboardMetrics(
  accounts: Account[],
  entries: JournalEntry[],
): DashboardMetrics {
  const incomeAccountIds = new Set(
    accounts.filter((account) => account.category === "income_source").map((account) => account.id),
  );
  const expenseAccountIds = new Set(
    accounts.filter((account) => account.category === "expense").map((account) => account.id),
  );
  const expenseActualByAccount = new Map<string, number>(
    [...expenseAccountIds].map((accountId) => [accountId, 0] as const),
  );
  const seenEntryIds = new Set<string>();
  let incomeActual = 0;
  let expenseActual = 0;

  for (const entry of entries) {
    if (seenEntryIds.has(entry.id)) continue;
    seenEntryIds.add(entry.id);
    if (entry.transactionType === "transfer") continue;

    for (const line of entry.lines) {
      if (line.direction === "CREDIT" && incomeAccountIds.has(line.accountId)) {
        incomeActual += line.amount;
      }
      if (line.direction === "DEBIT" && expenseAccountIds.has(line.accountId)) {
        expenseActual += line.amount;
        expenseActualByAccount.set(
          line.accountId,
          (expenseActualByAccount.get(line.accountId) ?? 0) + line.amount,
        );
      }
    }
  }

  return { incomeActual, expenseActual, expenseActualByAccount };
}

function parseDateOnly(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    return null;
  }
  return parsed;
}

/**
 * Returns the period's length in monthly equivalents. Partial calendar months
 * are prorated by their actual number of days; period dates are inclusive.
 */
export function getPeriodMonthUnits(
  period: { startDate: string; endDate: string } | null,
): number | null {
  if (!period) return null;
  const start = parseDateOnly(period.startDate);
  const end = parseDateOnly(period.endDate);
  if (!start || !end || end.getTime() < start.getTime()) return null;

  const firstMonth = start.getUTCFullYear() * 12 + start.getUTCMonth();
  const lastMonth = end.getUTCFullYear() * 12 + end.getUTCMonth();
  const monthCount = lastMonth - firstMonth + 1;
  if (monthCount <= 0 || monthCount > 1200) return null;

  let units = 0;
  for (let offset = 0; offset < monthCount; offset += 1) {
    const monthIndex = firstMonth + offset;
    const year = Math.floor(monthIndex / 12);
    const month = monthIndex - year * 12;
    const monthStart = Date.UTC(year, month, 1);
    const nextMonthStart = Date.UTC(year, month + 1, 1);
    const monthEnd = nextMonthStart - DAY_MS;
    const overlapStart = Math.max(start.getTime(), monthStart);
    const overlapEnd = Math.min(end.getTime(), monthEnd);
    const overlapDays = Math.floor((overlapEnd - overlapStart) / DAY_MS) + 1;
    const daysInMonth = new Date(monthEnd).getUTCDate();
    units += overlapDays / daysInMonth;
  }

  return units > 0 ? units : null;
}

export function getPeriodExpenseLimit(
  monthlyMax: number,
  period: { startDate: string; endDate: string } | null,
): number | null {
  if (!Number.isFinite(monthlyMax) || monthlyMax <= 0) return null;
  const monthUnits = getPeriodMonthUnits(period);
  if (monthUnits === null) return null;
  return Math.round((monthlyMax * monthUnits + Number.EPSILON) * 100) / 100;
}

export interface ProgressRatio {
  hasLimit: boolean;
  percentage: number | null;
  fillPercentage: number;
}

export function getProgressRatio(value: number, limit: number): ProgressRatio {
  if (!Number.isFinite(value) || !Number.isFinite(limit) || limit <= 0) {
    return { hasLimit: false, percentage: null, fillPercentage: 0 };
  }

  const percentage = Math.round((Math.max(0, value) / limit) * 100);
  return {
    hasLimit: true,
    percentage,
    fillPercentage: Math.min(100, percentage),
  };
}

export function progressColor(pct: number): string {
  if (pct < 40) return "#a5d6a7"; // أخضر فاتح
  if (pct < 70) return "#2e7d32"; // أخضر غامق
  if (pct < 90) return "#bc8f6f"; // بني فاتح
  if (pct < 100) return "#795548"; // بني غامق
  return "#8c1f16"; // أحمر غامق عند الحد أو تجاوزه
}
