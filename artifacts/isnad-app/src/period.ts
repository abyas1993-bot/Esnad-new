// ============================================================
// إسناد — دورة إغلاق الشهر وترحيل الفائض/العجز
// يستخدم فقط computeVariance من variance.ts (بدون أي تعديل عليها).
// لا يكتب أي قيد محاسبي، ولا يُعدِّل أي عملية تاريخية — يُنتج سجلًا تاريخيًا دائمًا + مدخلات جاهزة للفترة التالية.
// ============================================================
import { Account, AccountCategory } from "./types";
import { computeVariance } from "./variance";
import { ExpenseInput, GoalInput, OneTimeDebtInput, RecurringDebtInput, ReserveInput } from "./distribution";

export interface PeriodAccountActual {
  account: Account;
  approvedAmount: number; // ما اعتُمد لهذا الحساب هذه الفترة (Approved)
  actualAmount: number; // الفعلي المحسوب من القيود ضمن هذه الفترة (Actual)
  // فقط لحسابات المصروف: هل يوجد التزام/عملية مؤجلة مرتبطة بهذا الحساب تمنع تحرير الفائض فورًا؟
  hasPendingObligation?: boolean;
}

export interface PeriodClosingSummaryLine {
  accountId: string;
  category: AccountCategory;
  approvedAmount: number;
  actualAmount: number;
  varianceType: "surplus" | "deficit" | "none";
  varianceAmount: number;
  explanation: string;
  releasedAsFreeCash: boolean; // فقط للمصروفات الفائضة بعد التحقق من عدم وجود التزامات مؤجلة
  carriedToNextPeriodAsDeficit: boolean;
  carriedToNextPeriodAsSurplus: boolean;
}

export interface PeriodCloseResult {
  closedPeriodId: string;
  nextPeriodId: string;
  summaryLines: PeriodClosingSummaryLine[]; // سجل دائم — لا يُحذف ولا يُعاد حسابه لاحقًا
  freeCarriedSurplus: number; // يُمرَّر مباشرة إلى DistributionInput.freeCarriedSurplus للفترة التالية
  expensesCarriedDeficit: Record<string, number>; // accountId → مبلغ يُضاف إلى monthlyMin الفعلي
  goalsCarriedDeficit: Record<string, number>;
  goalsCarriedSurplus: Record<string, number>;
  recurringDebtsCarriedDeficit: Record<string, number>;
  oneTimeDebtsCarriedDeficit: Record<string, number>;
  reserveCarriedDeficit: number;
}

/**
 * إغلاق فترة مالية: يقارن كل حساب (Approved مقابل Actual)، يصنّف الفائض/العجز حسب نوع الحساب
 * وفق القاعدة المعتمدة في §11 (معكوسة للمصروفات، عادية للأهداف/الديون/الاحتياطي)،
 * وينتج سجلًا دائمًا + مدخلات جاهزة لتغذية محرك التوزيع في الفترة التالية.
 */
