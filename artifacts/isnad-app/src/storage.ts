// ============================================================
// إسناد — طبقة التخزين المحلي الدائم
// لا تُعدِّل أي قاعدة محاسبية — فقط تحفظ/تُحمِّل الكائنات التي تنتجها
// ledger.ts / transactions.ts / distribution.ts / period.ts كما هي.
// ============================================================
import { Account, JournalEntry } from "./types";
import { PeriodCloseResult } from "./period";
import { Currency, AccountCurrencyLink } from "./currency";

export interface FinancialPeriodRecord {
  id: string;
  startDate: string;
  endDate: string;
  status: "open" | "closed";
}

/**
 * لقطة كاملة لكل مخازن البيانات السبعة — تُستخدَم فقط لتصدير/استعادة نسخة احتياطية
 * (الملاحظة 1، §6-7). ليست كيانًا مخزَّنًا بذاته، فقط شكل بيانات منقول بين backup.ts
 * وStorageAdapter.replaceAllData.
 */
export interface FullDataSnapshot {
  accounts: Account[];
  journalEntries: JournalEntry[];
  periods: FinancialPeriodRecord[];
  periodCloseResults: PeriodCloseResult[];
  planningSettings: AccountPlanningSettings[];
  currencies: Currency[];
  accountCurrencyLinks: AccountCurrencyLink[];
}

// ============================================================
// إعدادات التخطيط لكل حساب — كيان منفصل عن Account نفسه (الذي يبقى بلا تغيير في types.ts).
// كل حساب من فئة تخطيطية (مصروف/هدف/دين/احتياطي/دخل) له سجل إعدادات واحد هنا،
// يُستخدَم لبناء مدخلات runDistribution الحقيقية بدل أي قيم افتراضية.
// ============================================================
export interface ExpensePlanningSettings {
  kind: "expense";
  accountId: string;
  monthlyMin: number;
  monthlyMax: number;
  priority: "essential_high" | "essential" | "essential_moderate";
  dueDate?: string;
}
export interface GoalPlanningSettings {
  kind: "goal";
  accountId: string;
  minAllocation: number;
  maxAllocation: number;
  targetAmount: number;
  priority: "critical" | "important" | "moderate";
  dueDate?: string;
  isNonDeferrable?: boolean;
}
export interface RecurringDebtPlanningSettings {
  kind: "recurring_debt";
  accountId: string;
  minLimit: number;
  maxLimit: number;
  dueDate?: string;
  priority?: "urgent_high" | "urgent" | "urgent_moderate";
}
export interface OneTimeDebtPlanningSettings {
  kind: "one_time_debt";
  accountId: string;
  priority: "urgent_high" | "urgent" | "urgent_moderate";
  dueDate?: string;
}
export interface ReservePlanningSettings {
  kind: "reserve";
  accountId: string;
}
export interface IncomePlanningSettings {
  kind: "income_source";
  accountId: string;
  recurrenceType: "fixed" | "intermittent";
  expectedAmount: number;
  dueDate?: string;
}
export interface AssetPlanningSettings {
  kind: "asset";
  accountId: string;
  purchaseValue: number;
  purchaseDate?: string;
  currentValueEstimate?: number;
}
export type AccountPlanningSettings =
  | ExpensePlanningSettings
  | GoalPlanningSettings
  | RecurringDebtPlanningSettings
  | OneTimeDebtPlanningSettings
  | ReservePlanningSettings
  | IncomePlanningSettings
  | AssetPlanningSettings;

