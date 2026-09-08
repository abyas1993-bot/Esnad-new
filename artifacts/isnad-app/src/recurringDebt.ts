// ============================================================
// إسناد — دورة الدين المستمر (مستقلة تمامًا، قابلة للاختبار منفردة)
// وفق المواصفة v3، §5: forcedPaydown و reduceMinThenBalance منفصلتان تمامًا،
// ولا يوجد أي معامل خارجي (لا "minLimitReductionStep") يقرر مقدار التخفيض.
// ============================================================

export type RecurringDebtStage =
  | "rising"
  | "forced_paydown"
  | "min_reduction_ready"
  | "final_payoff"
  | "closed";

export interface RecurringDebtState {
  accountId: string;
  balance: number;
  minLimit: number;
  maxLimit: number;
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export function determineStage(state: RecurringDebtState): RecurringDebtStage {
  if (state.balance <= 0) return "closed";
  if (state.balance >= state.maxLimit) return "forced_paydown";
  if (state.minLimit === 0) return "final_payoff";
  if (state.balance <= state.minLimit) return "min_reduction_ready";
  return "rising";
}

export interface ForcedPaydownResult {
  accountId: string;
  stageBefore: RecurringDebtStage;
  stageAfter: RecurringDebtStage;
  amountAllocated: number; // Planned فقط — يحتاج تسجيل سداد فعلي عبر transactions.ts
  newBalanceProjected: number;
  reasonText: string;
}

/**
 * Stage 6أ — السداد الإجباري نحو الحد الأدنى عند بلوغ/تجاوز الحد الأعلى.
 * لا يخفّض minLimit إطلاقًا — فقط يقترح سداد الرصيد.
 */
export function forcedPaydown(state: RecurringDebtState, availableFunds: number): ForcedPaydownResult {
  const stageBefore = determineStage(state);
  if (stageBefore !== "forced_paydown") {
    return {
      accountId: state.accountId,
      stageBefore,
      stageAfter: stageBefore,
      amountAllocated: 0,
      newBalanceProjected: state.balance,
      reasonText: "الرصيد لم يبلغ الحد الأعلى — لا سداد إجباري في Stage 6أ.",
    };
  }
  const neededToReachMin = round2(state.balance - state.minLimit);
  const allocated = round2(Math.max(0, Math.min(availableFunds, neededToReachMin)));
  const newBalance = round2(state.balance - allocated);
  return {
    accountId: state.accountId,
    stageBefore,
    stageAfter: determineStage({ ...state, balance: newBalance }),
    amountAllocated: allocated,
    newBalanceProjected: newBalance,
    reasonText: `الرصيد (${state.balance}) بلغ/تجاوز الحد الأعلى (${state.maxLimit}) — أولوية قصوى لإعادته نحو الحد الأدنى (${state.minLimit}). خُصِّص ${allocated} (Planned).`,
  };
}

export interface ReduceMinThenBalanceResult {
  accountId: string;
  stageBefore: RecurringDebtStage;
  stageAfter: RecurringDebtStage;
  reducedMinLimitBy: number; // Planned — تعديل بيانات وصفية فقط، ليس قيدًا محاسبيًا (§5.5)
  reducedBalanceBy: number; // Planned — يحتاج سداد فعلي حقيقي ليتحقق (§5.5)
  newMinLimitProposed: number;
  newBalanceProjected: number;
  leftoverUnused: number; // >0 فقط إذا أُغلق الدين بالكامل ضمن هذه الخطوة — يتدفق تلقائيًا للعنصر التالي
  reasonText: string;
}

/**
 * Stage 6ب — القاعدة الحاسمة (§5.3 من المواصفة):
 * الفائض يُستهلَك أولًا في تخفيض الحد الأدنى (دولار مقابل دولار)، ثم الباقي يخفّض الرصيد مباشرة.
 * تُطبَّق فقط على ديون بحالة min_reduction_ready أو final_payoff.
 * لا معامل خارجي يقرر المقدار — كله مُشتَق حسابيًا من `surplus` المتاح فعليًا.
 */
export function reduceMinThenBalance(state: RecurringDebtState, surplus: number): ReduceMinThenBalanceResult {
  const stageBefore = determineStage(state);
  // غير مؤهَّل فقط إذا: (أ) لا يزال في forced_paydown (له آلية منفصلة أعلى أولوية، Stage 6أ)، أو (ب) مُغلَق فعليًا.
  // "rising" مؤهَّل أيضًا — مثالك المعتمَد (§16 مثال ب: رصيد 33,000 بين 10,000 و50,000) يطبّق هذه القاعدة مباشرة عليه.
  if (surplus <= 0 || stageBefore === "forced_paydown" || stageBefore === "closed") {
    return {
      accountId: state.accountId,
      stageBefore,
      stageAfter: stageBefore,
      reducedMinLimitBy: 0,
      reducedBalanceBy: 0,
      newMinLimitProposed: state.minLimit,
      newBalanceProjected: state.balance,
      leftoverUnused: Math.max(0, surplus),
      reasonText:
        surplus <= 0
          ? "لا فائض متاح لهذا الحساب في Stage 6ب."
          : `الحساب بحالة "${stageBefore}" — إما لا يزال بحاجة للسداد الإجباري (6أ له أولوية)، أو مُغلَق بالفعل.`,
    };
  }

  const reducedMinLimitBy = round2(Math.min(surplus, state.minLimit)); // لا يتجاوز الحد الأدنى الحالي أبدًا → لا سالب
  const newMinLimitProposed = round2(state.minLimit - reducedMinLimitBy);
  const remainingSurplus = round2(surplus - reducedMinLimitBy);
  const reducedBalanceBy = round2(Math.min(remainingSurplus, state.balance)); // لا يتجاوز الرصيد الحالي أبدًا
  const newBalanceProjected = round2(state.balance - reducedBalanceBy);
  const leftoverUnused = round2(remainingSurplus - reducedBalanceBy);
  const stageAfter = determineStage({ accountId: state.accountId, balance: newBalanceProjected, minLimit: newMinLimitProposed, maxLimit: state.maxLimit });

  let reasonText: string;
  if (reducedMinLimitBy > 0 && reducedBalanceBy > 0) {
    reasonText = `الفائض (${surplus}) خُصِّص: ${reducedMinLimitBy} لتخفيض الحد الأدنى المقترح (${state.minLimit}→${newMinLimitProposed})، و${reducedBalanceBy} لتخفيض الرصيد المُسقَط (${state.balance}→${newBalanceProjected}). كلاهما Planned فقط.`;
  } else if (reducedMinLimitBy > 0) {
    reasonText = `الفائض بالكامل (${reducedMinLimitBy}) خفّض الحد الأدنى المقترح فقط (${state.minLimit}→${newMinLimitProposed}) — الرصيد لم يتغيّر بعد.`;
  } else {
    reasonText = `الحد الأدنى صفر بالفعل — الفائض بالكامل (${reducedBalanceBy}) خفّض الرصيد المُسقَط مباشرة (${state.balance}→${newBalanceProjected}).`;
  }
  if (leftoverUnused > 0) {
    reasonText += ` تبقّى ${leftoverUnused} غير مستهلَك (الدين أُغلق بالكامل ضمن هذه الخطوة) — يتدفق تلقائيًا للعنصر التالي في نفس Stage 6ب ثم Stage 7.`;
  }

  return {
    accountId: state.accountId,
    stageBefore,
    stageAfter,
    reducedMinLimitBy,
    reducedBalanceBy,
    newMinLimitProposed,
    newBalanceProjected,
    leftoverUnused,
    reasonText,
  };
}
