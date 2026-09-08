// ============================================================
// إسناد — محرك التوزيع (Stage 0 → Stage 8) — وفق المواصفة الرسمية v3
// مستقل تمامًا عن أي واجهة أو دفتر قيود. Planned فقط — بلا أي أثر جانبي محاسبي.
// ============================================================
import { Account, ExpensePriority, GoalPriority, DebtPriority } from "./types";
import { RecurringDebtState, forcedPaydown, reduceMinThenBalance } from "./recurringDebt";

const EXPENSE_TIERS: ExpensePriority[] = ["essential_high", "essential", "essential_moderate"];
const GOAL_TIERS: GoalPriority[] = ["critical", "important", "moderate"];
const DEBT_TIERS: DebtPriority[] = ["urgent_high", "urgent", "urgent_moderate"];

const PRIORITY_RANK: Record<string, number> = {
  essential_high: 1, critical: 1, urgent_high: 1,
  essential: 2, important: 2, urgent: 2,
  essential_moderate: 3, moderate: 3, urgent_moderate: 3,
};

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export interface ExpenseInput {
  account: Account;
  monthlyMin: number;
  monthlyMax: number;
  priority: ExpensePriority;
  dueDate?: string;
  carriedDeficit?: number;
}

export interface GoalInput {
  account: Account;
  minAllocation: number;
  maxAllocation: number;
  targetAmount: number;
  achievedAmount: number;
  priority: GoalPriority;
  dueDate?: string;
  carriedDeficit?: number;
  carriedSurplus?: number;
  isNonDeferrable?: boolean;
}

export interface OneTimeDebtInput {
  account: Account;
  remainingBalance: number;
  priority: DebtPriority;
  dueDate?: string;
  carriedDeficit?: number;
}

export interface RecurringDebtInput {
  account: Account;
  currentBalance: number;
  minLimit: number;
  maxLimit: number;
  priority?: DebtPriority;
  dueDate?: string;
  carriedDeficit?: number;
}

export interface ReserveInput {
  account: Account;
  carriedDeficit?: number;
}

export interface DistributionInput {
  periodId: string;
  incomeAvailable: number;
  freeCarriedSurplus?: number;
  expenses: ExpenseInput[];
  goals: GoalInput[];
  oneTimeDebts: OneTimeDebtInput[];
  recurringDebts: RecurringDebtInput[];
  reserve?: ReserveInput;
}

export interface PlannedAllocation {
  accountId: string;
  stage: number;
  amount: number;
  reasonCode: string;
  reasonText: string;
}

export interface AccountFundingDetail {
  accountId: string;
  category: string;
  priority: string;
  dueDate?: string;
  carriedDeficit: number;
  baseAmount: number;
  totalNeeded: number;
  funded: number;
  remaining: number;
  reasonNotFunded?: string;
}

export interface InsufficientAllocationReport {
  totalRequired: number;
  totalFunded: number;
  totalUnfunded: number;
  perAccount: AccountFundingDetail[];
}

export interface RecurringDebtResult {
  accountId: string;
  forcedPaydownAmount: number;
  reducedMinLimitBy: number;
  reducedBalanceBy: number;
  newMinLimitProposed: number;
  newBalanceProjected: number;
  stageAfter: string;
  reasonText: string;
}

export interface DistributionResult {
  periodId: string;
  incomeAvailable: number; // الدخل الخام كما أُدخِل (input.incomeAvailable فقط)
  totalIncomeAvailable: number; // incomeAvailable + freeCarriedSurplus — الإجمالي الفعلي الذي يبدأ منه التوزيع
  allocations: PlannedAllocation[];
  insufficientAllocationReport?: InsufficientAllocationReport;
  recurringDebtResults: RecurringDebtResult[];
  remainingAfterAllStages: number;
  stoppedAfterStage1: boolean;
}

interface SortableItem {
  accountId: string;
  priority: string;
  dueDate?: string;
}