/** تحقق برمجي (بالإضافة إلى input type="date" في الواجهة) — يمنع تواريخ وهمية وقيمًا سالبة أو حدودًا غير منطقية. */
export function validatePlanningSettings(s: AccountPlanningSettings): void {
  const isRealDate = (d: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
    const dt = new Date(d + "T00:00:00Z");
    return dt.toISOString().slice(0, 10) === d; // يرفض مثل 2026-02-30 (تتحول تلقائيًا لتاريخ آخر في JS)
  };
  if ("dueDate" in s && s.dueDate) {
    if (!isRealDate(s.dueDate)) throw new Error(`تاريخ استحقاق غير صالح: ${s.dueDate}`);
  }
  if (s.kind === "expense") {
    if (s.monthlyMin < 0 || s.monthlyMax < 0) throw new Error("الحد الأدنى/الأعلى للمصروف لا يجوز أن يكون سالبًا.");
    if (s.monthlyMax < s.monthlyMin) throw new Error("الحد الأعلى للمصروف لا يجوز أن يكون أقل من الحد الأدنى.");
  } else if (s.kind === "goal") {
    if (s.minAllocation < 0 || s.maxAllocation < 0 || s.targetAmount < 0) throw new Error("قيم الهدف لا يجوز أن تكون سالبة.");
    if (s.maxAllocation < s.minAllocation) throw new Error("الحد الأعلى للهدف لا يجوز أن يكون أقل من الحد الأدنى.");
  } else if (s.kind === "recurring_debt") {
    if (s.minLimit < 0 || s.maxLimit < 0) throw new Error("حدود الدين المستمر لا يجوز أن تكون سالبة.");
    if (s.maxLimit < s.minLimit) throw new Error("الحد الأعلى للدين المستمر لا يجوز أن يكون أقل من الحد الأدنى.");
  } else if (s.kind === "income_source") {
    if (s.expectedAmount < 0) throw new Error("مبلغ الدخل المتوقع لا يجوز أن يكون سالبًا.");
  } else if (s.kind === "asset") {
    if (s.purchaseValue < 0) throw new Error("قيمة الشراء لا يجوز أن تكون سالبة.");
    if (s.currentValueEstimate !== undefined && s.currentValueEstimate < 0) throw new Error("القيمة الحالية التقديرية لا يجوز أن تكون سالبة.");
    if ("purchaseDate" in s && s.purchaseDate && !isRealDate(s.purchaseDate)) throw new Error(`تاريخ شراء غير صالح: ${s.purchaseDate}`);
  }
}

/**
 * الواجهة التي يعتمد عليها كل شيء آخر في التطبيق. أي تنفيذ (IndexedDB في المتصفح،
 * أو أي تنفيذ آخر لاحقًا) يجب أن يلتزم بها حرفيًا — هذا ما يسمح باستبدال التخزين
 * دون لمس أي سطر في محرك القيود أو التوزيع أو الإغلاق.
 */
export interface StorageAdapter {
  saveAccount(account: Account): Promise<void>;
  getAccount(id: string): Promise<Account | null>;
  getAllAccounts(): Promise<Account[]>;

  /**
   * appendJournalEntry: تضيف قيدًا **جديدًا** فقط وترفض الكتابة فوق أي `id` موجود بالفعل —
   * لم تتغيّر ولا تتغيّر، ولا تزال المسار الوحيد للإنشاء. التعديل والحذف الفعليان (الملاحظة 4)
   * يمرّان حصرًا عبر updateJournalEntry/deleteJournalEntry أدناه — لا مسار صامت للكتابة فوق
   * قيد أو حذفه عبر appendJournalEntry أو أي دالة أخرى.
   */
  appendJournalEntry(entry: JournalEntry): Promise<void>;
  getAllJournalEntries(): Promise<JournalEntry[]>;
  getJournalEntriesForPeriod(periodId: string): Promise<JournalEntry[]>;

  /**
   * تستبدل قيدًا **موجودًا بالفعل** بمحتوى جديد — عكس appendJournalEntry تمامًا (ترفض إن
   * لم يكن `id` موجودًا أصلًا، بدل أن ترفض إن كان موجودًا). مسار التعديل فقط (الملاحظة 4)؛
   * لا فحص "هل الفترة مغلقة" هنا — تلك مسؤولية طبقة Repository (منطق عمل)، لا التخزين.
   * تعيد التحقق من توازن القيد كطبقة حماية مضاعفة، تمامًا كـappendJournalEntry.
   */
  updateJournalEntry(entry: JournalEntry): Promise<void>;

