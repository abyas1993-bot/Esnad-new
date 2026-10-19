// ============================================================
// إسناد — طبقة المستودع (Repository)
// تربط StorageAdapter بمحركات القيود/التوزيع/الإغلاق — لا تُعدِّل أي منها،
// فقط تُحمِّل بياناتها من التخزين وتمررها كما هي، ثم تحفظ النتائج.
// ============================================================
import { Account, JournalEntry, ACCOUNT_GROUPS, groupForCategory, AccountCategory } from "./types";
import { computeBalance } from "./ledger";
import { recordDirectEntry } from "./transactions";
import { runDistribution, DistributionInput, DistributionResult, ExpenseInput, GoalInput, OneTimeDebtInput, RecurringDebtInput, ReserveInput } from "./distribution";
import { closePeriod, applyCarriedForward, PeriodAccountActual, PeriodCloseResult } from "./period";
import { StorageAdapter, FinancialPeriodRecord, AccountPlanningSettings } from "./storage";
import { Currency, AccountCurrencyLink, DEFAULT_CURRENCY, DuplicateCurrencyCodeError, validateCurrencyInput } from "./currency";
import { createBackupFile, restoreBackupData } from "./backup";
import type { BackupAppSettings, BackupFile } from "./backup";

/** يُرمى عند محاولة تعديل أو حذف عملية تخص فترة مالية مغلقة بالفعل (الملاحظة 4). */
export class ClosedPeriodEditError extends Error {
  constructor(periodId: string) {
    super(`لا يمكن تعديل أو حذف عملية ضمن فترة مغلقة (${periodId}) — نتائج إغلاقها محفوظة كسجل دائم لا يُعاد حسابه.`);
    this.name = "ClosedPeriodEditError";
  }
}

/** يُرمى عند الإشارة إلى معرّف عملية غير موجود فعليًا في التخزين (تعديل/حذف). */
export class JournalEntryNotFoundError extends Error {
  constructor(id: string) {
    super(`لا توجد عملية بهذا المعرّف: ${id}`);
    this.name = "JournalEntryNotFoundError";
  }
}

export class Repository {
  constructor(private storage: StorageAdapter) {}

  // ---------------- حسابات ----------------
  async saveAccount(account: Account): Promise<void> {
    await this.storage.saveAccount(account);
  }
  async getAllAccounts(): Promise<Account[]> {
    return this.storage.getAllAccounts();
  }

  // ---------------- أكواد الحسابات الظاهرة (Account Codes) — المرحلة الرابعة ----------------
  /**
   * الكود التالي المتاح لفئة معيَّنة، ضمن نطاق مجموعتها التنظيمية (مجموعة رقمها n → أكواد
   * n001, n002, ...). مجموعة "دائنون" تضم فئتين (recurring_debt وone_time_debt) بتسلسل
   * كود واحد مشترك بينهما عمدًا. لا يُستخدَم أبدًا كمفتاح تخزين — فقط لتوليد الكود التالي.
   */
  async getNextAccountCode(category: AccountCategory): Promise<string> {
    const group = groupForCategory(category);
    if (!group) throw new Error(`لا توجد مجموعة معرَّفة لهذه الفئة: ${category}`);
    const all = await this.storage.getAllAccounts();
    let maxSuffix = 0;
    for (const a of all) {
      if (group.categories.includes(a.category) && a.code) {
        const n = parseInt(a.code, 10);
        const suffix = n - group.n * 1000;
        if (Number.isFinite(suffix) && suffix > maxSuffix) maxSuffix = suffix;
      }
    }
    return String(group.n * 1000 + maxSuffix + 1);
  }

