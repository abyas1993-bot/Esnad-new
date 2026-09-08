// ============================================================
// إسناد — الأنواع الأساسية للنواة المحاسبية
// ============================================================

export type AccountTypeCode = "ASSET" | "LIABILITY" | "INCOME" | "EXPENSE" | "EQUITY";
export type NormalBalance = "DEBIT" | "CREDIT";

export type AccountCategory =
  | "pot"
  | "income_source"
  | "expense"
  | "recurring_debt"
  | "one_time_debt"
  | "goal"
  | "reserve"
  | "asset";

// كل فئة حساب مربوطة إلزاميًا بنوع محاسبي ثابت — لا يمكن كسر هذا الربط
export const CATEGORY_TO_TYPE: Record<AccountCategory, AccountTypeCode> = {
  pot: "ASSET",
  asset: "ASSET",
  goal: "ASSET", // أصل مقيّد
  reserve: "ASSET", // أصل مقيّد
  income_source: "INCOME",
  expense: "EXPENSE",
  recurring_debt: "LIABILITY",
  one_time_debt: "LIABILITY",
};

export const TYPE_NORMAL_BALANCE: Record<AccountTypeCode, NormalBalance> = {
  ASSET: "DEBIT",
  EXPENSE: "DEBIT",
  LIABILITY: "CREDIT",
  INCOME: "CREDIT",
  EQUITY: "CREDIT",
};

export interface Account {
  id: string;
  name: string;
  category: AccountCategory;
  openingBalance: number;
  status: "active" | "archived" | "closed";
  /**
   * كود حساب ظاهر وثابت (مثال: "6001") — طبقة تنظيم/عرض فوق `category` (المرحلة 4)،
   * منفصل تمامًا عن `id` الداخلي ولا يُستخدَم كمفتاح أساسي في أي مكان. اختياري للتوافق
   * الكامل مع الحسابات المحفوظة قبل إضافة هذا الحقل — قراءتها لا تنكسر إن كان غائبًا؛
   * `Repository.ensureAccountCodesAssigned` يمنح الحسابات القديمة كودًا مناسبًا مرة واحدة
   * (بترتيب مستقر) دون تغيير `id` أو `category` أو `openingBalance` أو `status` أو أي حقل آخر.
   */
  code?: string;
  // حقول خاصة بفئات محددة (اختيارية حسب الفئة)
  meta?: {
    monthlyMin?: number; // expense
    monthlyMax?: number; // expense
    priority?: ExpensePriority | GoalPriority | DebtPriority;
    minLimit?: number; // recurring_debt
    maxLimit?: number; // recurring_debt
    targetAmount?: number; // goal / one_time_debt (original_amount)
    dueDate?: string;
  };
}

export interface AccountGroup {
  n: number;
  label: string;
  categories: AccountCategory[];
}

/**
 * تجميع تنظيمي/عرضي فقط فوق AccountCategory (المرحلة 4) — طبقة واجهة، وليس نوعًا محاسبيًا
 * جديدًا ولا علاقة parent/child حقيقية بين الحسابات. الترتيب ثابت 1..8. كل فئة تنتمي لمجموعة
 * واحدة بالضبط فيما عدا المجموعة 8 "أخرى" الفارغة عمدًا حاليًا — لا فئة تُسنَد إليها تلقائيًا.
 */
export const ACCOUNT_GROUPS: AccountGroup[] = [
  { n: 1, label: "دخل", categories: ["income_source"] },
  { n: 2, label: "أوعية", categories: ["pot"] },
  { n: 3, label: "مصروفات", categories: ["expense"] },
  { n: 4, label: "أهداف", categories: ["goal"] },
  { n: 5, label: "إدخار", categories: ["reserve"] },
  { n: 6, label: "دائنون", categories: ["recurring_debt", "one_time_debt"] },
  { n: 7, label: "مقتنيات", categories: ["asset"] },
  { n: 8, label: "أخرى", categories: [] },
];

/** المجموعة التنظيمية التي تنتمي إليها فئة حساب معيَّنة — undefined فقط لفئة مستقبلية غير معرَّفة بعد. */
export function groupForCategory(category: AccountCategory): AccountGroup | undefined {
  return ACCOUNT_GROUPS.find((g) => g.categories.includes(category));
}

export type ExpensePriority = "essential_high" | "essential" | "essential_moderate";
export type GoalPriority = "critical" | "important" | "moderate";
export type DebtPriority = "urgent_high" | "urgent" | "urgent_moderate";

export type Direction = "DEBIT" | "CREDIT";

export interface JournalLine {
  accountId: string;
  direction: Direction;
  amount: number; // دائمًا > 0
  note?: string;
}

export type TransactionType =
  | "income"
  | "expense"
  | "transfer"
  | "debt_payment"
  | "debt_creation"
  | "goal_funding"
  | "reserve_withdraw"
  | "reserve_deposit"
  | "asset_purchase"
  | "asset_sale"
  | "correction"
  | "direct_entry";

export interface JournalEntry {
  id: string;
  entryDate: string;
  transactionType: TransactionType;
  description?: string;
  periodId: string;
  lines: JournalLine[];
  /**
   * رقم عملية ظاهر للمستخدم (تنسيق "0001"، "0002"...) — منفصل تمامًا عن `id` الداخلي،
   * ولا يُستخدَم كمفتاح أساسي في أي مخزن (`id` يبقى المفتاح الوحيد في IndexedDB/الملف).
   * اختياري للتوافق الكامل مع القيود المحفوظة قبل إضافة هذا الحقل — قراءتها لا تنكسر
   * إطلاقًا إن كان غائبًا (`undefined`)، وRepository.ensureOperationNumbersBackfilled
   * يمنحها رقمًا مناسبًا لاحقًا دون تغيير `id` أو ترتيبها الداخلي.
   */
  operationNumber?: string;
}

// ============================================================
// المرحلة التخطيطية — الفصل الثلاثي (Planned / Approved / Actual)
// ============================================================

export type VarianceType = "surplus" | "deficit" | "none";

export interface AccountPeriodPlan {
  periodId: string;
  accountId: string;
  plannedAmount: number; // مقترح المحرك
  approvedAmount: number; // معتمد المستخدم (قد يساوي plannedAmount)
  actualAmount: number; // من journal_lines الفعلية ضمن الفترة
  carriedIn: number; // موجب = فائض وارد، سالب = عجز وارد
}

export interface VarianceResult {
  accountId: string;
  category: AccountCategory;
  approvedAmount: number;
  actualAmount: number;
  variance: number; // القيمة المطلقة دائمًا موجبة
  varianceType: VarianceType;
  // فقط لحسابات المصروف: هل الفائض متاح فورًا أم معلّق لحين إغلاق الدورة؟
  pendingPeriodClose?: boolean;
  explanation: string;
}