export function closePeriod(
  closedPeriodId: string,
  nextPeriodId: string,
  accountActuals: PeriodAccountActual[]
): PeriodCloseResult {
  const summaryLines: PeriodClosingSummaryLine[] = [];
  let freeCarriedSurplus = 0;
  const expensesCarriedDeficit: Record<string, number> = {};
  const goalsCarriedDeficit: Record<string, number> = {};
  const goalsCarriedSurplus: Record<string, number> = {};
  const recurringDebtsCarriedDeficit: Record<string, number> = {};
  const oneTimeDebtsCarriedDeficit: Record<string, number> = {};
  let reserveCarriedDeficit = 0;

  for (const item of accountActuals) {
    const v = computeVariance(item.account, item.approvedAmount, item.actualAmount, true);

    if (v.varianceType === "none") {
      summaryLines.push({
        accountId: item.account.id,
        category: item.account.category,
        approvedAmount: item.approvedAmount,
        actualAmount: item.actualAmount,
        varianceType: "none",
        varianceAmount: 0,
        explanation: v.explanation,
        releasedAsFreeCash: false,
        carriedToNextPeriodAsDeficit: false,
        carriedToNextPeriodAsSurplus: false,
      });
      continue;
    }

    let releasedAsFreeCash = false;
    let carriedDeficit = false;
    let carriedSurplus = false;

    if (item.account.category === "expense") {
      if (v.varianceType === "surplus") {
        if (item.hasPendingObligation) {
          // فائض حقيقي موجود في الوعاء، لكن لا يُحرَّر كمال حر هذه الدورة بسبب التزام مؤجل مرتبط بهذا الحساب.
          // المال نفسه لم يفقد — يبقى ببساطة في رصيد الوعاء الفعلي (§2)، ولا يُضاف لمجمع الفائض الحر.
        } else {
          freeCarriedSurplus = round2(freeCarriedSurplus + v.variance);
          releasedAsFreeCash = true;
        }
      } else {
        // تجاوز/عجز مصروف → يُرحَّل كاحتياج يرفع الحد الأدنى الفعلي لنفس الحساب في الفترة القادمة
        expensesCarriedDeficit[item.account.id] = round2((expensesCarriedDeficit[item.account.id] || 0) + v.variance);
        carriedDeficit = true;
      }
    } else if (item.account.category === "goal") {
      if (v.varianceType === "deficit") {
        goalsCarriedDeficit[item.account.id] = round2((goalsCarriedDeficit[item.account.id] || 0) + v.variance);
        carriedDeficit = true;
      } else {
        goalsCarriedSurplus[item.account.id] = round2((goalsCarriedSurplus[item.account.id] || 0) + v.variance);
        carriedSurplus = true;
      }
    } else if (item.account.category === "recurring_debt") {
      if (v.varianceType === "deficit") {
        recurringDebtsCarriedDeficit[item.account.id] = round2((recurringDebtsCarriedDeficit[item.account.id] || 0) + v.variance);
        carriedDeficit = true;
      }
      // فائض سداد الدين المستمر ينعكس مباشرة في الرصيد الفعلي المحدَّث (يُقرأ من الدفتر عند بناء الفترة التالية) — لا يحتاج ترحيلًا منفصلًا هنا
    } else if (item.account.category === "one_time_debt") {
      if (v.varianceType === "deficit") {
        oneTimeDebtsCarriedDeficit[item.account.id] = round2((oneTimeDebtsCarriedDeficit[item.account.id] || 0) + v.variance);
        carriedDeficit = true;
      }
      // فائض السداد ينعكس في remainingBalance المحدَّث من الدفتر مباشرة — لا ترحيل منفصل
    } else if (item.account.category === "reserve") {
      if (v.varianceType === "deficit") {
        reserveCarriedDeficit = round2(reserveCarriedDeficit + v.variance);
        carriedDeficit = true;
      }
    }

    summaryLines.push({
      accountId: item.account.id,
      category: item.account.category,
      approvedAmount: item.approvedAmount,
      actualAmount: item.actualAmount,
      varianceType: v.varianceType,
      varianceAmount: v.variance,
      explanation: v.explanation,
      releasedAsFreeCash,
      carriedToNextPeriodAsDeficit: carriedDeficit,
      carriedToNextPeriodAsSurplus: carriedSurplus,
    });
  }

  return {
    closedPeriodId,
    nextPeriodId,
    summaryLines,
    freeCarriedSurplus,
    expensesCarriedDeficit,
    goalsCarriedDeficit,
    goalsCarriedSurplus,
    recurringDebtsCarriedDeficit,
    oneTimeDebtsCarriedDeficit,
    reserveCarriedDeficit,
  };
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * يدمج نتيجة الإغلاق مع قوائم الحسابات الخام للفترة التالية (بلا حقول carried بعد)،
 * وينتج مدخلات جاهزة تمامًا لاستدعاء runDistribution() للفترة الجديدة مباشرة.
 */
export function applyCarriedForward(
  closeResult: PeriodCloseResult,
  raw: {
    incomeAvailable: number;
    expenses: Omit<ExpenseInput, "carriedDeficit">[];
    goals: Omit<GoalInput, "carriedDeficit" | "carriedSurplus">[];
    oneTimeDebts: Omit<OneTimeDebtInput, "carriedDeficit">[];
    recurringDebts: Omit<RecurringDebtInput, "carriedDeficit">[];
    reserve?: Omit<ReserveInput, "carriedDeficit">;
  }
): {
  periodId: string;
  incomeAvailable: number;
  freeCarriedSurplus: number;
  expenses: ExpenseInput[];
  goals: GoalInput[];
  oneTimeDebts: OneTimeDebtInput[];
  recurringDebts: RecurringDebtInput[];
  reserve?: ReserveInput;
} {
  return {
    periodId: closeResult.nextPeriodId,
    incomeAvailable: raw.incomeAvailable,
    freeCarriedSurplus: closeResult.freeCarriedSurplus,
    expenses: raw.expenses.map((e) => ({
      ...e,
      carriedDeficit: closeResult.expensesCarriedDeficit[e.account.id] || 0,
    })),
    goals: raw.goals.map((g) => ({
      ...g,
      carriedDeficit: closeResult.goalsCarriedDeficit[g.account.id] || 0,
      carriedSurplus: closeResult.goalsCarriedSurplus[g.account.id] || 0,
    })),
    oneTimeDebts: raw.oneTimeDebts.map((d) => ({
      ...d,
      carriedDeficit: closeResult.oneTimeDebtsCarriedDeficit[d.account.id] || 0,
    })),
    recurringDebts: raw.recurringDebts.map((d) => ({
      ...d,
      carriedDeficit: closeResult.recurringDebtsCarriedDeficit[d.account.id] || 0,
    })),
    reserve: raw.reserve
      ? { ...raw.reserve, carriedDeficit: closeResult.reserveCarriedDeficit }
      : undefined,
  };
}