  /**
   * يمنح الحسابات القديمة (المحفوظة قبل هذه المرحلة، بلا `code`) كودًا ثابتًا مناسبًا —
   * مرة واحدة فقط لكل حساب، ثم يبقى ذلك الكود دون تغيير إلى الأبد (خلافًا لأرقام العمليات
   * العرضية في المرحلة 3 — هنا الكود *يُكتَب فعليًا* إلى التخزين عبر `saveAccount` الموجودة
   * أصلًا، لأن المطلوب كود ثابت لا يعاد حسابه في كل قراءة). الترتيب داخل كل مجموعة مستقر
   * (`id` الداخلي تصاعديًا، وهو يتضمَّن وقت الإنشاء الفعلي) فلا يتغيّر الكود بين نداء وآخر.
   * لا يُغيَّر أي حقل آخر على الحساب (id/category/openingBalance/status/meta تبقى كما هي
   * تمامًا)، ولا تُنشَأ أي عملية أو قيد جديد، ولا حاجة لأي Migration على `storage.ts`.
   * آمنة للاستدعاء المتكرر: إن كانت كل الحسابات تملك كودًا بالفعل، لا تفعل شيئًا.
   */
  async ensureAccountCodesAssigned(): Promise<void> {
    const all = await this.storage.getAllAccounts();
    const missing = all.filter((a) => !a.code);
    if (missing.length === 0) return;

    const missingByGroup = new Map<number, Account[]>();
    for (const a of missing) {
      const group = groupForCategory(a.category);
      if (!group) continue; // فئة بلا مجموعة معرَّفة — لا يحدث حاليًا، أمان إضافي فقط
      if (!missingByGroup.has(group.n)) missingByGroup.set(group.n, []);
      missingByGroup.get(group.n)!.push(a);
    }

    for (const [groupN, accountsInGroup] of missingByGroup) {
      const group = ACCOUNT_GROUPS.find((g) => g.n === groupN)!;
      let maxSuffix = 0;
      for (const a of all) {
        if (group.categories.includes(a.category) && a.code) {
          const n = parseInt(a.code, 10);
          const suffix = n - groupN * 1000;
          if (Number.isFinite(suffix) && suffix > maxSuffix) maxSuffix = suffix;
        }
      }
      accountsInGroup.sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
      for (const a of accountsInGroup) {
        maxSuffix++;
        await this.storage.saveAccount({ ...a, code: String(groupN * 1000 + maxSuffix) });
      }
    }
  }

  // ---------------- قيود فعلية (Actual) ----------------
  /**
   * يحفظ قيدًا تم بناؤه مسبقًا عبر دوال transactions.ts (recordIncome/recordExpense/...)
   * — أي قيد أُنشئ عبر تلك الدوال يكون متوازنًا بالفعل (تحقَّق داخل ledger.ts)،
   * وهذه الطبقة تتحقق مرة أخرى (assertBalanced في storage.ts) كطبقة أمان مضاعفة فقط.
   */
  async persistJournalEntry(entry: JournalEntry): Promise<void> {
    await this.storage.appendJournalEntry(entry);
  }

  async getAllJournalEntries(): Promise<JournalEntry[]> {
    return this.storage.getAllJournalEntries();
  }

  /** قيد واحد بمعرّفه، أو null إن لم يوجد — قراءة فقط، بلا أي أثر جانبي. */
  async getJournalEntry(id: string): Promise<JournalEntry | null> {
    const all = await this.storage.getAllJournalEntries();
    return all.find((e) => e.id === id) || null;
  }

  /** يحسب رصيد حساب من كل القيود المخزَّنة فعليًا — يستدعي computeBalance من ledger.ts دون أي تعديل عليها. */
  async getAccountBalance(accountId: string): Promise<number> {
    const account = await this.storage.getAccount(accountId);
    if (!account) throw new Error(`حساب غير موجود: ${accountId}`);
    const entries = await this.storage.getAllJournalEntries();
    return computeBalance(account, entries);
  }

  /**
   * رصيد حساب *كما لو أن قيدًا معيّنًا لم يُسجَّل بعد* — لا تكتب أو تغيّر أي شيء، قراءة فقط.
   * تُستخدَم حصرًا عند تعديل عملية موجودة تتضمَّن تحققًا من كفاية الرصيد (مصروف/سداد دين
   * لمرة واحدة): بدل التحقق من الرصيد الحالي (الذي يتضمَّن أثر النسخة القديمة من نفس
   * العملية التي على وشك الاستبدال)، نتحقق من الرصيد باستثناء تلك النسخة القديمة تحديدًا —
   * تحقق صحيح محاسبيًا للتعديل، مبني بالكامل على computeBalance غير المعدَّلة (ledger.ts).
   */
  async getAccountBalanceExcludingEntry(accountId: string, excludedEntryId: string): Promise<number> {
    const account = await this.storage.getAccount(accountId);
    if (!account) throw new Error(`حساب غير موجود: ${accountId}`);
    const entries = (await this.storage.getAllJournalEntries()).filter((e) => e.id !== excludedEntryId);
    return computeBalance(account, entries);
  }

