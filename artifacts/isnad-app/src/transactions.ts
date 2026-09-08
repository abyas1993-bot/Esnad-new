// ============================================================
// إسناد — طبقة تسجيل العمليات (فوق نواة دفتر اليومية)
// ============================================================
import { Account, JournalEntry } from "./types";
import { assertAccountCategory, createJournalEntry } from "./ledger";

let seq = 0;
/**
 * توليد معرّف قيد فريد. مُصلَح (خطأ مثبَت باختبار Offline E2E حقيقي، 2026):
 * الصيغة القديمة (عدّاد ذاكرة `seq` فقط) كانت تُصفَّر عند كل إعادة تحميل للصفحة،
 * فتتصادم المعرّفات بين الجلسات (مثال: "je_1" يتكرر بعد كل reload) ويُرفَض قيد صحيح
 * محاسبيًا خطأً بسبب تصادم معرّف وهمي — وليس أي خلل في قواعد القيد المزدوج نفسها.
 * الإصلاح: دمج الوقت الفعلي + جزء عشوائي، فريد عمليًا عبر الجلسات وإعادة التحميل،
 * دون أي تغيير في منطق أو توقيع أي دالة تسجيل عملية أدناه.
 */
function nextId(prefix: string): string {
  seq += 1;
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now()}_${seq}_${rand}`;
}

export function recordIncome(
  incomeSource: Account,
  pot: Account,
  amount: number,
  date: string,
  periodId: string
): JournalEntry {
  assertAccountCategory(incomeSource, "income_source");
  assertAccountCategory(pot, "pot");
  return createJournalEntry({
    id: nextId("je"),
    entryDate: date,
    transactionType: "income",
    periodId,
    lines: [
      { accountId: pot.id, direction: "DEBIT", amount },
      { accountId: incomeSource.id, direction: "CREDIT", amount },
    ],
  });
}

export function recordExpense(
  expenseCategory: Account,
  pot: Account,
  amount: number,
  date: string,
  periodId: string,
  allowNegativePot = false,
  currentPotBalance?: number
): JournalEntry {
  assertAccountCategory(expenseCategory, "expense");
  assertAccountCategory(pot, "pot");
  if (!allowNegativePot && currentPotBalance !== undefined && amount > currentPotBalance) {
    throw new Error(
      `العملية مرفوضة: المبلغ (${amount}) يتجاوز رصيد الوعاء الحالي (${currentPotBalance}) والوعاء لا يسمح برصيد سالب.`
    );
  }
  return createJournalEntry({
    id: nextId("je"),
    entryDate: date,
    transactionType: "expense",
    periodId,
    lines: [
      { accountId: expenseCategory.id, direction: "DEBIT", amount },
      { accountId: pot.id, direction: "CREDIT", amount },
    ],
  });
}

export function recordTransfer(
  fromPot: Account,
  toPot: Account,
  amount: number,
  date: string,
  periodId: string
): JournalEntry {
  assertAccountCategory(fromPot, "pot");
  assertAccountCategory(toPot, "pot");
  return createJournalEntry({
    id: nextId("je"),
    entryDate: date,
    transactionType: "transfer",
    periodId,
    lines: [
      { accountId: toPot.id, direction: "DEBIT", amount },
      { accountId: fromPot.id, direction: "CREDIT", amount },
    ],
  });
}

export function recordRecurringDebtPayment(
  debtAccount: Account,
  pot: Account,
  amount: number,
  date: string,
  periodId: string
): JournalEntry {
  assertAccountCategory(debtAccount, "recurring_debt");
  assertAccountCategory(pot, "pot");
  return createJournalEntry({
    id: nextId("je"),
    entryDate: date,
    transactionType: "debt_payment",
    periodId,
    lines: [
      { accountId: debtAccount.id, direction: "DEBIT", amount },
      { accountId: pot.id, direction: "CREDIT", amount },
    ],
  });
}

export function recordOneTimeDebtPayment(
  debtAccount: Account,
  pot: Account,
  amount: number,
  date: string,
  periodId: string,
  currentDebtBalance: number
): JournalEntry {
  assertAccountCategory(debtAccount, "one_time_debt");
  assertAccountCategory(pot, "pot");
  if (amount > currentDebtBalance) {
    throw new Error(
      `العملية مرفوضة: السداد (${amount}) يتجاوز رصيد الدين الحالي (${currentDebtBalance}).`
    );
  }
  return createJournalEntry({
    id: nextId("je"),
    entryDate: date,
    transactionType: "debt_payment",
    periodId,
    lines: [
      { accountId: debtAccount.id, direction: "DEBIT", amount },
      { accountId: pot.id, direction: "CREDIT", amount },
    ],
  });
}

export function recordGoalFunding(
  goal: Account,
  pot: Account,
  amount: number,
  date: string,
  periodId: string
): JournalEntry {
  assertAccountCategory(goal, "goal");
  assertAccountCategory(pot, "pot");
  return createJournalEntry({
    id: nextId("je"),
    entryDate: date,
    transactionType: "goal_funding",
    periodId,
    lines: [
      { accountId: goal.id, direction: "DEBIT", amount },
      { accountId: pot.id, direction: "CREDIT", amount },
    ],
  });
}

/**
 * قيد مباشر بين أي حسابين — بلا قيد على الفئة المحاسبية لأي منهما (خلافًا لكل الدوال
 * أعلاه التي تفرض فئة محددة لكل طرف عبر assertAccountCategory). يُستخدَم عندما لا يلائم
 * أي نوع عملية قياسي الحالة (مثال: تحويل مباشر بين حسابي دين، أو تصحيح بين أي حسابين).
 * التوازن والمبلغ الموجب يُتحقَّق منهما كالمعتاد عبر createJournalEntry/ledger.ts دون أي
 * إضافة هناك. فحص "نفس الحساب" وحده مضاف هنا لأنه لا معنى محاسبيًا لقيد طرفاه حساب واحد،
 * ولا تغطيه قواعد ledger.ts العامة (وهو نفس ما تتحقق منه شاشة العمليات لـ"تحويل بين أوعية").
 */
export function recordDirectEntry(
  debitAccount: Account,
  creditAccount: Account,
  amount: number,
  date: string,
  periodId: string,
  description?: string
): JournalEntry {
  if (debitAccount.id === creditAccount.id) {
    throw new Error("لا يجوز أن يكون الحساب المدين والحساب الدائن نفس الحساب.");
  }
  return createJournalEntry({
    id: nextId("je"),
    entryDate: date,
    transactionType: "direct_entry",
    description,
    periodId,
    lines: [
      { accountId: debitAccount.id, direction: "DEBIT", amount },
      { accountId: creditAccount.id, direction: "CREDIT", amount },
    ],
  });
}