  /** تحذف قيدًا فعليًا موجودًا بمعرّفه. ترفض إن لم يكن موجودًا. لا فحص فترة مغلقة هنا أيضًا — مسؤولية Repository. */
  deleteJournalEntry(id: string): Promise<void>;

  saveFinancialPeriod(period: FinancialPeriodRecord): Promise<void>;
  getFinancialPeriod(id: string): Promise<FinancialPeriodRecord | null>;
  getAllFinancialPeriods(): Promise<FinancialPeriodRecord[]>;

  /** سجل إغلاق دائم لكل فترة — لا يُحذف ولا يُعاد حسابه لاحقًا (§7 من المواصفة). */
  savePeriodCloseResult(result: PeriodCloseResult): Promise<void>;
  getPeriodCloseResult(closedPeriodId: string): Promise<PeriodCloseResult | null>;
  getAllPeriodCloseResults(): Promise<PeriodCloseResult[]>;

  /** إعدادات التخطيط لكل حساب — منفصلة عن Account نفسه. */
  savePlanningSettings(settings: AccountPlanningSettings): Promise<void>;
  getPlanningSettings(accountId: string): Promise<AccountPlanningSettings | null>;
  getAllPlanningSettings(): Promise<AccountPlanningSettings[]>;

  /** العملات — كيان مرجعي مستقل عن الحسابات والقيود. */
  saveCurrency(currency: Currency): Promise<void>;
  getCurrency(code: string): Promise<Currency | null>;
  getAllCurrencies(): Promise<Currency[]>;

  /** ربط عملة بحساب/وعاء — سجل منفصل، لا يُعدِّل Account نفسه. */
  saveAccountCurrencyLink(link: AccountCurrencyLink): Promise<void>;
  getAccountCurrencyLink(accountId: string): Promise<AccountCurrencyLink | null>;
  getAllAccountCurrencyLinks(): Promise<AccountCurrencyLink[]>;

  /** للاختبار فقط — ليست جزءًا من واجهة الإنتاج المفترضة في الواجهة النهائية. */
  clearAll(): Promise<void>;

  /**
   * يستبدل كل بيانات المخازن السبعة دفعة واحدة (مسار الاستعادة من نسخة احتياطية فقط —
   * الملاحظة 1 §7). كل تنفيذ يضمن أقصى درجة ذرية ممكنة ضمن حدوده: IndexedDB عبر معاملة
   * واحدة تغطي كل المخازن (تنجح كلها معًا أو تتراجع كلها معًا)، وFileStorageAdapter عبر
   * كتابة الدَمب الكامل الجديد بنفس آلية writeDump الذرية (ملف مؤقت ثم استبدال) الموجودة
   * أصلًا. لا يُستدعى هذا أبدًا إلا بعد تحقق كامل من صحة البيانات الواردة (انظر backup.ts) —
   * فشل التحقق يجب ألا يصل لهذه الدالة إطلاقًا، لتبقى البيانات الحالية سليمة عند أي رفض.
   */
  replaceAllData(data: FullDataSnapshot): Promise<void>;
}

export class UnbalancedPersistAttemptError extends Error {
  constructor() {
    super("محاولة حفظ قيد غير متوازن رُفضت على مستوى التخزين أيضًا — طبقة أمان مضاعفة فوق ledger.ts.");
    this.name = "UnbalancedPersistAttemptError";
  }
}

function assertBalanced(entry: JournalEntry): void {
  const debit = entry.lines.filter((l) => l.direction === "DEBIT").reduce((s, l) => s + l.amount, 0);
  const credit = entry.lines.filter((l) => l.direction === "CREDIT").reduce((s, l) => s + l.amount, 0);
  if (Math.round(debit * 100) !== Math.round(credit * 100)) {
    throw new UnbalancedPersistAttemptError();
  }
}