  /** هل يمكن تعديل/حذف هذه العملية الآن؟ يفحص فقط حالة فترتها (مغلقة أم لا) — قراءة فقط، الملاحظة 4. */
  async isEntryEditable(entryId: string): Promise<boolean> {
    const entry = await this.getJournalEntry(entryId);
    if (!entry) return false;
    const period = await this.storage.getFinancialPeriod(entry.periodId);
    return period?.status !== "closed";
  }

  private async assertEntryIsInOpenPeriod(entry: JournalEntry): Promise<void> {
    const period = await this.storage.getFinancialPeriod(entry.periodId);
    if (period?.status === "closed") throw new ClosedPeriodEditError(entry.periodId);
  }

  /**
   * يعدِّل عملية موجودة مسبقًا (الملاحظة 4). `updatedEntryData` يُبنى من المستدعي عبر نفس
   * دوال transactions.ts المستخدَمة للإنشاء (recordIncome/recordExpense/...، لم تُعدَّل) —
   * هذه الدالة فقط: (1) ترفض كليًا إن كانت فترة العملية *الأصلية* مغلقة، (2) تُثبِّت هوية
   * العملية (id/periodId الأصليين لا يتغيّران أبدًا)، (3) تحافظ حتمًا على رقم العملية —
   * الصريح إن وُجد، وإلا تُجمِّد رقم عرضه *الحالي* (computeDisplayOperationNumbers، غير
   * معدَّلة) بدل تركه عرضيًا، حتى لا يتغيّر ضمنيًا لو تغيّر تاريخ العملية ضمن التعديل نفسه.
   * ثم تستدعي storage.updateJournalEntry (تعيد التحقق من التوازن كطبقة حماية مضاعفة).
   */
  async updateJournalEntryAndPersist(entryId: string, updatedEntryData: JournalEntry): Promise<JournalEntry> {
    const existing = await this.getJournalEntry(entryId);
    if (!existing) throw new JournalEntryNotFoundError(entryId);
    await this.assertEntryIsInOpenPeriod(existing);

    let operationNumber = existing.operationNumber;
    if (!operationNumber) {
      const all = await this.storage.getAllJournalEntries();
      operationNumber = computeDisplayOperationNumbers(all).get(entryId);
    }

    const finalEntry: JournalEntry = { ...updatedEntryData, id: existing.id, periodId: existing.periodId, operationNumber };
    await this.storage.updateJournalEntry(finalEntry);
    return finalEntry;
  }

  /**
   * تعديل قيد مباشر تحديدًا — يُعيد بناء القيد عبر recordDirectEntry (transactions.ts، لم
   * تُعدَّل) بعد التحقق من توافق عملتي الحسابين (نفس تحقق recordDirectEntryAndPersist
   * تمامًا للإنشاء)، ثم يفوّض إلى updateJournalEntryAndPersist العامة أعلاه لتثبيت
   * الهوية/رقم العملية وفحص الفترة المغلقة.
   */
  async updateDirectEntryAndPersist(
    entryId: string,
    debitAccountId: string,
    creditAccountId: string,
    amount: number,
    date: string,
    description?: string
  ): Promise<JournalEntry> {
    const existing = await this.getJournalEntry(entryId);
    if (!existing) throw new JournalEntryNotFoundError(entryId);

    const debitAccount = await this.storage.getAccount(debitAccountId);
    const creditAccount = await this.storage.getAccount(creditAccountId);
    if (!debitAccount) throw new Error(`الحساب المدين غير موجود: ${debitAccountId}`);
    if (!creditAccount) throw new Error(`الحساب الدائن غير موجود: ${creditAccountId}`);

    const debitCurrency = await this.getAccountCurrency(debitAccountId);
    const creditCurrency = await this.getAccountCurrency(creditAccountId);
    if (debitCurrency.code !== creditCurrency.code) {
      throw new Error(
        `لا يمكن تعديل القيد إلى حسابين بعملتين مختلفتين (${debitCurrency.name} و${creditCurrency.name}) — لا يوجد نظام تحويل عملات (FX) في هذه المرحلة.`
      );
    }

    const rebuilt = recordDirectEntry(debitAccount, creditAccount, amount, date, existing.periodId, description);
    return this.updateJournalEntryAndPersist(entryId, rebuilt);
  }

