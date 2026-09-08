// ============================================================
// إسناد — نواة دفتر اليومية (القيد المزدوج)
// ============================================================
import {
  Account,
  AccountCategory,
  CATEGORY_TO_TYPE,
  TYPE_NORMAL_BALANCE,
  JournalEntry,
  JournalLine,
} from "./types";

export class UnbalancedEntryError extends Error {
  constructor(debitTotal: number, creditTotal: number) {
    super(
      `قيد غير متوازن: إجمالي المدين=${debitTotal} لا يساوي إجمالي الدائن=${creditTotal}. تم رفض الحفظ.`
    );
    this.name = "UnbalancedEntryError";
  }
}

export class InvalidAmountError extends Error {
  constructor(amount: number) {
    super(`مبلغ غير صالح: ${amount}. يجب أن يكون رقمًا موجبًا أكبر من صفر.`);
    this.name = "InvalidAmountError";
  }
}

export class AccountCategoryMismatchError extends Error {
  constructor(accountId: string, expected: AccountCategory, actual: AccountCategory) {
    super(
      `الحساب ${accountId} من فئة "${actual}" لكن العملية تتطلب فئة "${expected}".`
    );
    this.name = "AccountCategoryMismatchError";
  }
}

/** يتحقق أن كل سطر مبلغه > 0، ثم أن إجمالي المدين = إجمالي الدائن. يرمي استثناء عند الفشل. */
export function validateBalancedEntry(lines: JournalLine[]): void {
  for (const line of lines) {
    if (!Number.isFinite(line.amount) || line.amount <= 0) {
      throw new InvalidAmountError(line.amount);
    }
  }
  const debitTotal = round2(
    lines.filter((l) => l.direction === "DEBIT").reduce((s, l) => s + l.amount, 0)
  );
  const creditTotal = round2(
    lines.filter((l) => l.direction === "CREDIT").reduce((s, l) => s + l.amount, 0)
  );
  if (debitTotal !== creditTotal) {
    throw new UnbalancedEntryError(debitTotal, creditTotal);
  }
}

/** إنشاء قيد جديد بعد التحقق الإلزامي من التوازن — يرفض الحفظ بالكامل عند أي مخالفة. */
export function createJournalEntry(entry: JournalEntry): JournalEntry {
  validateBalancedEntry(entry.lines);
  return entry;
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * حساب رصيد حساب معيّن اعتمادًا فقط على opening_balance + القيود الفعلية.
 * لا يوجد أي مصدر آخر للرصيد — يحقق: "الرصيد لا يُحسب من الواجهة ولا يُخزَّن يدويًا".
 */
export function computeBalance(account: Account, allEntries: JournalEntry[]): number {
  const accountType = CATEGORY_TO_TYPE[account.category];
  const normal = TYPE_NORMAL_BALANCE[accountType];

  let debitSum = 0;
  let creditSum = 0;
  for (const entry of allEntries) {
    for (const line of entry.lines) {
      if (line.accountId !== account.id) continue;
      if (line.direction === "DEBIT") debitSum += line.amount;
      else creditSum += line.amount;
    }
  }

  const balance =
    normal === "DEBIT"
      ? account.openingBalance + debitSum - creditSum
      : account.openingBalance + creditSum - debitSum;

  return round2(balance);
}

/** يمنع إنشاء حساب دون فئة/نوع محاسبي متطابق — القسم 39: "إنشاء حساب بدون نوع" ممنوع. */
export function assertValidAccountCategory(category: AccountCategory): void {
  if (!(category in CATEGORY_TO_TYPE)) {
    throw new Error(`فئة حساب غير معروفة: ${category}`);
  }
}

/** يتحقق أن حسابًا معينًا فعلًا من الفئة المتوقعة قبل تنفيذ عملية عليه (مثال: منع دخل يُسجَّل على حساب مصروف). */
export function assertAccountCategory(
  account: Account,
  expected: AccountCategory | AccountCategory[]
): void {
  const expectedList = Array.isArray(expected) ? expected : [expected];
  if (!expectedList.includes(account.category)) {
    throw new AccountCategoryMismatchError(account.id, expectedList[0], account.category);
  }
}