// ============================================================
// تنفيذ 1 — ملف JSON محلي (Node). يُستخدَم هنا للتحقق الفعلي من الاستمرارية
// عبر "إعادة تشغيل" حقيقية (عملية Node جديدة تقرأ نفس الملف من القرص)،
// لأن IndexedDB غير متاحة في بيئة الاختبار هذه (بيئة Node بلا متصفح).
// نفس الواجهة تمامًا — يمكن استبداله بـ IndexedDBStorageAdapter دون أي تغيير
// في repository.ts أو أي محرك آخر.
// ============================================================
// تصريح أدنى لتفادي الحاجة لـ @types/node (لا يوجد اتصال شبكة في بيئة الاختبار هذه)
declare const require: (id: string) => any;
interface NodeFsModule {
  existsSync(path: string): boolean;
  readFileSync(path: string, enc: string): string;
  writeFileSync(path: string, data: string, enc: string): void;
  renameSync(oldPath: string, newPath: string): void;
}

interface FileDump {
  accounts: Record<string, Account>;
  journalEntries: JournalEntry[];
  periods: Record<string, FinancialPeriodRecord>;
  periodCloseResults: Record<string, PeriodCloseResult>;
  planningSettings: Record<string, AccountPlanningSettings>;
  // حقلان جديدان — قد يكونان غائبين تمامًا في ملف دَمب قديم أُنشئ قبل هذه المرحلة؛
  // لهذا كل قراءة/كتابة أدناه تتعامل معهما دفاعيًا (`|| {}`) بدل افتراض وجودهما.
  currencies: Record<string, Currency>;
  accountCurrencyLinks: Record<string, AccountCurrencyLink>;
}

function emptyDump(): FileDump {
  return {
    accounts: {},
    journalEntries: [],
    periods: {},
    periodCloseResults: {},
    planningSettings: {},
    currencies: {},
    accountCurrencyLinks: {},
  };
}

export class FileStorageAdapter implements StorageAdapter {
  constructor(private filePath: string) {}

  private readDump(): FileDump {
    const fs = require("fs") as NodeFsModule;
    if (!fs.existsSync(this.filePath)) return emptyDump();
    const raw = fs.readFileSync(this.filePath, "utf-8");
    if (!raw.trim()) return emptyDump();
    return JSON.parse(raw) as FileDump;
  }