  /** يحذف عملية موجودة — يرفض كليًا إن كانت فترتها مغلقة (الملاحظة 4). لا يعيد حساب أي شيء؛ الأرصدة/التقارير تُعاد حسابها حيًا في القراءة التالية دومًا. */
  async deleteJournalEntryAndPersist(entryId: string): Promise<void> {
    const existing = await this.getJournalEntry(entryId);
    if (!existing) throw new JournalEntryNotFoundError(entryId);
    await this.assertEntryIsInOpenPeriod(existing);
    await this.storage.deleteJournalEntry(entryId);
  }

  // ---------------- الفترات المالية ----------------
  async openPeriod(period: FinancialPeriodRecord): Promise<void> {
    await this.storage.saveFinancialPeriod(period);
  }
  async getPeriod(id: string): Promise<FinancialPeriodRecord | null> {
    return this.storage.getFinancialPeriod(id);
  }
  async updateOpenPeriodDates(
    periodId: string,
    dates: { startDate: string; endDate: string },
  ): Promise<FinancialPeriodRecord> {
    const period = await this.storage.getFinancialPeriod(periodId);
    if (!period) throw new Error(`الفترة ${periodId} غير موجودة — لا يمكن تحديث حدودها.`);
    if (period.status !== "open") throw new Error("لا يمكن تغيير حدود فترة مغلقة.");
    const updated = { ...period, ...dates };
    await this.storage.saveFinancialPeriod(updated);
    return updated;
  }

  // ---------------- إعدادات التخطيط ----------------
  async savePlanningSettings(settings: AccountPlanningSettings): Promise<void> {
    await this.storage.savePlanningSettings(settings);
  }
  async getPlanningSettings(accountId: string): Promise<AccountPlanningSettings | null> {
    return this.storage.getPlanningSettings(accountId);
  }

  /**
   * يبني مدخلات runDistribution الحقيقية بالكامل من: الحسابات المخزَّنة + إعدادات التخطيط
   * المخزَّنة + الأرصدة الفعلية المحسوبة من الدفتر (achievedAmount/remainingBalance/currentBalance).
   * لا قيم افتراضية اعتباطية (لا 0/0/moderate) — أي حساب بلا إعدادات تخطيط محفوظة يُستبعَد
   * من التوزيع صراحة (بدل معاملته كأنه "بلا احتياج" وهميًا)، ويُذكَر ذلك في `skippedAccounts`.
   */
  async buildDistributionInput(periodId: string, incomeAvailable: number): Promise<{ input: DistributionInput; skippedAccounts: string[] }> {
    const accounts = await this.storage.getAllAccounts();
    const allSettings = await this.storage.getAllPlanningSettings();
    const settingsByAccount = new Map(allSettings.map((s) => [s.accountId, s]));
    const skippedAccounts: string[] = [];

    const expenses: Omit<ExpenseInput, "carriedDeficit">[] = [];
    for (const a of accounts.filter((x) => x.category === "expense")) {
      const s = settingsByAccount.get(a.id);
      if (!s || s.kind !== "expense") { skippedAccounts.push(a.id); continue; }
      expenses.push({ account: a, monthlyMin: s.monthlyMin, monthlyMax: s.monthlyMax, priority: s.priority, dueDate: s.dueDate });
    }

    const goals: Omit<GoalInput, "carriedDeficit" | "carriedSurplus">[] = [];
    for (const a of accounts.filter((x) => x.category === "goal")) {
      const s = settingsByAccount.get(a.id);
      if (!s || s.kind !== "goal") { skippedAccounts.push(a.id); continue; }
      const achievedAmount = await this.getAccountBalance(a.id);
      goals.push({
        account: a, minAllocation: s.minAllocation, maxAllocation: s.maxAllocation,
        targetAmount: s.targetAmount, achievedAmount, priority: s.priority, dueDate: s.dueDate,
        isNonDeferrable: s.isNonDeferrable,
      });
    }

    const oneTimeDebts: Omit<OneTimeDebtInput, "carriedDeficit">[] = [];
    for (const a of accounts.filter((x) => x.category === "one_time_debt")) {
      const s = settingsByAccount.get(a.id);
      if (!s || s.kind !== "one_time_debt") { skippedAccounts.push(a.id); continue; }
      const remainingBalance = await this.getAccountBalance(a.id);
      oneTimeDebts.push({ account: a, remainingBalance, priority: s.priority, dueDate: s.dueDate });
    }

    const recurringDebts: Omit<RecurringDebtInput, "carriedDeficit">[] = [];
    for (const a of accounts.filter((x) => x.category === "recurring_debt")) {
      const s = settingsByAccount.get(a.id);
      if (!s || s.kind !== "recurring_debt") { skippedAccounts.push(a.id); continue; }
      const currentBalance = await this.getAccountBalance(a.id);
      recurringDebts.push({ account: a, currentBalance, minLimit: s.minLimit, maxLimit: s.maxLimit, priority: s.priority, dueDate: s.dueDate });
    }

    const reserveAccount = accounts.find((x) => x.category === "reserve");
    const reserve: Omit<ReserveInput, "carriedDeficit"> | undefined = reserveAccount ? { account: reserveAccount } : undefined;

    // البحث عن نتيجة إغلاق الفترة السابقة التي فتحت هذه الفترة، وتطبيق الترحيل فعليًا عبر applyCarriedForward
    // (دالة مختبَرة في period.ts، لم تُعدَّل) — هذا ما يجعل runDistribution يستخدم نتائج الترحيل حقًا، لا شكليًا.
    const carryResult = await this.getCarriedForwardForPeriod(periodId);
    if (carryResult) {
      const merged = applyCarriedForward(carryResult, { incomeAvailable, expenses, goals, oneTimeDebts, recurringDebts, reserve });
      return { input: merged, skippedAccounts };
    }

    return {
      input: { periodId, incomeAvailable, expenses, goals, oneTimeDebts, recurringDebts, reserve },
      skippedAccounts,
    };
  }