function tieBreakSort<T extends SortableItem>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    const ra = PRIORITY_RANK[a.priority] ?? 99;
    const rb = PRIORITY_RANK[b.priority] ?? 99;
    if (ra !== rb) return ra - rb;
    if (a.dueDate && b.dueDate) {
      if (a.dueDate !== b.dueDate) return a.dueDate < b.dueDate ? -1 : 1;
    } else if (a.dueDate && !b.dueDate) {
      return -1;
    } else if (!a.dueDate && b.dueDate) {
      return 1;
    }
    return a.accountId < b.accountId ? -1 : a.accountId > b.accountId ? 1 : 0;
  });
}

function proportionalDistribute(items: { accountId: string; remainingNeed: number }[], available: number): { allocated: Record<string, number>; leftover: number } {
  const positive = items.filter((i) => i.remainingNeed > 0);
  const totalNeed = round2(positive.reduce((s, i) => s + i.remainingNeed, 0));
  const allocated: Record<string, number> = {};
  if (totalNeed <= 0) return { allocated, leftover: available };
  if (available >= totalNeed) {
    for (const i of positive) allocated[i.accountId] = round2(i.remainingNeed);
    return { allocated, leftover: round2(available - totalNeed) };
  }
  const snapshot = available;
  for (const i of positive) {
    allocated[i.accountId] = round2(snapshot * (i.remainingNeed / totalNeed));
  }
  return { allocated, leftover: 0 };
}