  private writeDump(dump: FileDump): void {
    const fs = require("fs") as NodeFsModule;
    // كتابة ذرية: نكتب لملف مؤقت ثم نستبدل — يمنع فساد الملف لو انقطع التطبيق أثناء الكتابة
    const tmp = this.filePath + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(dump, null, 2), "utf-8");
    fs.renameSync(tmp, this.filePath);
  }

  async saveAccount(account: Account): Promise<void> {
    const dump = this.readDump();
    dump.accounts[account.id] = account;
    this.writeDump(dump);
  }
  async getAccount(id: string): Promise<Account | null> {
    return this.readDump().accounts[id] || null;
  }
  async getAllAccounts(): Promise<Account[]> {
    return Object.values(this.readDump().accounts);
  }

  async appendJournalEntry(entry: JournalEntry): Promise<void> {
    assertBalanced(entry); // طبقة حماية ثانية — حتى لو استُدعيت هذه الدالة مباشرة دون المرور بـ ledger.ts
    const dump = this.readDump();
    if (dump.journalEntries.some((e) => e.id === entry.id)) {
      throw new Error(`قيد بنفس المعرّف (${entry.id}) موجود بالفعل — لا يجوز الكتابة فوق قيد فعلي.`);
    }
    dump.journalEntries.push(entry);
    this.writeDump(dump);
  }
  async getAllJournalEntries(): Promise<JournalEntry[]> {
    return this.readDump().journalEntries;
  }
  async getJournalEntriesForPeriod(periodId: string): Promise<JournalEntry[]> {
    return this.readDump().journalEntries.filter((e) => e.periodId === periodId);
  }

  async updateJournalEntry(entry: JournalEntry): Promise<void> {
    assertBalanced(entry); // طبقة حماية ثانية — كما في appendJournalEntry تمامًا
    const dump = this.readDump();
    const idx = dump.journalEntries.findIndex((e) => e.id === entry.id);
    if (idx === -1) {
      throw new Error(`لا يوجد قيد بهذا المعرّف (${entry.id}) لتعديله.`);
    }
    dump.journalEntries[idx] = entry;
    this.writeDump(dump);
  }

  async deleteJournalEntry(id: string): Promise<void> {
    const dump = this.readDump();
    const idx = dump.journalEntries.findIndex((e) => e.id === id);
    if (idx === -1) {
      throw new Error(`لا يوجد قيد بهذا المعرّف (${id}) لحذفه.`);
    }
    dump.journalEntries.splice(idx, 1);
    this.writeDump(dump);
  }

  async saveFinancialPeriod(period: FinancialPeriodRecord): Promise<void> {
    const dump = this.readDump();
    dump.periods[period.id] = period;
    this.writeDump(dump);
  }
  async getFinancialPeriod(id: string): Promise<FinancialPeriodRecord | null> {
    return this.readDump().periods[id] || null;
  }
  async getAllFinancialPeriods(): Promise<FinancialPeriodRecord[]> {
    return Object.values(this.readDump().periods);
  }

  async savePeriodCloseResult(result: PeriodCloseResult): Promise<void> {
    const dump = this.readDump();
    dump.periodCloseResults[result.closedPeriodId] = result;
    this.writeDump(dump);
  }
  async getPeriodCloseResult(closedPeriodId: string): Promise<PeriodCloseResult | null> {
    return this.readDump().periodCloseResults[closedPeriodId] || null;
  }
  async getAllPeriodCloseResults(): Promise<PeriodCloseResult[]> {
    return Object.values(this.readDump().periodCloseResults);
  }

  async savePlanningSettings(settings: AccountPlanningSettings): Promise<void> {
    const dump = this.readDump();
    if (!dump.planningSettings) dump.planningSettings = {};
    dump.planningSettings[settings.accountId] = settings;
    this.writeDump(dump);
  }
  async getPlanningSettings(accountId: string): Promise<AccountPlanningSettings | null> {
    return this.readDump().planningSettings?.[accountId] || null;
  }
  async getAllPlanningSettings(): Promise<AccountPlanningSettings[]> {
    return Object.values(this.readDump().planningSettings || {});
  }

  async saveCurrency(currency: Currency): Promise<void> {
    const dump = this.readDump();
    if (!dump.currencies) dump.currencies = {};
    dump.currencies[currency.code] = currency;
    this.writeDump(dump);
  }
  async getCurrency(code: string): Promise<Currency | null> {
    return this.readDump().currencies?.[code] || null;
  }
  async getAllCurrencies(): Promise<Currency[]> {
    return Object.values(this.readDump().currencies || {});
  }

  async saveAccountCurrencyLink(link: AccountCurrencyLink): Promise<void> {
    const dump = this.readDump();
    if (!dump.accountCurrencyLinks) dump.accountCurrencyLinks = {};
    dump.accountCurrencyLinks[link.accountId] = link;
    this.writeDump(dump);
  }
  async getAccountCurrencyLink(accountId: string): Promise<AccountCurrencyLink | null> {
    return this.readDump().accountCurrencyLinks?.[accountId] || null;
  }
  async getAllAccountCurrencyLinks(): Promise<AccountCurrencyLink[]> {
    return Object.values(this.readDump().accountCurrencyLinks || {});
  }

  async clearAll(): Promise<void> {
    this.writeDump(emptyDump());
  }

  /**
   * استبدال ذرّي كامل عبر writeDump الموجودة أصلًا (كتابة لملف مؤقت ثم renameSync) —
   * لا "clear ثم insert insert insert" منفصلة، بل بناء الدَمب الجديد بالكامل في الذاكرة
   * أولًا ثم كتابته دفعة واحدة. فشل أي شيء قبل استدعاء writeDump (مثال: بيانات غير متوقَّعة)
   * يترك الملف الحالي على القرص كما هو تمامًا دون أي لمس.
   */
  async replaceAllData(data: FullDataSnapshot): Promise<void> {
    const dump: FileDump = {
      accounts: Object.fromEntries(data.accounts.map((a) => [a.id, a])),
      journalEntries: [...data.journalEntries],
      periods: Object.fromEntries(data.periods.map((p) => [p.id, p])),
      periodCloseResults: Object.fromEntries(data.periodCloseResults.map((r) => [r.closedPeriodId, r])),
      planningSettings: Object.fromEntries(data.planningSettings.map((s) => [s.accountId, s])),
      currencies: Object.fromEntries(data.currencies.map((c) => [c.code, c])),
      accountCurrencyLinks: Object.fromEntries(data.accountCurrencyLinks.map((l) => [l.accountId, l])),
    };
    this.writeDump(dump);
  }
}