  /** يشغّل محرك التوزيع (distribution.ts دون أي تعديل) على مدخلات مُجهَّزة من المستدعي — لا يحفظ شيئًا (Planned لا يُخزَّن كأنه Actual). */
  runDistributionPreview(input: DistributionInput): DistributionResult {
    return runDistribution(input);
  }

  /**
   * يغلق فترة: يستدعي closePeriod من period.ts دون أي تعديل عليها،
   * ثم يحفظ السجل الدائم في التخزين (لا يُحذف ولا يُعاد حسابه لاحقًا)،
   * ثم يفتح الفترة التالية.
   */
  async closePeriodAndPersist(
    closedPeriodId: string,
    nextPeriodId: string,
    accountActuals: PeriodAccountActual[],
    nextPeriodDates: { startDate: string; endDate: string }
  ): Promise<PeriodCloseResult> {
    const currentPeriod = await this.storage.getFinancialPeriod(closedPeriodId);
    if (!currentPeriod) throw new Error(`الفترة ${closedPeriodId} غير موجودة — لا يمكن إغلاقها.`);
    if (currentPeriod.status === "closed") {
      throw new Error(`الفترة ${closedPeriodId} مغلقة بالفعل — لا يجوز إغلاقها مرة أخرى أو إعادة حساب إغلاقها (سجل تاريخي دائم).`);
    }

    const result = closePeriod(closedPeriodId, nextPeriodId, accountActuals);

    await this.storage.savePeriodCloseResult(result);
    await this.storage.saveFinancialPeriod({ ...currentPeriod, status: "closed" });
    await this.storage.saveFinancialPeriod({ id: nextPeriodId, startDate: nextPeriodDates.startDate, endDate: nextPeriodDates.endDate, status: "open" });

    return result;
  }

  async getPeriodCloseResult(closedPeriodId: string): Promise<PeriodCloseResult | null> {
    return this.storage.getPeriodCloseResult(closedPeriodId);
  }

  /** يبحث عن نتيجة إغلاق الفترة السابقة التي فتحت هذه الفترة تحديدًا (result.nextPeriodId === periodId). */
  async getCarriedForwardForPeriod(periodId: string): Promise<PeriodCloseResult | null> {
    const all = await this.storage.getAllPeriodCloseResults();
    return all.find((r) => r.nextPeriodId === periodId) || null;
  }

  // ---------------- العملات (Multi-Currency) ----------------
  async saveCurrency(currency: Currency): Promise<void> {
    await this.storage.saveCurrency(currency);
  }
  async getCurrency(code: string): Promise<Currency | null> {
    return this.storage.getCurrency(code);
  }
  async getAllCurrencies(): Promise<Currency[]> {
    return this.storage.getAllCurrencies();
  }

