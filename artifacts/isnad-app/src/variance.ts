// ============================================================
// إسناد — محرك الفروقات المرحّلة (Planned vs Approved vs Actual)
// القاعدة المعتمدة رسميًا (المستخدم، الرسالة الأخيرة):
//   المصروفات:      فعلي > معتمد => تجاوز/عجز | فعلي < معتمد => فائض (معلّق لحين الإغلاق)
//   الأهداف/الديون/الاحتياطي: فعلي > معتمد => فائض | فعلي < معتمد => عجز/احتياج مرحّل
// ============================================================
import { Account, AccountCategory, VarianceResult, VarianceType } from "./types";

const INVERTED_POLARITY_CATEGORIES: AccountCategory[] = ["expense"];
const NORMAL_POLARITY_CATEGORIES: AccountCategory[] = [
  "goal",
  "recurring_debt",
  "one_time_debt",
  "reserve",
];

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export function computeVariance(
  account: Account,
  approvedAmount: number,
  actualAmount: number,
  periodClosed: boolean = false
): VarianceResult {
  const diff = round2(actualAmount - approvedAmount);
  const category = account.category;

  if (diff === 0) {
    return {
      accountId: account.id,
      category,
      approvedAmount,
      actualAmount,
      variance: 0,
      varianceType: "none",
      explanation: "الفعلي مطابق تمامًا للمعتمد — لا فائض ولا عجز.",
    };
  }

  if (INVERTED_POLARITY_CATEGORIES.includes(category)) {
    // مصروف: فعلي أعلى = تجاوز/عجز | فعلي أقل = فائض
    if (diff > 0) {
      return {
        accountId: account.id,
        category,
        approvedAmount,
        actualAmount,
        variance: diff,
        varianceType: "deficit",
        explanation: `تجاوز مصروف بمقدار ${diff}. لا يُعتبر فائضًا بأي حال، ويُرحَّل كاحتياج يرفع أولوية هذا الحساب في توزيع الدخل القادم.`,
      };
    } else {
      const surplus = round2(Math.abs(diff));
      return {
        accountId: account.id,
        category,
        approvedAmount,
        actualAmount,
        variance: surplus,
        varianceType: "surplus",
        pendingPeriodClose: !periodClosed,
        explanation: periodClosed
          ? `فائض مصروف قدره ${surplus} تم التحقق من عدم ارتباطه بالتزامات مؤجلة — أصبح مالًا حرًا قابلًا لإعادة التوزيع.`
          : `فائض مصروف قدره ${surplus}، لكنه معلّق ولا يُعامَل كمال حر حتى إغلاق الدورة الشهرية والتحقق من عدم وجود التزامات أو عمليات مؤجلة مرتبطة بهذا الحساب.`,
      };
    }
  }

  if (NORMAL_POLARITY_CATEGORIES.includes(category)) {
    // هدف / دين / احتياطي: فعلي أعلى = فائض | فعلي أقل = عجز/احتياج مرحّل
    if (diff > 0) {
      const label = category === "recurring_debt" ? "فائض سداد" : "فائض";
      return {
        accountId: account.id,
        category,
        approvedAmount,
        actualAmount,
        variance: diff,
        varianceType: "surplus",
        explanation:
          category === "recurring_debt"
            ? `${label} قدره ${diff}: زيادة السداد الفعلي عن المخصص تذهب لتخفيض الالتزام مباشرة، ولا تصبح مالًا حرًا؛ تُرفَع كمؤشر محتمل لاقتراح خفض الحد الأدنى مستقبلًا.`
            : `${label} قدره ${diff} يدخل كمصدر فائض متاح لإعادة التوزيع في الفترة القادمة.`,
      };
    } else {
      const deficit = round2(Math.abs(diff));
      return {
        accountId: account.id,
        category,
        approvedAmount,
        actualAmount,
        variance: deficit,
        varianceType: "deficit",
        explanation: `عجز/احتياج مرحّل قدره ${deficit}. يُعطى أولوية قصوى لتمويل هذا الحساب تحديدًا في الفترة القادمة قبل أي تخصيص جديد له.`,
      };
    }
  }

  // فئات أخرى (pot, asset, income_source) لا تخضع لمنطق الفائض/العجز التخطيطي بهذا المعنى
  const type: VarianceType = diff > 0 ? "surplus" : "deficit";
  return {
    accountId: account.id,
    category,
    approvedAmount,
    actualAmount,
    variance: round2(Math.abs(diff)),
    varianceType: type,
    explanation: "هذه الفئة لا تخضع لمنطق الترحيل التخطيطي المعرَّف في هذا الإصدار.",
  };
}