// ============================================================
// تنفيذ 2 — IndexedDB (الهدف النهائي: PWA/متصفح الأندرويد).
// مكتوب وفق واجهة IndexedDB القياسية بالكامل. غير قابل للتنفيذ في بيئة الاختبار
// الحالية (لا يوجد كائن `indexedDB` عام في Node بلا متصفح) — يحتاج اختبارًا
// فعليًا داخل متصفح حقيقي عند بناء الواجهة. أُدرجه الآن مكتملًا حتى لا نبنيه
// على عجل لاحقًا، وحتى تراجعي بنيته إن رغبتِ قبل الوصول لتلك المرحلة.
// ============================================================
const DB_NAME = "isnad_db";
// رُفعت من 2 إلى 3 لإضافة العملات فقط. onupgradeneeded أدناه يتحقق من كل مخزن
// بـ`contains` قبل إنشائه — المخازن القديمة (accounts/journalEntries/...) وبياناتها
// تبقى كما هي تمامًا؛ IndexedDB لا تحذف مخازن أو بيانات موجودة عند رفع رقم النسخة،
// وهذا الكود لا يستدعي db.deleteObjectStore على أي مخزن قديم إطلاقًا.
const DB_VERSION = 3;
const STORES = [
  "accounts",
  "journalEntries",
  "periods",
  "periodCloseResults",
  "planningSettings",
  "currencies",
  "accountCurrencyLinks",
] as const;

export class IndexedDBStorageAdapter implements StorageAdapter {
  private dbPromise: Promise<IDBDatabase>;

