// ============================================================
// إسناد — طبقة التقارير
// تقرأ فقط من computeBalance/journal entries الموجودة — لا منطق محاسبي جديد هنا إطلاقًا.
// مصمَّمة لتوسّع مستقبلي: كل نوع تقرير هو دالة بناء مستقلة تعيد ReportDocument موحَّد،
// قابل للعرض/الطباعة بأي شكل (HTML الآن، PDF/تصدير لاحقًا) دون تغيير هذه الطبقة أو النواة.
// ============================================================
import type { Account, JournalEntry, JournalLine } from "./types";
import type { Currency } from "./currency";

/** بنية موحَّدة لأي تقرير — كل الأنواع المستقبلية (مصروفات/أوعية/ديون/أهداف/إغلاق/خطة) تنتج نفس الشكل. */
export interface ReportDocument {
  kind: "account_ledger" | "transaction_log" | "expense_summary" | "debts_summary" | "goals_summary" | "period_closing" | "distribution_plan";
  title: string;
  periodLabel: string;
  generatedAt: string;
  columns: string[];
  rows: string[][];
  totals?: Record<string, string>;
}

export interface AccountLedgerReportInput {
  account: Account;
  allAccounts: Account[]; // لتسمية "الحساب المقابل" لكل سطر قيد
  entries: JournalEntry[]; // كل القيود (سيُفلتَر داخليًا لهذا الحساب فقط)
  fromDate?: string; // اختياري — فلترة الفترة
  toDate?: string;
  /** اختياري — لعرض رمز/اسم العملة بجانب القيم المالية في المجاميع. لا يُستخدَم لأي تحويل عملات. */
  currency?: Currency;
}

// تسميات عربية لأنواع العملية — لعرض تقرير كشف الحساب فقط. نسخة محلية مستقلة عن أي تسمية
// مشابهة في web/app.ts (TX_TYPE_LABELS) لتفادي أي استيراد دائري بين طبقة العرض وطبقة التقارير؛
// reports.ts مصمَّمة لتبقى مكتفية ذاتيًا (انظر تعليق أعلى الملف).
const TRANSACTION_TYPE_LABELS_AR: Record<string, string> = {
  income: "دخل",
  expense: "مصروف",
  transfer: "تحويل بين أوعية",
  debt_payment: "سداد دين",
  debt_creation: "إنشاء دين",
  goal_funding: "تمويل هدف",
  reserve_withdraw: "سحب من احتياطي",
  reserve_deposit: "إيداع في احتياطي",
  asset_purchase: "شراء أصل",
  asset_sale: "بيع أصل",
  correction: "تصحيح",
  direct_entry: "قيد مباشر",
};

/**
 * تقرير حساب واحد — كشف حساب احترافي مختصر مُعَد للطباعة والأرشفة (الملاحظة 3): ستة أعمدة
 * فقط بالضبط — التاريخ | رقم العملية | البيان | دائن | مدين | الرصيد. لا معرّف داخلي، ولا
 * عمود "نوع العملية" مستقل، ولا "الحساب المقابل" كعمود مستقل — اسم الحساب المقابل يُطوى داخل
 * عمود "البيان" نفسه عند الحاجة (مثال: "دخل — الراتب"). الحسابات نفسها (الرصيد المتحرك،
 * الرصيد الافتتاحي، الإجماليات) لم تتغيّر بحرف واحد عن التصميم الأصلي — التغيير عرضي بحت.
 *
 * الرصيد الافتتاحي: عند تمرير fromDate، لا يُستخدَم account.openingBalance وحده — بل
 * openingBalance + أثر كل القيود السابقة لـfromDate (نفس منطق الطبيعة أدناه)، ويُعرَض هذا
 * كـ"الرصيد الافتتاحي" في totals (وليس كسطر ضمن rows في هذه الحالة، حتى لا يتغيّر rows.length
 * لسيناريو الاختبار الذي يفترض بلا fromDate أي سطر افتتاحي إضافي). عند عدم تمرير fromDate،
 * سطر "رصيد افتتاحي" يُضاف ضمن rows إن كان غير صفري، كما كان دائمًا.
 */