export function runDistribution(input: DistributionInput): DistributionResult {
  const totalIncomeAvailable = round2(input.incomeAvailable + (input.freeCarriedSurplus || 0));
  let available = totalIncomeAvailable;
  const allocations: PlannedAllocation[] = [];
  const fundingDetails: AccountFundingDetail[] = [];

  const push = (accountId: string, stage: number, amount: number, reasonCode: string, reasonText: string) => {
    if (amount <= 0) return;
    allocations.push({ accountId, stage, amount: round2(amount), reasonCode, reasonText });
  };

  type Stage0Item = SortableItem & { need: number; category: string };

  const group1_expenses: Stage0Item[] = input.expenses
    .filter((e) => (e.carriedDeficit || 0) > 0)
    .map((e) => ({ accountId: e.account.id, priority: e.priority, dueDate: e.dueDate, need: e.carriedDeficit || 0, category: "expense" }));

  const group2_obligations: Stage0Item[] = [
    ...input.oneTimeDebts
      .filter((d) => (d.carriedDeficit || 0) > 0)
      .map((d) => ({ accountId: d.account.id, priority: d.priority, dueDate: d.dueDate, need: d.carriedDeficit || 0, category: "one_time_debt" })),
    ...input.recurringDebts
      .filter((d) => (d.carriedDeficit || 0) > 0)
      .map((d) => ({ accountId: d.account.id, priority: d.priority || "urgent_moderate", dueDate: d.dueDate, need: d.carriedDeficit || 0, category: "recurring_debt" })),
  ];

  const group3_goals: Stage0Item[] = input.goals
    .filter((g) => (g.carriedDeficit || 0) > 0)
    .map((g) => ({ accountId: g.account.id, priority: g.priority, dueDate: g.dueDate, need: g.carriedDeficit || 0, category: "goal" }));

  const group4_reserve: Stage0Item[] =
    input.reserve && (input.reserve.carriedDeficit || 0) > 0
      ? [{ accountId: input.reserve.account.id, priority: "moderate", dueDate: undefined, need: input.reserve.carriedDeficit || 0, category: "reserve" }]
      : [];

  for (const group of [group1_expenses, group2_obligations, group3_goals, group4_reserve]) {
    for (const item of tieBreakSort(group)) {
      const funded = round2(Math.max(0, Math.min(item.need, available)));
      push(
        item.accountId,
        0,
        funded,
        `CARRIED_DEFICIT_${item.category.toUpperCase()}`,
        `عجز مرحّل قدره ${item.need} — أولوية "${item.priority}"${item.dueDate ? ` — استحقاق ${item.dueDate}` : " — بلا تاريخ استحقاق"}. خُصِّص ${funded} (Planned).`
      );
      available = round2(available - funded);
      fundingDetails.push({
        accountId: item.accountId,
        category: item.category,
        priority: item.priority,
        dueDate: item.dueDate,
        carriedDeficit: item.need,
        baseAmount: 0,
        totalNeeded: item.need,
        funded,
        remaining: round2(item.need - funded),
        reasonNotFunded: funded < item.need ? "نفد الدخل المتاح قبل تغطية هذا العجز المرحّل بالكامل ضمن ترتيب المجموعات/الأولوية/تاريخ الاستحقاق." : undefined,
      });
    }
  }

  let stage1Shortfall = false;

  const addOrMergeDetail = (d: AccountFundingDetail) => {
    const existing = fundingDetails.find((x) => x.accountId === d.accountId);
    if (existing) {
      existing.baseAmount = round2(existing.baseAmount + d.baseAmount);
      existing.totalNeeded = round2(existing.carriedDeficit + existing.baseAmount);
      existing.funded = round2(existing.funded + d.funded);
      existing.remaining = round2(existing.totalNeeded - existing.funded);
      if (d.reasonNotFunded) existing.reasonNotFunded = d.reasonNotFunded;
    } else {
      fundingDetails.push(d);
    }
  };

  for (const tier of EXPENSE_TIERS) {
    for (const e of input.expenses.filter((x) => x.priority === tier)) {
      const need = e.monthlyMin;
      const funded = round2(Math.max(0, Math.min(need, available)));
      push(
        e.account.id,
        1,
        funded,
        "EXPENSE_MIN",
        funded >= need ? `تغطية الحد الأدنى الأصلي (${need}) — أولوية "${tier}".` : `تمويل جزئي (${funded} من أصل ${need}) بسبب نقص الدخل — أولوية "${tier}".`
      );
      available = round2(available - funded);
      const remaining = round2(need - funded);
      if (remaining > 0) stage1Shortfall = true;
      addOrMergeDetail({
        accountId: e.account.id, category: "expense", priority: tier, dueDate: e.dueDate,
        carriedDeficit: 0, baseAmount: need, totalNeeded: need, funded, remaining,
        reasonNotFunded: remaining > 0 ? "نفد الدخل المتاح قبل تغطية الحد الأدنى الجديد بالكامل." : undefined,
      });
    }
  }

  const nonDeferrableGoals: Stage0Item[] = input.goals
    .filter((g) => g.isNonDeferrable === true)
    .map((g) => ({ accountId: g.account.id, priority: g.priority, dueDate: g.dueDate, need: g.minAllocation, category: "goal" }));

  for (const item of tieBreakSort(nonDeferrableGoals)) {
    const funded = round2(Math.max(0, Math.min(item.need, available)));
    push(
      item.accountId,
      1,
      funded,
      "NON_DEFERRABLE",
      funded >= item.need
        ? `التزام غير قابل للتأجيل (isNonDeferrable=true) مُموَّل بالكامل (${item.need}) ضمن Stage 1.2، بصرف النظر عن أولويته الأصلية "${item.priority}".`
        : `تمويل جزئي لالتزام غير قابل للتأجيل (${funded} من أصل ${item.need}).`
    );
    available = round2(available - funded);
    const remaining = round2(item.need - funded);
    if (remaining > 0) stage1Shortfall = true;
    addOrMergeDetail({
      accountId: item.accountId, category: item.category, priority: item.priority, dueDate: item.dueDate,
      carriedDeficit: 0, baseAmount: item.need, totalNeeded: item.need, funded, remaining,
      reasonNotFunded: remaining > 0 ? "نفد الدخل المتاح — التزام غير قابل للتأجيل لم يُموَّل بالكامل." : undefined,
    });
  }

  if (stage1Shortfall) {
    const totalRequired = round2(fundingDetails.reduce((s, d) => s + d.totalNeeded, 0));
    const totalFunded = round2(fundingDetails.reduce((s, d) => s + d.funded, 0));
    return {
      periodId: input.periodId,
      incomeAvailable: input.incomeAvailable,
      totalIncomeAvailable,
      allocations,
      insufficientAllocationReport: { totalRequired, totalFunded, totalUnfunded: round2(totalRequired - totalFunded), perAccount: fundingDetails },
      recurringDebtResults: [],
      remainingAfterAllStages: available,
      stoppedAfterStage1: true,
    };
  }

  for (const g of input.goals.filter((x) => x.priority === "critical" && !x.isNonDeferrable)) {
    if (available <= 0) break;
    const surplusReduction = Math.min(g.minAllocation, g.carriedSurplus || 0);
    const effectiveMin = round2(g.minAllocation - surplusReduction);
    const roomToTarget = Math.max(0, round2(g.targetAmount - g.achievedAmount));
    const amt = round2(Math.max(0, Math.min(effectiveMin, roomToTarget, available)));
    push(
      g.account.id, 2, amt, "GOAL_MIN_CRITICAL",
      surplusReduction > 0
        ? `الحد الأدنى (${g.minAllocation}) مخفَّضًا بفائض مرحّل (${surplusReduction}) = ${effectiveMin}.`
        : `الحد الأدنى المخصص لهدف بأولوية "مهم جدًا".`
    );
    available = round2(available - amt);
  }

  for (const tier of EXPENSE_TIERS) {
    if (available <= 0) break;
    const tierExp = input.expenses.filter((e) => e.priority === tier);
    const stage1Amt = (id: string) => allocations.filter((a) => a.accountId === id && a.stage === 1).reduce((s, a) => s + a.amount, 0);
    const items = tierExp.map((e) => ({ accountId: e.account.id, remainingNeed: round2(e.monthlyMax - stage1Amt(e.account.id)) }));
    const { allocated, leftover } = proportionalDistribute(items, available);
    for (const [accId, amt] of Object.entries(allocated)) {
      push(accId, 3, amt, "EXPENSE_RAISE_PROPORTIONAL", `رفع تناسبي نحو الحد الأعلى ضمن أولوية "${tier}" حسب الاحتياج المتبقي.`);
    }
    available = leftover;
  }

  for (const tier of GOAL_TIERS.filter((t) => t !== "critical")) {
    if (available <= 0) break;
    for (const g of input.goals.filter((x) => x.priority === tier && !x.isNonDeferrable)) {
      if (available <= 0) break;
      const surplusReduction = Math.min(g.minAllocation, g.carriedSurplus || 0);
      const effectiveMin = round2(g.minAllocation - surplusReduction);
      const roomToTarget = Math.max(0, round2(g.targetAmount - g.achievedAmount));
      const amt = round2(Math.max(0, Math.min(effectiveMin, roomToTarget, available)));
      push(
        g.account.id, 4, amt, "GOAL_MIN",
        surplusReduction > 0
          ? `الحد الأدنى (${g.minAllocation}) لهدف "${tier}"، مخفَّضًا بفائض مرحّل (${surplusReduction}) = ${effectiveMin}.`
          : `الحد الأدنى المخصص لهدف بأولوية "${tier}".`
      );
      available = round2(available - amt);
    }
  }

  for (const tier of DEBT_TIERS) {
    if (available <= 0) break;
    for (const d of input.oneTimeDebts.filter((x) => x.priority === tier)) {
      if (available <= 0) break;
      if (d.remainingBalance <= 0) continue;
      const amt = round2(Math.min(d.remainingBalance, available));
      push(d.account.id, 5, amt, "ONE_TIME_DEBT_PAYMENT", `سداد دين لمرة واحدة بأولوية "${tier}" حتى الصفر أو نفاد المتاح.`);
      available = round2(available - amt);
    }
  }

  const recurringDebtResults: RecurringDebtResult[] = [];
  const orderedDebts = [...input.recurringDebts].sort((a, b) => (a.account.id < b.account.id ? -1 : a.account.id > b.account.id ? 1 : 0));
  const stateMap: Record<string, RecurringDebtState> = {};
  for (const d of orderedDebts) {
    stateMap[d.account.id] = { accountId: d.account.id, balance: d.currentBalance, minLimit: d.minLimit, maxLimit: d.maxLimit };
  }
  const resultMap: Record<string, RecurringDebtResult> = {};

  for (const d of orderedDebts) {
    const state = stateMap[d.account.id];
    const res = forcedPaydown(state, Math.max(0, available));
    if (res.amountAllocated > 0) {
      push(d.account.id, 6, res.amountAllocated, "RECURRING_DEBT_FORCED", res.reasonText);
      available = round2(available - res.amountAllocated);
    }
    stateMap[d.account.id] = { ...state, balance: res.newBalanceProjected };
    resultMap[d.account.id] = {
      accountId: d.account.id, forcedPaydownAmount: res.amountAllocated,
      reducedMinLimitBy: 0, reducedBalanceBy: 0,
      newMinLimitProposed: state.minLimit, newBalanceProjected: res.newBalanceProjected,
      stageAfter: res.stageAfter, reasonText: res.reasonText,
    };
  }

  for (const d of orderedDebts) {
    if (available <= 0) break;
    const state = stateMap[d.account.id];
    const res = reduceMinThenBalance(state, available);
    const consumed = round2(res.reducedMinLimitBy + res.reducedBalanceBy);
    if (res.reducedMinLimitBy > 0) {
      push(d.account.id, 6, res.reducedMinLimitBy, "RECURRING_DEBT_MIN_REDUCTION",
        `تخفيض مقترح للحد الأدنى (Planned/ApprovedParameterChange فقط — بلا قيد محاسبي): ${state.minLimit}→${res.newMinLimitProposed}. ${res.reasonText}`);
    }
    if (res.reducedBalanceBy > 0) {
      push(d.account.id, 6, res.reducedBalanceBy, "RECURRING_DEBT_BALANCE_REDUCTION",
        `تخفيض مقترح للرصيد (Planned — يحتاج سداد فعلي حقيقي عبر transactions.ts): ${state.balance}→${res.newBalanceProjected}. ${res.reasonText}`);
    }
    available = round2(available - consumed);
    stateMap[d.account.id] = { ...state, balance: res.newBalanceProjected, minLimit: res.newMinLimitProposed };
    resultMap[d.account.id] = {
      ...resultMap[d.account.id],
      reducedMinLimitBy: res.reducedMinLimitBy,
      reducedBalanceBy: res.reducedBalanceBy,
      newMinLimitProposed: res.newMinLimitProposed,
      newBalanceProjected: res.newBalanceProjected,
      stageAfter: res.stageAfter,
      reasonText: res.reasonText,
    };
  }
  for (const d of orderedDebts) recurringDebtResults.push(resultMap[d.account.id]);

  for (const tier of EXPENSE_TIERS) {
    if (available <= 0) break;
    const tierExp = input.expenses.filter((e) => e.priority === tier);
    const allocatedSoFar = (id: string) => allocations.filter((a) => a.accountId === id && (a.stage === 1 || a.stage === 3)).reduce((s, a) => s + a.amount, 0);
    const items = tierExp.map((e) => ({ accountId: e.account.id, remainingNeed: round2(e.monthlyMax - allocatedSoFar(e.account.id)) }));
    const { allocated, leftover } = proportionalDistribute(items, available);
    for (const [accId, amt] of Object.entries(allocated)) {
      push(accId, 7, amt, "EXPENSE_RAISE_FINAL", `رفع نهائي تناسبي نحو الحد الأعلى ضمن أولوية "${tier}" بعد إشباع الدين المستمر.`);
    }
    available = leftover;
  }

  if (available > 0 && input.reserve) {
    push(input.reserve.account.id, 8, available, "SURPLUS_TO_RESERVE", `فائض نهائي بعد كل المراحل يُوجَّه للاحتياطي (Planned فقط حتى الإيداع الفعلي).`);
    available = 0;
  }

  return {
    periodId: input.periodId,
    incomeAvailable: input.incomeAvailable,
    totalIncomeAvailable,
    allocations,
    insufficientAllocationReport: undefined,
    recurringDebtResults,
    remainingAfterAllStages: available,
    stoppedAfterStage1: false,
  };
}