  /**
   * يضمن وجود عملة افتراضية واحدة على الأقل في التخزين — دون إنشاء أي حساب
   * أو قيد أو بيانات مالية للمستخدم. آمن للاستدعاء المتكرر: لا يفعل شيئًا إن
   * كانت هناك عملة واحدة على الأقل محفوظة بالفعل (لا يكرر الإدراج ولا يكتب فوق
   * عملات أضافها المستخدم).
   */
  async ensureDefaultCurrency(): Promise<void> {
    const existing = await this.storage.getAllCurrencies();
    if (existing.length === 0) {
      await this.storage.saveCurrency(DEFAULT_CURRENCY);
    }
  }

  /**
   * إضافة عملة جديدة من واجهة الإعدادات (الملاحظة 1 §2) — يتحقق من صحة المدخلات
   * (currency.ts) ثم يرفض صراحةً أي كود مكرر قبل الحفظ. لا يمسّ `isDefault` إطلاقًا؛
   * العملة الجديدة تُضاف غير افتراضية ما لم يُستدعَ setDefaultCurrency عليها لاحقًا صراحة.
   */
  async addCurrency(currency: Currency): Promise<void> {
    validateCurrencyInput(currency);
    const normalized: Currency = { ...currency, code: currency.code.trim().toUpperCase(), name: currency.name.trim(), symbol: currency.symbol.trim() };
    const existing = await this.storage.getCurrency(normalized.code);
    if (existing) throw new DuplicateCurrencyCodeError(normalized.code);
    await this.storage.saveCurrency(normalized);
  }

  /**
   * "العملة الافتراضية للتطبيق" (الملاحظة 1 §3) — مستقلة تمامًا عن DEFAULT_CURRENCY الثابتة
   * (SAR، عملة البداية فقط، لا تتغيّر أبدًا وتبقى مرجع العرض للحسابات القديمة بلا رابط صريح
   * — انظر getAccountCurrency أدناه، لم تُغيَّر). تُستخدَم فقط لاقتراح عملة مبدئية عند إنشاء
   * بيانات جديدة تحتاج اختيار عملة. عند عدم وجود أي عملة محدَّدة صراحةً كافتراضية بعد (مثال:
   * تثبيت جديد لم يُستدعَ فيه setDefaultCurrency مطلقًا) تُعاد SAR إن كانت موجودة في القائمة
   * كسلوك بديهي متوافق مع الوضع السابق، ثم أول عملة متاحة، ثم DEFAULT_CURRENCY كحل أخير.
   */
  async getDefaultCurrency(): Promise<Currency> {
    const all = await this.storage.getAllCurrencies();
    const marked = all.find((c) => c.isDefault === true);
    if (marked) return marked;
    const sarFallback = all.find((c) => c.code === DEFAULT_CURRENCY.code);
    if (sarFallback) return sarFallback;
    if (all.length > 0) return all[0];
    return DEFAULT_CURRENCY;
  }

  /**
   * يجعل العملة ذات الكود المحدَّد هي العملة الافتراضية الوحيدة، ويزيل العلامة عن أي عملة
   * أخرى كانت تحملها — يضمن وجود عملة افتراضية واحدة فقط دائمًا (الملاحظة 1 §3). لا يُنشئ
   * أو يحذف أو يُعدِّل أي حساب أو قيد أو ربط عملة بحساب — الحسابات القديمة تبقى تمامًا على
   * ما كانت عليه (انظر التعليق أعلى getAccountCurrency وأسفل هذه الدالة).
   */
  async setDefaultCurrency(code: string): Promise<void> {
    const all = await this.storage.getAllCurrencies();
    const target = all.find((c) => c.code === code);
    if (!target) throw new Error(`لا يمكن تعيين عملة افتراضية غير موجودة: ${code}`);
    for (const c of all) {
      const shouldBeDefault = c.code === code;
      if (Boolean(c.isDefault) !== shouldBeDefault) {
        await this.storage.saveCurrency({ ...c, isDefault: shouldBeDefault });
      }
    }
  }

  async saveAccountCurrencyLink(link: AccountCurrencyLink): Promise<void> {
    await this.storage.saveAccountCurrencyLink(link);
  }
  async getAccountCurrencyLink(accountId: string): Promise<AccountCurrencyLink | null> {
    return this.storage.getAccountCurrencyLink(accountId);
  }
  async getAllAccountCurrencyLinks(): Promise<AccountCurrencyLink[]> {
    return this.storage.getAllAccountCurrencyLinks();
  }

