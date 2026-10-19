// ============================================================
// إسناد — النسخ الاحتياطي والاستعادة (الملاحظة 1، §6-7)
// ملف مستقل بالكامل عن النواة المحاسبية: لا يحتوي أي منطق قيد مزدوج أو توزيع أو إغلاق،
// فقط تعريف شكل ملف النسخة الاحتياطية + تحقق دفاعي بحت (pure) من صحته قبل أي استعادة.
// التحقق هنا لا يلمس أي تخزين إطلاقًا — دالة واحدة تُدخِل بيانات خام (unknown، كما تُقرأ
// من ملف JSON اختاره المستخدم) وإما ترجع كائنًا موثوقًا أو ترمي استثناءً واضحًا، بحيث
// Repository.restoreBackup لا يستدعي StorageAdapter.replaceAllData إلا بعد نجاح كامل هنا.
// ============================================================
import type { Account, AccountCategory, JournalEntry, JournalLine, TransactionType } from "./types";
import type { FinancialPeriodRecord, FullDataSnapshot } from "./storage";
import type { PeriodCloseResult } from "./period";
import type {
  AccountPlanningSettings,
  AssetPlanningSettings,
  ExpensePlanningSettings,
  GoalPlanningSettings,
  IncomePlanningSettings,
  OneTimeDebtPlanningSettings,
  RecurringDebtPlanningSettings,
} from "./storage";
import type { Currency } from "./currency";
import { isFinancialPeriodDuration } from "./financialPeriods";
import type { FinancialPeriodDuration } from "./financialPeriods";

/**
 * رقم إصدار "شكل ملف النسخة الاحتياطية" — مستقل تمامًا عن DB_VERSION في storage.ts
 * (ذاك رقم مخازن IndexedDB الداخلية ولا يجوز تغييره؛ هذا رقم عقد ملف JSON الخارجي فقط،
 * يمكن رفعه مستقبلًا دون أي علاقة بـIndexedDB). الاستعادة ترفض أي ملف لا يطابقه تمامًا
 * حاليًا — بساطة مقصودة إلى أن تُحتاج ترقية فعلية لشكل الملف.
 */
export const BACKUP_SCHEMA_VERSION = 1;

export interface BackupFile {
  schemaVersion: number;
  exportedAt: string; // ISO 8601
  data: FullDataSnapshot;
  /**
   * Non-IndexedDB application preferences. Optional so backups created before
   * this field was introduced remain restorable without changing DB_VERSION.
   */
  appSettings?: BackupAppSettings;
}

export interface BackupAppSettings {
  financialPeriodDuration: FinancialPeriodDuration;
}

export class InvalidBackupFileError extends Error {
  constructor(reason: string) {
    super(`ملف النسخة الاحتياطية غير صالح أو تالف: ${reason}`);
    this.name = "InvalidBackupFileError";
  }
}