export function buildAccountLedgerReport(input: AccountLedgerReportInput): ReportDocument {
  const { account, allAccounts, entries, fromDate, toDate, currency } = input;
  const accName = (id: string) => allAccounts.find((a) => a.id === id)?.name || id;
  const fmtN = (n: number) => (currency ? `${n.toLocaleString("en-US")} ${currency.symbol}` : n.toLocaleString("en-US"));

  const relevant = entries
    .filter((e) => e.lines.some((l) => l.accountId === account.id))
    .filter((e) => (!fromDate || e.entryDate >= fromDate) && (!toDate || e.entryDate <= toDate))
    .sort((a, b) => (a.entryDate < b.entryDate ? -1 : a.entryDate > b.entryDate ? 1 : 0));

  // نفس اتجاه "الطبيعة" المستخدَم في ledger.ts (لا نستورد الثابت الداخلي، لكن القاعدة نفسها: DEBIT للأصول والمصروفات)
  const debitNormalCategories = ["pot", "asset", "goal", "reserve", "expense"];
  const isDebitNormal = debitNormalCategories.includes(account.category);
  const signedAmountFor = (line: JournalLine) =>
    isDebitNormal ? (line.direction === "DEBIT" ? line.amount : -line.amount) : (line.direction === "CREDIT" ? line.amount : -line.amount);

  // الرصيد الافتتاحي *للفترة*: openingBalance + أثر كل القيود لهذا الحساب السابقة لـfromDate
  // (لا شيء منها إن لم يُحدَّد fromDate — فيبقى مطابقًا لـaccount.openingBalance كما كان دائمًا).
  let periodOpeningBalance = account.openingBalance;
  if (fromDate) {
    const priorEntries = entries.filter((e) => e.lines.some((l) => l.accountId === account.id) && e.entryDate < fromDate);
    for (const e of priorEntries) {
      for (const line of e.lines.filter((l) => l.accountId === account.id)) {
        periodOpeningBalance += signedAmountFor(line);
      }
    }
  }

  let running = periodOpeningBalance;
  const rows: string[][] = [];
  // سطر "رصيد افتتاحي" ضمن rows فقط في حالة عدم وجود fromDate — يطابق السلوك الأصلي تمامًا
  // (rows.length لا يتغيّر لسيناريو الاختبار القديم الذي يستخدم fromDate).
  if (!fromDate && account.openingBalance !== 0) {
    rows.push(["—", "—", "رصيد افتتاحي", "—", "—", fmtN(running)]);
  }
  let totalDebit = 0;
  let totalCredit = 0;
  for (const e of relevant) {
    const myLines = e.lines.filter((l) => l.accountId === account.id);
    for (const line of myLines) {
      const counterpart = e.lines.find((l) => l.accountId !== account.id);
      const signedAmount = signedAmountFor(line);
      running += signedAmount;
      if (line.direction === "DEBIT") totalDebit += line.amount;
      else totalCredit += line.amount;

      // البيان: الوصف الفعلي إن وُجد، وإلا نوع العملية بالعربية كنص بديل مفهوم — ثم اسم
      // الحساب المقابل مطويًا معه (وليس كعمود مستقل)، تمامًا كما طُلب في الملاحظة 3.
      const baseText = e.description || TRANSACTION_TYPE_LABELS_AR[e.transactionType] || e.transactionType;
      const statement = counterpart ? `${baseText} — ${accName(counterpart.accountId)}` : baseText;

      rows.push([
        e.entryDate,
        e.operationNumber || "—",
        statement,
        line.direction === "CREDIT" ? fmtN(line.amount) : "—",
        line.direction === "DEBIT" ? fmtN(line.amount) : "—",
        fmtN(running),
      ]);
    }
  }

  return {
    kind: "account_ledger",
    title: `تقرير حساب: ${account.name}${account.code ? ` (${account.code})` : ""}`,
    periodLabel: fromDate || toDate ? `من ${fromDate || "البداية"} إلى ${toDate || "الآن"}` : "كل الفترة",
    generatedAt: new Date().toISOString().slice(0, 19).replace("T", " "),
    columns: ["التاريخ", "رقم العملية", "البيان", "دائن", "مدين", "الرصيد"],
    rows,
    totals: {
      "الرصيد الافتتاحي": fmtN(periodOpeningBalance),
      "إجمالي مدين": currency ? fmtN(totalDebit) : totalDebit.toLocaleString("en-US"),
      "إجمالي دائن": currency ? fmtN(totalCredit) : totalCredit.toLocaleString("en-US"),
      "الرصيد النهائي": fmtN(running),
      ...(currency ? { "العملة": `${currency.name} (${currency.symbol})` } : {}),
    },
  };
}

/** سطر سجل عمليات جاهز للعرض/الطباعة — نفس JournalEntry الفعلي، مع رقم العرض الجاهز أصلًا
 * من Repository.getAllJournalEntriesWithDisplayNumbers (لا حساب جديد لأرقام العمليات هنا). */
export interface TransactionLogEntry extends JournalEntry {
  displayOperationNumber: string;
}