  constructor() {
    this.dbPromise = new Promise((resolve, reject) => {
      // @ts-ignore — indexedDB متاحة فقط في بيئة متصفح حقيقية
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        // كل سطر هنا إضافي فقط (create إذا لم يكن موجودًا) — لا يوجد أي حذف أو
        // إعادة إنشاء لمخزن قائم، لذا بيانات DB_VERSION 2 (accounts/journalEntries/
        // periods/periodCloseResults/planningSettings) تبقى محفوظة كاملة عبر الترقية.
        if (!db.objectStoreNames.contains("accounts")) db.createObjectStore("accounts", { keyPath: "id" });
        if (!db.objectStoreNames.contains("journalEntries")) db.createObjectStore("journalEntries", { keyPath: "id" });
        if (!db.objectStoreNames.contains("periods")) db.createObjectStore("periods", { keyPath: "id" });
        if (!db.objectStoreNames.contains("periodCloseResults")) db.createObjectStore("periodCloseResults", { keyPath: "closedPeriodId" });
        if (!db.objectStoreNames.contains("planningSettings")) db.createObjectStore("planningSettings", { keyPath: "accountId" });
        // مخزنان جديدان لهذه المرحلة فقط (نظام العملات) — لا يمسّان أي مخزن قديم.
        if (!db.objectStoreNames.contains("currencies")) db.createObjectStore("currencies", { keyPath: "code" });
        if (!db.objectStoreNames.contains("accountCurrencyLinks")) db.createObjectStore("accountCurrencyLinks", { keyPath: "accountId" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  private async withStore<T>(storeName: (typeof STORES)[number], mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest): Promise<T> {
    const db = await this.dbPromise;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, mode);
      const store = tx.objectStore(storeName);
      const req = fn(store);
      req.onsuccess = () => resolve(req.result as T);
      req.onerror = () => reject(req.error);
    });
  }

  async saveAccount(account: Account): Promise<void> {
    await this.withStore("accounts", "readwrite", (s) => s.put(account));
  }
  async getAccount(id: string): Promise<Account | null> {
    const r = await this.withStore<Account | undefined>("accounts", "readonly", (s) => s.get(id));
    return r || null;
  }
  async getAllAccounts(): Promise<Account[]> {
    return this.withStore<Account[]>("accounts", "readonly", (s) => s.getAll());
  }

  async appendJournalEntry(entry: JournalEntry): Promise<void> {
    assertBalanced(entry);
    const db = await this.dbPromise;
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("journalEntries", "readwrite");
      const store = tx.objectStore("journalEntries");
      const getReq = store.get(entry.id);
      getReq.onsuccess = () => {
        if (getReq.result) {
          reject(new Error(`قيد بنفس المعرّف (${entry.id}) موجود بالفعل — لا يجوز الكتابة فوق قيد فعلي.`));
          return;
        }
        const addReq = store.add(entry);
        addReq.onsuccess = () => resolve();
        addReq.onerror = () => reject(addReq.error);
      };
      getReq.onerror = () => reject(getReq.error);
    });
  }
  async getAllJournalEntries(): Promise<JournalEntry[]> {
    return this.withStore<JournalEntry[]>("journalEntries", "readonly", (s) => s.getAll());
  }
  async getJournalEntriesForPeriod(periodId: string): Promise<JournalEntry[]> {
    const all = await this.getAllJournalEntries();
    return all.filter((e) => e.periodId === periodId);
  }