export class IncompatibleBackupSchemaVersionError extends Error {
  constructor(found: unknown) {
    super(
      `إصدار ملف النسخة الاحتياطية غير متوافق (الموجود: ${JSON.stringify(found)}، المطلوب: ${BACKUP_SCHEMA_VERSION}) — لا يمكن استعادته بأمان في هذا الإصدار من التطبيق.`
    );
    this.name = "IncompatibleBackupSchemaVersionError";
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function isNonNegativeNumber(v: unknown): v is number {
  return isFiniteNumber(v) && v >= 0;
}

function isRealDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function isOptionalDate(value: unknown): boolean {
  return value === undefined || isRealDate(value);
}

function assertArray(v: unknown, fieldName: string): unknown[] {
  if (!Array.isArray(v)) throw new InvalidBackupFileError(`الحقل "${fieldName}" يجب أن يكون قائمة (array).`);
  return v;
}

function assertUniqueRecords<T>(records: T[], keyOf: (record: T) => string, fieldName: string): void {
  const seen = new Set<string>();
  for (const record of records) {
    const key = keyOf(record);
    if (seen.has(key)) throw new InvalidBackupFileError(`توجد معرّفات مكررة في "${fieldName}" (${key}).`);
    seen.add(key);
  }
}

const ACCOUNT_CATEGORIES = new Set<AccountCategory>([
  "pot",
  "income_source",
  "expense",
  "recurring_debt",
  "one_time_debt",
  "goal",
  "reserve",
  "asset",
]);
const TRANSACTION_TYPES = new Set<TransactionType>([
  "income",
  "expense",
  "transfer",
  "debt_payment",
  "debt_creation",
  "goal_funding",
  "reserve_withdraw",
  "reserve_deposit",
  "asset_purchase",
  "asset_sale",
  "correction",
  "direct_entry",
]);

function isValidJournalLine(v: unknown): v is JournalLine {
  if (!isPlainObject(v)) return false;
  if (!isNonEmptyString(v.accountId)) return false;
  if (v.direction !== "DEBIT" && v.direction !== "CREDIT") return false;
  if (!isFiniteNumber(v.amount) || v.amount <= 0) return false;
  if (v.note !== undefined && typeof v.note !== "string") return false;
  return true;
}

function isValidAccount(v: unknown): v is Account {
  if (!isPlainObject(v)) return false;
  if (!isNonEmptyString(v.id) || !isNonEmptyString(v.name)) return false;
  if (!ACCOUNT_CATEGORIES.has(v.category as AccountCategory)) return false;
  if (!isFiniteNumber(v.openingBalance) || v.openingBalance < 0) return false;
  if (v.status !== "active" && v.status !== "archived" && v.status !== "closed") return false;
  if (v.code !== undefined && typeof v.code !== "string") return false;
  if (v.meta !== undefined && !isPlainObject(v.meta)) return false;
  return true;
}

function isValidJournalEntry(v: unknown): v is JournalEntry {
  if (!isPlainObject(v)) return false;
  if (!isNonEmptyString(v.id) || !isRealDate(v.entryDate)) return false;
  if (!TRANSACTION_TYPES.has(v.transactionType as TransactionType) || !isNonEmptyString(v.periodId)) return false;
  if (v.description !== undefined && typeof v.description !== "string") return false;
  if (v.operationNumber !== undefined && !isNonEmptyString(v.operationNumber)) return false;
  if (!Array.isArray(v.lines) || v.lines.length === 0) return false;
  if (!v.lines.every(isValidJournalLine)) return false;
  const lines = v.lines as JournalLine[];
  const debit = lines.filter((line) => line.direction === "DEBIT").reduce((sum, line) => sum + line.amount, 0);
  const credit = lines.filter((line) => line.direction === "CREDIT").reduce((sum, line) => sum + line.amount, 0);
  return Math.round(debit * 100) === Math.round(credit * 100);
}

function isValidPeriod(v: unknown): v is FinancialPeriodRecord {
  if (!isPlainObject(v)) return false;
  if (!isNonEmptyString(v.id) || !isRealDate(v.startDate) || !isRealDate(v.endDate)) return false;
  return (v.status === "open" || v.status === "closed") && v.startDate <= v.endDate;
}

function isValidSummaryLine(v: unknown): boolean {
  if (!isPlainObject(v)) return false;
  return (
    isNonEmptyString(v.accountId) &&
    ACCOUNT_CATEGORIES.has(v.category as AccountCategory) &&
    isNonNegativeNumber(v.approvedAmount) &&
    isNonNegativeNumber(v.actualAmount) &&
    (v.varianceType === "surplus" || v.varianceType === "deficit" || v.varianceType === "none") &&
    isNonNegativeNumber(v.varianceAmount) &&
    typeof v.explanation === "string" &&
    typeof v.releasedAsFreeCash === "boolean" &&
    typeof v.carriedToNextPeriodAsDeficit === "boolean" &&
    typeof v.carriedToNextPeriodAsSurplus === "boolean"
  );
}

function isNonNegativeNumberRecord(v: unknown): v is Record<string, number> {
  return isPlainObject(v) && Object.entries(v).every(([key, amount]) => isNonEmptyString(key) && isNonNegativeNumber(amount));
}

function isValidPeriodCloseResult(v: unknown): v is PeriodCloseResult {
  if (!isPlainObject(v)) return false;
  if (!isNonEmptyString(v.closedPeriodId) || !isNonEmptyString(v.nextPeriodId)) return false;
  if (!Array.isArray(v.summaryLines) || !v.summaryLines.every(isValidSummaryLine)) return false;
  return (
    isNonNegativeNumber(v.freeCarriedSurplus) &&
    isNonNegativeNumberRecord(v.expensesCarriedDeficit) &&
    isNonNegativeNumberRecord(v.goalsCarriedDeficit) &&
    isNonNegativeNumberRecord(v.goalsCarriedSurplus) &&
    isNonNegativeNumberRecord(v.recurringDebtsCarriedDeficit) &&
    isNonNegativeNumberRecord(v.oneTimeDebtsCarriedDeficit) &&
    isNonNegativeNumber(v.reserveCarriedDeficit)
  );
}

const PLANNING_KINDS = new Set(["expense", "goal", "recurring_debt", "one_time_debt", "reserve", "income_source", "asset"]);
const EXPENSE_PRIORITIES = new Set(["essential_high", "essential", "essential_moderate"]);
const GOAL_PRIORITIES = new Set(["critical", "important", "moderate"]);
const DEBT_PRIORITIES = new Set(["urgent_high", "urgent", "urgent_moderate"]);

function isValidPlanningSettings(v: unknown): v is AccountPlanningSettings {
  if (!isPlainObject(v)) return false;
  if (!isNonEmptyString(v.accountId)) return false;
  if (!isNonEmptyString(v.kind) || !PLANNING_KINDS.has(v.kind)) return false;
  if (!isOptionalDate(v.dueDate)) return false;

  switch (v.kind) {
    case "expense": {
      const settings = v as unknown as ExpensePlanningSettings;
      return isNonNegativeNumber(settings.monthlyMin) && isNonNegativeNumber(settings.monthlyMax) &&
        settings.monthlyMax >= settings.monthlyMin && EXPENSE_PRIORITIES.has(settings.priority);
    }
    case "goal": {
      const settings = v as unknown as GoalPlanningSettings;
      return isNonNegativeNumber(settings.minAllocation) && isNonNegativeNumber(settings.maxAllocation) &&
        settings.maxAllocation >= settings.minAllocation && isNonNegativeNumber(settings.targetAmount) &&
        GOAL_PRIORITIES.has(settings.priority) &&
        (settings.isNonDeferrable === undefined || typeof settings.isNonDeferrable === "boolean");
    }
    case "recurring_debt": {
      const settings = v as unknown as RecurringDebtPlanningSettings;
      return isNonNegativeNumber(settings.minLimit) && isNonNegativeNumber(settings.maxLimit) &&
        settings.maxLimit >= settings.minLimit &&
        (settings.priority === undefined || DEBT_PRIORITIES.has(settings.priority));
    }
    case "one_time_debt":
      return DEBT_PRIORITIES.has((v as unknown as OneTimeDebtPlanningSettings).priority);
    case "reserve":
      return true;
    case "income_source": {
      const settings = v as unknown as IncomePlanningSettings;
      return (settings.recurrenceType === "fixed" || settings.recurrenceType === "intermittent") &&
        isNonNegativeNumber(settings.expectedAmount);
    }
    case "asset": {
      const settings = v as unknown as AssetPlanningSettings;
      return isNonNegativeNumber(settings.purchaseValue) &&
        (settings.currentValueEstimate === undefined || isNonNegativeNumber(settings.currentValueEstimate)) &&
        isOptionalDate(settings.purchaseDate);
    }
    default:
      return false;
  }
}

function isValidCurrency(v: unknown): v is Currency {
  if (!isPlainObject(v)) return false;
  return isNonEmptyString(v.code) && isNonEmptyString(v.name) && isNonEmptyString(v.symbol);
}

function isValidAccountCurrencyLink(v: unknown): v is { accountId: string; currencyCode: string } {
  if (!isPlainObject(v)) return false;
  return isNonEmptyString(v.accountId) && isNonEmptyString(v.currencyCode);
}

/**
 * تحقق كامل وصريح من بنية ملف نسخة احتياطية خام (كما يُقرأ نصًا من ملف JSON اختاره المستخدم
 * ثم يُمرَّر عبر JSON.parse). دالة نقية بلا أي أثر جانبي — لا تلمس التخزين إطلاقًا، فقط تفحص
 * الشكل وترمي استثناءً واضحًا عند أول مخالفة، أو تُعيد الكائن كاملًا موثوقًا (BackupFile) عند
 * النجاح. الترتيب: بنية عامة أولًا، ثم توافق schemaVersion، ثم كل مخزن من المخازن السبعة على حدة.
 */
export function validateBackupFile(raw: unknown): BackupFile {
  if (!isPlainObject(raw)) {
    throw new InvalidBackupFileError("الملف ليس كائن JSON صالحًا.");
  }
  if (!isFiniteNumber(raw.schemaVersion)) {
    throw new InvalidBackupFileError('الحقل "schemaVersion" مفقود أو ليس رقمًا.');
  }
  if (raw.schemaVersion !== BACKUP_SCHEMA_VERSION) {
    throw new IncompatibleBackupSchemaVersionError(raw.schemaVersion);
  }
  if (!isNonEmptyString(raw.exportedAt) || !Number.isFinite(Date.parse(raw.exportedAt))) {
    throw new InvalidBackupFileError('الحقل "exportedAt" مفقود أو ليس نصًا.');
  }
  if (!isPlainObject(raw.data)) {
    throw new InvalidBackupFileError('الحقل "data" مفقود أو ليس كائنًا.');
  }
  const data = raw.data;

  const accounts = assertArray(data.accounts, "data.accounts");
  if (!accounts.every(isValidAccount)) throw new InvalidBackupFileError("سجل حساب واحد أو أكثر في data.accounts غير صالح البنية.");
  assertUniqueRecords(accounts as Account[], (account) => account.id, "data.accounts");

  const journalEntries = assertArray(data.journalEntries, "data.journalEntries");
  if (!journalEntries.every(isValidJournalEntry)) throw new InvalidBackupFileError("قيد واحد أو أكثر في data.journalEntries غير صالح البنية (أو غير متوازن الأطراف شكليًا).");
  assertUniqueRecords(journalEntries as JournalEntry[], (entry) => entry.id, "data.journalEntries");

  const periods = assertArray(data.periods, "data.periods");
  if (!periods.every(isValidPeriod)) throw new InvalidBackupFileError("سجل فترة واحد أو أكثر في data.periods غير صالح البنية.");
  assertUniqueRecords(periods as FinancialPeriodRecord[], (period) => period.id, "data.periods");

  const periodCloseResults = assertArray(data.periodCloseResults, "data.periodCloseResults");
  if (!periodCloseResults.every(isValidPeriodCloseResult)) throw new InvalidBackupFileError("سجل إغلاق فترة واحد أو أكثر في data.periodCloseResults غير صالح البنية.");
  assertUniqueRecords(periodCloseResults as PeriodCloseResult[], (result) => result.closedPeriodId, "data.periodCloseResults");

  const planningSettings = assertArray(data.planningSettings, "data.planningSettings");
  if (!planningSettings.every(isValidPlanningSettings)) throw new InvalidBackupFileError("سجل إعدادات تخطيط واحد أو أكثر في data.planningSettings غير صالح البنية.");
  assertUniqueRecords(planningSettings as AccountPlanningSettings[], (settings) => settings.accountId, "data.planningSettings");

  const currencies = assertArray(data.currencies, "data.currencies");
  if (!currencies.every(isValidCurrency)) throw new InvalidBackupFileError("سجل عملة واحد أو أكثر في data.currencies غير صالح البنية.");
  assertUniqueRecords(currencies as Currency[], (currency) => currency.code, "data.currencies");

  const accountCurrencyLinks = assertArray(data.accountCurrencyLinks, "data.accountCurrencyLinks");
  if (!accountCurrencyLinks.every(isValidAccountCurrencyLink)) throw new InvalidBackupFileError("سجل ربط عملة واحد أو أكثر في data.accountCurrencyLinks غير صالح البنية.");
  assertUniqueRecords(accountCurrencyLinks as FullDataSnapshot["accountCurrencyLinks"], (link) => link.accountId, "data.accountCurrencyLinks");

  const accountIds = new Set((accounts as Account[]).map((account) => account.id));
  const periodById = new Map((periods as FinancialPeriodRecord[]).map((period) => [period.id, period]));
  const currencyCodes = new Set((currencies as Currency[]).map((currency) => currency.code));
  for (const entry of journalEntries as JournalEntry[]) {
    if (!periodById.has(entry.periodId) || entry.lines.some((line) => !accountIds.has(line.accountId))) {
      throw new InvalidBackupFileError(`القيد "${entry.id}" يشير إلى فترة أو حساب غير موجود في النسخة.`);
    }
  }
  for (const result of periodCloseResults as PeriodCloseResult[]) {
    if (periodById.get(result.closedPeriodId)?.status !== "closed" || !periodById.has(result.nextPeriodId)) {
      throw new InvalidBackupFileError(`نتيجة إغلاق الفترة "${result.closedPeriodId}" لا تشير إلى فترات موجودة وصالحة.`);
    }
    if (result.summaryLines.some((line) => !accountIds.has(line.accountId))) {
      throw new InvalidBackupFileError(`نتيجة إغلاق الفترة "${result.closedPeriodId}" تشير إلى حساب غير موجود.`);
    }
  }
  const expectedCategoryByKind: Record<AccountPlanningSettings["kind"], AccountCategory> = {
    expense: "expense",
    goal: "goal",
    recurring_debt: "recurring_debt",
    one_time_debt: "one_time_debt",
    reserve: "reserve",
    income_source: "income_source",
    asset: "asset",
  };
  const accountById = new Map((accounts as Account[]).map((account) => [account.id, account]));
  for (const settings of planningSettings as AccountPlanningSettings[]) {
    if (accountById.get(settings.accountId)?.category !== expectedCategoryByKind[settings.kind]) {
      throw new InvalidBackupFileError(`إعدادات التخطيط للحساب "${settings.accountId}" لا تطابق فئة الحساب.`);
    }
  }
  for (const link of accountCurrencyLinks as FullDataSnapshot["accountCurrencyLinks"]) {
    if (!accountIds.has(link.accountId) || !currencyCodes.has(link.currencyCode)) {
      throw new InvalidBackupFileError(`ربط العملة للحساب "${link.accountId}" يشير إلى حساب أو عملة غير موجودة.`);
    }
  }

  let appSettings: BackupAppSettings | undefined;
  if (raw.appSettings !== undefined) {
    if (!isPlainObject(raw.appSettings) || !isFinancialPeriodDuration(raw.appSettings.financialPeriodDuration)) {
      throw new InvalidBackupFileError('إعدادات التطبيق غير مكتملة أو تحتوي مدة فترة مالية غير صالحة.');
    }
    appSettings = { financialPeriodDuration: raw.appSettings.financialPeriodDuration };
  }

  return {
    schemaVersion: raw.schemaVersion,
    exportedAt: raw.exportedAt,
    data: {
      accounts: accounts as Account[],
      journalEntries: journalEntries as JournalEntry[],
      periods: periods as FinancialPeriodRecord[],
      periodCloseResults: periodCloseResults as PeriodCloseResult[],
      planningSettings: planningSettings as AccountPlanningSettings[],
      currencies: currencies as Currency[],
      accountCurrencyLinks: accountCurrencyLinks as FullDataSnapshot["accountCurrencyLinks"],
    },
    ...(appSettings ? { appSettings } : {}),
  };
}

export function createBackupFileName(exportedAt: string): string {
  const date = new Date(exportedAt);
  if (!Number.isFinite(date.getTime())) throw new InvalidBackupFileError("تاريخ إنشاء النسخة غير صالح.");
  const timestamp = date.toISOString().slice(0, 19).replace("T", "_").replace(/:/g, "-") + "Z";
  return `إسناد-نسخة-احتياطية-${timestamp}.json`;
}

export function createBackupFile(
  data: FullDataSnapshot,
  appSettings?: BackupAppSettings,
  exportedAt = new Date().toISOString(),
): BackupFile {
  return {
    schemaVersion: BACKUP_SCHEMA_VERSION,
    exportedAt,
    data,
    ...(appSettings ? { appSettings } : {}),
  };
}

export function parseBackupFileJson(text: string): BackupFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new InvalidBackupFileError("الملف المختار ليس JSON صالحًا.");
  }
  return validateBackupFile(parsed);
}

export async function restoreBackupData(
  raw: unknown,
  replaceAllData: (data: FullDataSnapshot) => Promise<void>,
): Promise<BackupFile> {
  const validated = validateBackupFile(raw);
  await replaceAllData(validated.data);
  return validated;
}
