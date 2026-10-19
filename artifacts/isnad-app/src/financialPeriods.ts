export const FINANCIAL_PERIOD_OPTIONS = [
  { months: 1, label: "شهر" },
  { months: 2, label: "شهران" },
  { months: 3, label: "3 أشهر" },
  { months: 6, label: "6 أشهر" },
  { months: 12, label: "سنة" },
] as const;

export type FinancialPeriodDuration = (typeof FINANCIAL_PERIOD_OPTIONS)[number]["months"];

export const DEFAULT_FINANCIAL_PERIOD_DURATION: FinancialPeriodDuration = 1;
export const FINANCIAL_PERIOD_DURATION_STORAGE_KEY = "isnad.financialPeriodDuration.v1";

export interface PreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function isFinancialPeriodDuration(value: unknown): value is FinancialPeriodDuration {
  return FINANCIAL_PERIOD_OPTIONS.some((option) => option.months === value);
}

export function loadFinancialPeriodDuration(
  storage: Pick<PreferenceStorage, "getItem">,
): FinancialPeriodDuration {
  const saved = storage.getItem(FINANCIAL_PERIOD_DURATION_STORAGE_KEY);
  const parsed = saved === null ? DEFAULT_FINANCIAL_PERIOD_DURATION : Number(saved);
  return isFinancialPeriodDuration(parsed) ? parsed : DEFAULT_FINANCIAL_PERIOD_DURATION;
}

export function saveFinancialPeriodDuration(
  storage: Pick<PreferenceStorage, "setItem">,
  duration: FinancialPeriodDuration,
): void {
  if (!isFinancialPeriodDuration(duration)) throw new Error("مدة الفترة المالية غير صالحة.");
  storage.setItem(FINANCIAL_PERIOD_DURATION_STORAGE_KEY, String(duration));
}

interface DateParts {
  year: number;
  month: number;
  day: number;
}

function parseDateOnly(value: string): DateParts | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    !Number.isFinite(date.getTime()) ||
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return { year, month, day };
}

function formatDate(year: number, monthIndex: number, day: number): string {
  const date = new Date(Date.UTC(year, monthIndex, day));
  return `${String(date.getUTCFullYear()).padStart(4, "0")}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

function daysInMonth(year: number, monthIndex: number): number {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

/** Builds a calendar period beginning on the first day of the anchor's month. */
export function getCalendarPeriodDates(
  anchorDate: string,
  duration: FinancialPeriodDuration,
): { startDate: string; endDate: string } | null {
  const anchor = parseDateOnly(anchorDate);
  if (!anchor || !isFinancialPeriodDuration(duration)) return null;

  const monthIndex = anchor.month - 1;
  const endMonth = monthIndex + duration - 1;
  const endYear = anchor.year + Math.floor(endMonth / 12);
  const normalizedEndMonth = endMonth % 12;
  return {
    startDate: formatDate(anchor.year, monthIndex, 1),
    endDate: formatDate(endYear, normalizedEndMonth, daysInMonth(endYear, normalizedEndMonth)),
  };
}

/** Starts a new calendar period in the month after the previous period ends. */
export function getNextCalendarPeriodDates(
  previousEndDate: string,
  duration: FinancialPeriodDuration,
): { startDate: string; endDate: string } | null {
  const previousEnd = parseDateOnly(previousEndDate);
  if (!previousEnd || !isFinancialPeriodDuration(duration)) return null;

  const nextMonthStart = formatDate(previousEnd.year, previousEnd.month, 1);
  return getCalendarPeriodDates(nextMonthStart, duration);
}

export function getFinancialPeriodDurationLabel(duration: FinancialPeriodDuration): string {
  return FINANCIAL_PERIOD_OPTIONS.find((option) => option.months === duration)!.label;
}