export interface TransactionLogReportInput {
  entries: TransactionLogEntry[]; // من repo.getAllJournalEntriesWithDisplayNumbers() مباشرة
  accounts: Account[]; // لتسمية الحسابات المدينة/الدائنة
  /** عملة كل حساب (accountId → Currency)، محسوبة مسبقًا عبر repo.getAccountCurrency لكل حساب. */
  accountCurrencies: Map<string, Currency>;
  fromDate?: string;
  toDate?: string;
  transactionType?: string; // فلتر اختياري — قيمة من TransactionType، أو undefined لعرض الكل
  accountId?: string; // فلتر اختياري — يعرض فقط قيودًا يظهر فيها هذا الحساب (مدينًا أو دائنًا)
  currencyCode?: string; // فلتر اختياري — يعرض فقط صفوفًا بعملة هذا الكود (انظر rowCurrency أدناه)
}

export interface TransactionLogReportResult {
  document: ReportDocument;
  /** بنفس ترتيب document.rows تمامًا — لفتح تفاصيل العملية عند الضغط على صف، دون تضمين
   * أي معرّف داخلي داخل الجدول المطبوع نفسه (الطباعة تعرض فقط أعمدة document.columns). */
  entryIds: string[];
}

/**
 * سجل عمليات — نسخة احترافية مختصرة مُعَدة للطباعة (الملاحظة 3): سبعة أعمدة فقط —
 * رقم العملية | التاريخ | البيان | الحساب المدين | الحساب الدائن | المبلغ | العملة. عمود
 * "نوع العملية" السابق طُوي داخل "البيان" (بادئة قصيرة قبل الوصف الفعلي إن وُجد) بدل عمود
 * مستقل، بنفس أسلوب كشف الحساب — عرض فقط، لا معرّفات داخلية ولا حقول تقنية زائدة. عرض
 * فقط، بلا أي تعديل أو حذف. "عملة الصف" تُشتَق من عملة حساب "الوعاء" (pot) الطرف في القيد
 * إن وُجد (هو الطرف الذي يحمل العملة فعليًا في معظم الحالات: دخل/مصروف/تحويل/سداد دين)،
 * وإلا من السطر المدين كافتراضي معقول (مثال: قيد مباشر بين حسابين لا وعاء بينهما). لا جمع
 * أبدًا بين عملتين مختلفتين في رقم واحد — الإجماليات مُجمَّعة بمفتاح منفصل لكل عملة فعليًا
 * موجودة في الصفوف المعروضة.
 */
export function buildTransactionLogReport(input: TransactionLogReportInput): TransactionLogReportResult {
  const { entries, accounts, accountCurrencies, fromDate, toDate, transactionType, accountId, currencyCode } = input;
  const accName = (id: string) => accounts.find((a) => a.id === id)?.name || id;
  const rowCurrency = (e: JournalEntry): Currency | undefined => {
    // نفضِّل حساب "الوعاء" (pot) إن وُجد ضمن طرفَي القيد كمرجع للعملة — لأنه الطرف الذي
    // يحمل العملة فعليًا في أغلب أنواع العمليات (دخل/مصروف/تحويل/سداد دين)، بينما الطرف
    // الآخر غالبًا تصنيف (فئة مصروف/مصدر دخل/دين) لا يُربَط بعملة عادةً. في حال عدم وجود
    // أي وعاء ضمن الطرفين (مثال: قيد مباشر بين دينين)، نعود للسطر المدين كافتراضي معقول.
    const potLine = e.lines.find((l) => accounts.find((a) => a.id === l.accountId)?.category === "pot");
    const refLine = potLine || e.lines.find((l) => l.direction === "DEBIT") || e.lines[0];
    return refLine ? accountCurrencies.get(refLine.accountId) : undefined;
  };

  let filtered = entries
    .filter((e) => !fromDate || e.entryDate >= fromDate)
    .filter((e) => !toDate || e.entryDate <= toDate)
    .filter((e) => !transactionType || e.transactionType === transactionType)
    .filter((e) => !accountId || e.lines.some((l) => l.accountId === accountId));
  if (currencyCode) {
    filtered = filtered.filter((e) => rowCurrency(e)?.code === currencyCode);
  }

  // الأحدث أولًا: بالتاريخ تنازليًا، وعند التساوي id تنازليًا (يتضمّن وقت الإنشاء الفعلي —
  // نفس منطق الترتيب المستقر المستخدَم في renderTransactionList بالمرحلة 3 بالضبط).
  const sorted = [...filtered].sort((a, b) => {
    if (a.entryDate !== b.entryDate) return a.entryDate < b.entryDate ? 1 : -1;
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  });

  const rows: string[][] = [];
  const entryIds: string[] = [];
  const totalsByCurrency = new Map<string, number>();

  for (const e of sorted) {
    const debitAccounts = e.lines.filter((l) => l.direction === "DEBIT").map((l) => accName(l.accountId)).join("، ") || "—";
    const creditAccounts = e.lines.filter((l) => l.direction === "CREDIT").map((l) => accName(l.accountId)).join("، ") || "—";
    const amount = e.lines.filter((l) => l.direction === "DEBIT").reduce((s, l) => s + l.amount, 0);
    const cur = rowCurrency(e);
    const curLabel = cur ? `${cur.name} (${cur.symbol})` : "—";
    const typeLabel = TRANSACTION_TYPE_LABELS_AR[e.transactionType] || e.transactionType;
    const statement = e.description ? `${typeLabel} — ${e.description}` : typeLabel;

    rows.push([e.displayOperationNumber, e.entryDate, statement, debitAccounts, creditAccounts, amount.toLocaleString("en-US"), curLabel]);
    entryIds.push(e.id);

    totalsByCurrency.set(curLabel, (totalsByCurrency.get(curLabel) || 0) + amount);
  }

  const totals: Record<string, string> = {};
  for (const [label, sum] of totalsByCurrency) {
    totals[`إجمالي (${label})`] = sum.toLocaleString("en-US");
  }
  totals["عدد العمليات"] = String(sorted.length);

  const filterParts: string[] = [];
  filterParts.push(fromDate || toDate ? `من ${fromDate || "البداية"} إلى ${toDate || "الآن"}` : "كل الفترات");
  if (transactionType) filterParts.push(`نوع العملية: ${TRANSACTION_TYPE_LABELS_AR[transactionType] || transactionType}`);
  if (accountId) filterParts.push(`الحساب: ${accName(accountId)}`);
  if (currencyCode) {
    const c = Array.from(accountCurrencies.values()).find((c) => c.code === currencyCode);
    filterParts.push(`العملة: ${c ? `${c.name} (${c.symbol})` : currencyCode}`);
  }

  return {
    document: {
      kind: "transaction_log",
      title: "سجل العمليات",
      periodLabel: filterParts.join(" · "),
      generatedAt: new Date().toISOString().slice(0, 19).replace("T", " "),
      columns: ["رقم العملية", "التاريخ", "البيان", "الحساب المدين", "الحساب الدائن", "المبلغ", "العملة"],
      rows,
      totals,
    },
    entryIds,
  };
}

