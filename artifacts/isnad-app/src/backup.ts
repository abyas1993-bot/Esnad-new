// ============================================================
// إسناد — النسخ الاحتياطي والاستعادة (الملاحظة 1، §6-7)
// ملف مستقل بالكامل عن النواة المحاسبية: لا يحتوي أي منطق قيد مزدوج أو توزيع أو إغلاق،
// فقط تعريف شكل ملف النسخة الاحتياطية + تحقق دفاعي بحت (pure) من صحته قبل أي استعادة.
// التحقق هنا لا يلمس أي تخزين إطلاقًا — دالة واحدة تُدخِل بيانات خام (unknown، كما تُقرأ
// من ملف JSON اختاره المستخدم) وإما ترجع كائنًا موثوقًا أو ترمي استثناءً واضحًا، بحيث
// Repository.restoreBackup لا يستدعي StorageAdapter.replaceAllData إلا بعد نجاح كامل هنا.
// ============================================================
import { Account, JournalEntry, JournalLine } from "./types";
import { FinancialPeriodRecord, AccountPlanningSettings, FullDataSnapshot } from "./storage";
import { PeriodCloseResult } from "./period";
import { Currency } from "./currency";

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

function assertArray(v: unknown, fieldName: string): unknown[] {
  if (!Array.isArray(v)) throw new InvalidBackupFileError(`الحقل "${fieldName}" يجب أن يكون قائمة (array).`);
  return v;
}

function isValidJournalLine(v: unknown): v is JournalLine {
  if (!isPlainObject(v)) return false;
  if (!isNonEmptyString(v.accountId)) return false;
  if (v.direction !== "DEBIT" && v.direction !== "CREDIT") return false;
  if (!isFiniteNumber(v.amount) || v.amount <= 0) return false;
  return true;
}

function isValidAccount(v: unknown): v is Account {
  if (!isPlainObject(v)) return false;
  if (!isNonEmptyString(v.id) || !isNonEmptyString(v.name)) return false;
  if (!isNonEmptyString(v.category)) return false;
  if (!isFiniteNumber(v.openingBalance)) return false;
  if (v.status !== "active" && v.status !== "archived" && v.status !== "closed") return false;
  return true;
}

function isValidJournalEntry(v: unknown): v is JournalEntry {
  if (!isPlainObject(v)) return false;
  if (!isNonEmptyString(v.id) || !isNonEmptyString(v.entryDate)) return false;
  if (!isNonEmptyString(v.transactionType) || !isNonEmptyString(v.periodId)) return false;
  if (!Array.isArray(v.lines) || v.lines.length === 0) return false;
  return v.lines.every(isValidJournalLine);
}

function isValidPeriod(v: unknown): v is FinancialPeriodRecord {
  if (!isPlainObject(v)) return false;
  if (!isNonEmptyString(v.id) || !isNonEmptyString(v.startDate) || !isNonEmptyString(v.endDate)) return false;
  return v.status === "open" || v.status === "closed";
}

function isValidPeriodCloseResult(v: unknown): v is PeriodCloseResult {
  if (!isPlainObject(v)) return false;
  if (!isNonEmptyString(v.closedPeriodId) || !isNonEmptyString(v.nextPeriodId)) return false;
  if (!Array.isArray(v.summaryLines)) return false;
  return true;
}

const PLANNING_KINDS = new Set(["expense", "goal", "recurring_debt", "one_time_debt", "reserve", "income_source", "asset"]);
function isValidPlanningSettings(v: unknown): v is AccountPlanningSettings {
  if (!isPlainObject(v)) return false;
  if (!isNonEmptyString(v.accountId)) return false;
  if (!isNonEmptyString(v.kind) || !PLANNING_KINDS.has(v.kind)) return false;
  return true;
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
  if (!isNonEmptyString(raw.exportedAt)) {
    throw new InvalidBackupFileError('الحقل "exportedAt" مفقود أو ليس نصًا.');
  }
  if (!isPlainObject(raw.data)) {
    throw new InvalidBackupFileError('الحقل "data" مفقود أو ليس كائنًا.');
  }
  const data = raw.data;

  const accounts = assertArray(data.accounts, "data.accounts");
  if (!accounts.every(isValidAccount)) throw new InvalidBackupFileError("سجل حساب واحد أو أكثر في data.accounts غير صالح البنية.");

  const journalEntries = assertArray(data.journalEntries, "data.journalEntries");
  if (!journalEntries.every(isValidJournalEntry)) throw new InvalidBackupFileError("قيد واحد أو أكثر في data.journalEntries غير صالح البنية (أو غير متوازن الأطراف شكليًا).");

  const periods = assertArray(data.periods, "data.periods");
  if (!periods.every(isValidPeriod)) throw new InvalidBackupFileError("سجل فترة واحد أو أكثر في data.periods غير صالح البنية.");

  const periodCloseResults = assertArray(data.periodCloseResults, "data.periodCloseResults");
  if (!periodCloseResults.every(isValidPeriodCloseResult)) throw new InvalidBackupFileError("سجل إغلاق فترة واحد أو أكثر في data.periodCloseResults غير صالح البنية.");

  const planningSettings = assertArray(data.planningSettings, "data.planningSettings");
  if (!planningSettings.every(isValidPlanningSettings)) throw new InvalidBackupFileError("سجل إعدادات تخطيط واحد أو أكثر في data.planningSettings غير صالح البنية.");

  const currencies = assertArray(data.currencies, "data.currencies");
  if (!currencies.every(isValidCurrency)) throw new InvalidBackupFileError("سجل عملة واحد أو أكثر في data.currencies غير صالح البنية.");

  const accountCurrencyLinks = assertArray(data.accountCurrencyLinks, "data.accountCurrencyLinks");
  if (!accountCurrencyLinks.every(isValidAccountCurrencyLink)) throw new InvalidBackupFileError("سجل ربط عملة واحد أو أكثر في data.accountCurrencyLinks غير صالح البنية.");

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
  };
}