  /** عملة الحساب الفعلية: الرابط الصريح إن وُجد وكانت عملته محفوظة، وإلا العملة الافتراضية (للعرض فقط). */
  async getAccountCurrency(accountId: string): Promise<Currency> {
    const link = await this.storage.getAccountCurrencyLink(accountId);
    if (link) {
      const c = await this.storage.getCurrency(link.currencyCode);
      if (c) return c;
    }
    return DEFAULT_CURRENCY;
  }

  // ---------------- القيد المباشر بين حسابين (Direct Entry) ----------------
  /**
   * يبني قيدًا مباشرًا بين أي حسابين (عبر recordDirectEntry في transactions.ts —
   * لم يُعدَّل، ولا فرض فئة محاسبية على أي طرف) ثم يحفظه بنفس مسار الحفظ المعتاد
   * (storage.appendJournalEntry، الذي يعيد التحقق من التوازن كطبقة حماية مضاعفة).
   * التحقق الوحيد المضاف هنا هو توافق العملة بين الطرفين: بما أنه لا يوجد نظام تحويل
   * عملات (FX) في هذه المرحلة، يُرفض القيد صراحة إن اختلفت عملتا الحسابين — هذا تحقق
   * خاص بالقيد المباشر فقط، ولا يُغيّر أي نوع عملية آخر أو منطقه.
   */
  async recordDirectEntryAndPersist(
    debitAccountId: string,
    creditAccountId: string,
    amount: number,
    date: string,
    periodId: string,
    description?: string,
    operationNumber?: string
  ): Promise<JournalEntry> {
    const debitAccount = await this.storage.getAccount(debitAccountId);
    const creditAccount = await this.storage.getAccount(creditAccountId);
    if (!debitAccount) throw new Error(`الحساب المدين غير موجود: ${debitAccountId}`);
    if (!creditAccount) throw new Error(`الحساب الدائن غير موجود: ${creditAccountId}`);

    const debitCurrency = await this.getAccountCurrency(debitAccountId);
    const creditCurrency = await this.getAccountCurrency(creditAccountId);
    if (debitCurrency.code !== creditCurrency.code) {
      throw new Error(
        `لا يمكن إنشاء قيد مباشر بين حسابين بعملتين مختلفتين (${debitCurrency.name} و${creditCurrency.name}) — لا يوجد نظام تحويل عملات (FX) في هذه المرحلة.`
      );
    }

    const entry = recordDirectEntry(debitAccount, creditAccount, amount, date, periodId, description);
    // operationNumber حقل عرضي بحت (انظر computeDisplayOperationNumbers أدناه) — إضافته هنا
    // بعد recordDirectEntry (لم تُعدَّل) لا تمسّ منطق التوازن أو بناء القيد إطلاقًا.
    if (operationNumber) entry.operationNumber = operationNumber;
    await this.storage.appendJournalEntry(entry);
    return entry;
  }

  // ---------------- رقم العملية الظاهر (Operation Number) — المرحلة الثالثة ----------------
  /**
   * رقم عرضي بحت، منفصل تمامًا عن `id` الداخلي ولا يُخزَّن كمفتاح أساسي في أي مكان.
   * القيود التي أُنشئت بعد هذه المرحلة تحمل `operationNumber` صريحًا محفوظًا. القيود
   * القديمة (بلا هذا الحقل) تُمنَح رقم عرض افتراضيًا هنا فقط — يُحسَب في كل استدعاء
   * بترتيب زمني مستقر (التاريخ ثم `id`) ولا يُكتَب أبدًا إلى التخزين، احترامًا الكامل
   * لقاعدة storage.ts الموثَّقة: "القيود الفعلية تُضاف فقط، لا تُعدَّل أبدًا". هذا يعني
   * أيضًا أنه لا حاجة لأي Migration أو رفع في DB_VERSION لهذه المرحلة.
   */
  async getAllJournalEntriesWithDisplayNumbers(): Promise<Array<JournalEntry & { displayOperationNumber: string }>> {
    const all = await this.storage.getAllJournalEntries();
    const map = computeDisplayOperationNumbers(all);
    return all.map((e) => ({ ...e, displayOperationNumber: map.get(e.id)! }));
  }