/**
 * يحوِّل أي ReportDocument إلى HTML قابل للطباعة/الأرشفة (window.print) — عرض بحت، لا منطق.
 * تصميم مستند مالي احترافي مختصر (الملاحظة 3): كتلة ترويسة (اسم التطبيق + عنوان التقرير +
 * معلومات مختصرة كالفترة/التاريخ)، جدول بحدود بسيطة ورأس مكرر عند كسر الصفحة (يُضبَط عبر
 * CSS في web/index.html، لا شيء هنا)، ثم كتلة إجماليات بارزة تُبرِز "الرصيد النهائي" تحديدًا
 * (أي مفتاح في totals يحتوي كلمة "النهائي" يأخذ تنسيق "final" المُعرَّف في CSS) دون افتراض
 * أي بنية أخرى — عام تمامًا لأي نوع تقرير حالي أو مستقبلي. لا معرّفات داخلية تظهر هنا إطلاقًا.
 */
export function renderReportToHtml(doc: ReportDocument): string {
  const escapeHtml = (value: string) =>
    value.replace(/[&<>"']/g, (character) => {
      const entities: Record<string, string> = {
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        "\"": "&quot;",
        "'": "&#39;",
      };
      return entities[character];
    });
  const rows = doc.rows.map((r) => `<tr>${r.map((c) => `<td>${escapeHtml(c)}</td>`).join("")}</tr>`).join("");
  const totals = doc.totals
    ? `<div class="report-totals">${Object.entries(doc.totals)
        .map(([k, v]) => `<div class="report-total-row${k.includes("النهائي") ? " final" : ""}"><span>${escapeHtml(k)}</span><span>${escapeHtml(v)}</span></div>`)
        .join("")}</div>`
    : "";
  return `
    <div class="report-doc">
      <div class="report-header">
        <div class="report-app-name">إسناد — مديرك المالي الشخصي</div>
        <h1>${escapeHtml(doc.title)}</h1>
        <div class="report-meta">${escapeHtml(doc.periodLabel)}</div>
      </div>
      <table class="report-table">
        <thead><tr>${doc.columns.map((c) => `<th>${escapeHtml(c)}</th>`).join("")}</tr></thead>
        <tbody>${rows || `<tr><td colspan="${doc.columns.length}">لا عمليات ضمن هذه الفترة.</td></tr>`}</tbody>
      </table>
      ${totals}
      <div class="report-footer">مستند مُنشأ إلكترونيًا في ${escapeHtml(doc.generatedAt)}</div>
    </div>`;
}