  async updateJournalEntry(entry: JournalEntry): Promise<void> {
    assertBalanced(entry); // طبقة حماية ثانية — كما في appendJournalEntry تمامًا
    const db = await this.dbPromise;
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("journalEntries", "readwrite");
      const store = tx.objectStore("journalEntries");
      const getReq = store.get(entry.id);
      getReq.onsuccess = () => {
        if (!getReq.result) {
          reject(new Error(`لا يوجد قيد بهذا المعرّف (${entry.id}) لتعديله.`));
          return;
        }
        const putReq = store.put(entry);
        putReq.onsuccess = () => resolve();
        putReq.onerror = () => reject(putReq.error);
      };
      getReq.onerror = () => reject(getReq.error);
    });
  }

  async deleteJournalEntry(id: string): Promise<void> {
    const db = await this.dbPromise;
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("journalEntries", "readwrite");
      const store = tx.objectStore("journalEntries");
      const getReq = store.get(id);
      getReq.onsuccess = () => {
        if (!getReq.result) {
          reject(new Error(`لا يوجد قيد بهذا المعرّف (${id}) لحذفه.`));
          return;
        }
        const delReq = store.delete(id);
        delReq.onsuccess = () => resolve();
        delReq.onerror = () => reject(delReq.error);
      };
      getReq.onerror = () => reject(getReq.error);
    });
  }

  async saveFinancialPeriod(period: FinancialPeriodRecord): Promise<void> {
    await this.withStore("periods", "readwrite", (s) => s.put(period));
  }
  async getFinancialPeriod(id: string): Promise<FinancialPeriodRecord | null> {
    const r = await this.withStore<FinancialPeriodRecord | undefined>("periods", "readonly", (s) => s.get(id));
    return r || null;
  }
  async getAllFinancialPeriods(): Promise<FinancialPeriodRecord[]> {
    return this.withStore<FinancialPeriodRecord[]>("periods", "readonly", (s) => s.getAll());
  }

  async savePeriodCloseResult(result: PeriodCloseResult): Promise<void> {
    await this.withStore("periodCloseResults", "readwrite", (s) => s.put(result));
  }
  async getPeriodCloseResult(closedPeriodId: string): Promise<PeriodCloseResult | null> {
    const r = await this.withStore<PeriodCloseResult | undefined>("periodCloseResults", "readonly", (s) => s.get(closedPeriodId));
    return r || null;
  }
  async getAllPeriodCloseResults(): Promise<PeriodCloseResult[]> {
    return this.withStore<PeriodCloseResult[]>("periodCloseResults", "readonly", (s) => s.getAll());
  }

  async savePlanningSettings(settings: AccountPlanningSettings): Promise<void> {
    await this.withStore("planningSettings", "readwrite", (s) => s.put(settings));
  }
  async getPlanningSettings(accountId: string): Promise<AccountPlanningSettings | null> {
    const r = await this.withStore<AccountPlanningSettings | undefined>("planningSettings", "readonly", (s) => s.get(accountId));
    return r || null;
  }
  async getAllPlanningSettings(): Promise<AccountPlanningSettings[]> {
    return this.withStore<AccountPlanningSettings[]>("planningSettings", "readonly", (s) => s.getAll());
  }

  async saveCurrency(currency: Currency): Promise<void> {
    await this.withStore("currencies", "readwrite", (s) => s.put(currency));
  }
  async getCurrency(code: string): Promise<Currency | null> {
    const r = await this.withStore<Currency | undefined>("currencies", "readonly", (s) => s.get(code));
    return r || null;
  }
  async getAllCurrencies(): Promise<Currency[]> {
    return this.withStore<Currency[]>("currencies", "readonly", (s) => s.getAll());
  }

  async saveAccountCurrencyLink(link: AccountCurrencyLink): Promise<void> {
    await this.withStore("accountCurrencyLinks", "readwrite", (s) => s.put(link));
  }
  async getAccountCurrencyLink(accountId: string): Promise<AccountCurrencyLink | null> {
    const r = await this.withStore<AccountCurrencyLink | undefined>("accountCurrencyLinks", "readonly", (s) => s.get(accountId));
    return r || null;
  }
  async getAllAccountCurrencyLinks(): Promise<AccountCurrencyLink[]> {
    return this.withStore<AccountCurrencyLink[]>("accountCurrencyLinks", "readonly", (s) => s.getAll());
  }

  async clearAll(): Promise<void> {
    const db = await this.dbPromise;
    for (const storeName of STORES) {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(storeName, "readwrite");
        const req = tx.objectStore(storeName).clear();
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      });
    }
  }

  /**
   * استبدال ذرّي حقيقي: معاملة IndexedDB واحدة تغطي كل المخازن السبعة معًا (بخلاف clearAll
   * أعلاه التي تفتح معاملة منفصلة لكل مخزن). وفق مواصفة IndexedDB، معاملة متعددة المخازن
   * تلتزم (commit) أو تتراجع (abort) ككتلة واحدة — فإما أن تُستبدَل كل المخازن بنجاح، أو
   * لا يتغيَّر أي منها إطلاقًا عند أي فشل في المنتصف (خطأ quota، تعارض إصدار، إلخ)؛ هذا هو
   * المقصود بـ"لا تستخدم clearAll كحل تسلسلي" في مواصفة الاستعادة (الملاحظة 1 §7).
   */
  async replaceAllData(data: FullDataSnapshot): Promise<void> {
    const db = await this.dbPromise;
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORES, "readwrite");
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error("فشلت معاملة الاستعادة — تم التراجع عن كل التغييرات (لا شيء تغيَّر)."));

      const byStore: Record<(typeof STORES)[number], unknown[]> = {
        accounts: data.accounts,
        journalEntries: data.journalEntries,
        periods: data.periods,
        periodCloseResults: data.periodCloseResults,
        planningSettings: data.planningSettings,
        currencies: data.currencies,
        accountCurrencyLinks: data.accountCurrencyLinks,
      };
      for (const storeName of STORES) {
        const store = tx.objectStore(storeName);
        store.clear();
        for (const item of byStore[storeName]) store.put(item);
      }
    });
  }
}