  /** الرقم التالي المقترح تلقائيًا عند إنشاء عملية جديدة — قابل للتعديل من المستخدم قبل الحفظ. */
  async getNextOperationNumber(): Promise<string> {
    const all = await this.storage.getAllJournalEntries();
    const map = computeDisplayOperationNumbers(all);
    let max = 0;
    for (const v of map.values()) {
      const n = parseInt(v, 10);
      if (Number.isFinite(n) && n > max) max = n;
    }
    return String(max + 1).padStart(4, "0");
  }

  /** تحقق من عدم تكرار رقم عملية (صريح أو رقم عرض افتراضي لقيد قديم) قبل الحفظ. */
  async isOperationNumberTaken(number: string): Promise<boolean> {
    const all = await this.storage.getAllJournalEntries();
    const map = computeDisplayOperationNumbers(all);
    for (const v of map.values()) {
      if (v === number) return true;
    }
    return false;
  }

  // ---------------- النسخ الاحتياطي والاستعادة (الملاحظة 1، §6-7) ----------------
  /** يبني نسخة احتياطية كاملة من كل مخازن البيانات السبعة كما هي الآن فعليًا في التخزين. */
  async exportBackup(appSettings?: BackupAppSettings): Promise<BackupFile> {
    const [accounts, journalEntries, periods, periodCloseResults, planningSettings, currencies, accountCurrencyLinks] = await Promise.all([
      this.storage.getAllAccounts(),
      this.storage.getAllJournalEntries(),
      this.storage.getAllFinancialPeriods(),
      this.storage.getAllPeriodCloseResults(),
      this.storage.getAllPlanningSettings(),
      this.storage.getAllCurrencies(),
      this.storage.getAllAccountCurrencyLinks(),
    ]);
    return createBackupFile(
      { accounts, journalEntries, periods, periodCloseResults, planningSettings, currencies, accountCurrencyLinks },
      appSettings,
    );
  }

  /**
   * يستعيد نسخة احتياطية من بيانات خام (raw، كما تُقرأ من ملف JSON اختاره المستخدم عبر
   * JSON.parse بلا أي معالجة إضافية). التحقق الكامل (validateBackupFile في backup.ts، دالة
   * نقية لا تلمس التخزين) يحدث أولًا وبالكامل قبل أي استدعاء لـ storage.replaceAllData —
   * فإن رمت أي استثناء (بنية غير صالحة أو schemaVersion غير متوافق)، لا يصل التنفيذ إطلاقًا
   * لسطر الاستبدال، وتبقى البيانات الحالية سليمة تمامًا دون أي لمس (الملاحظة 1 §7-3).
   * الاستبدال نفسه يتم عبر StorageAdapter.replaceAllData بأقصى ذرية ممكنة لكل تنفيذ.
   */
  async restoreBackup(raw: unknown): Promise<BackupFile> {
    return restoreBackupData(raw, (data) => this.storage.replaceAllData(data));
  }
}

/**
 * دالة نقية بلا أي أثر جانبي: تبني خريطة (معرّف القيد ← رقم العرض) لمجموعة قيود.
 * الرقم الصريح المحفوظ في `operationNumber` يُستخدَم كما هو؛ القيود بلا رقم صريح
 * تُرتَّب ترتيبًا زمنيًا مستقرًا (التاريخ تصاعديًا، ثم `id` كفاصل عند تساوي التاريخ)
 * وتُمنَح أرقامًا متتالية تكمل بعد أعلى رقم صريح موجود. مُصدَّرة للاختبار المباشر.
 */
export function computeDisplayOperationNumbers(entries: JournalEntry[]): Map<string, string> {
  let maxExplicit = 0;
  for (const e of entries) {
    if (e.operationNumber) {
      const n = parseInt(e.operationNumber, 10);
      if (Number.isFinite(n) && n > maxExplicit) maxExplicit = n;
    }
  }
  const missing = entries.filter((e) => !e.operationNumber);
  missing.sort((a, b) => {
    if (a.entryDate !== b.entryDate) return a.entryDate < b.entryDate ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const map = new Map<string, string>();
  for (const e of entries) {
    if (e.operationNumber) map.set(e.id, e.operationNumber);
  }
  let next = maxExplicit;
  for (const e of missing) {
    next++;
    map.set(e.id, String(next).padStart(4, "0"));
  }
  return map;
}
