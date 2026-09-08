// ============================================================
// إسناد — تطبيق الويب (PWA). كل شاشة تستدعي Repository الحقيقي فقط.
// لا يوجد أي state مستقل عن قاعدة البيانات — كل عرض يُعاد تحميله من التخزين.
// ============================================================
import { Account, AccountCategory, ExpensePriority, GoalPriority, DebtPriority, JournalEntry, ACCOUNT_GROUPS } from "../src/types";
import { recordIncome, recordExpense, recordTransfer, recordRecurringDebtPayment, recordOneTimeDebtPayment } from "../src/transactions";
import { IndexedDBStorageAdapter, AccountPlanningSettings, validatePlanningSettings } from "../src/storage";
import { Repository } from "../src/repository";
import { DistributionInput } from "../src/distribution";
import { buildAccountLedgerReport, buildTransactionLogReport, renderReportToHtml } from "../src/reports";
import { Currency } from "../src/currency";
import { BackupFile, validateBackupFile } from "../src/backup";
import { formatPeriodLabel } from "../src/periodDisplay";

// المخزن الحقيقي الوحيد لهذا التطبيق — IndexedDB كما طُلب صراحة، وليس FileStorageAdapter.
const storage = new IndexedDBStorageAdapter();
const repo = new Repository(storage);

// لا معرّف فترة ثابت — الفترة النشطة تُقرأ دائمًا من قاعدة البيانات (الفترة الوحيدة بحالة "open").
// هذا ضروري لتعمل دورة "إغلاق → فتح فترة تالية → توزيع يعكس الفترة الجديدة" بشكل صحيح.
async function getActivePeriodId(): Promise<string> {
  const all = await storage.getAllFinancialPeriods();
  const open = all.find((p) => p.status === "open");
  if (open) return open.id;
  // لا فترة مفتوحة إطلاقًا (أول تشغيل) — نفتح واحدة تلقائيًا
  const id = "period_" + Date.now();
  const today = new Date().toISOString().slice(0, 10);
  await repo.openPeriod({ id, startDate: today, endDate: today, status: "open" });
  return id;
}

let seq = 0;
function nextId(prefix: string): string {
  seq += 1;
  return `${prefix}_${Date.now()}_${seq}`;
}

const mainEl = document.getElementById("app-main")!;
const navButtons = Array.from(document.querySelectorAll<HTMLButtonElement>("#app-nav button"));

type Screen = "dashboard" | "accounts" | "transactions" | "reports" | "distribution" | "closing" | "settings";

async function navigate(screen: Screen) {
  navButtons.forEach((b) => b.classList.toggle("active", b.dataset.screen === screen));
  mainEl.innerHTML = `<div class="empty">جارٍ التحميل…</div>`;
  try {
    if (screen === "dashboard") await renderDashboardScreen();
    else if (screen === "accounts") await renderAccountsScreen();
    else if (screen === "transactions") await renderTransactionsScreen();
    else if (screen === "reports") await renderReportsScreen();
    else if (screen === "distribution") await renderDistributionScreen();
    else if (screen === "closing") await renderClosingScreen();
    else if (screen === "settings") await renderSettingsScreen();
  } catch (e) {
    mainEl.innerHTML = `<div class="error">خطأ: ${(e as Error).message}</div>`;
  }
}

navButtons.forEach((b) =>
  b.addEventListener("click", () => navigate(b.dataset.screen as Screen))
);

function fmt(n: number): string {
  // أرقام غربية صراحة (وليس هندية عربية) للوضوح المالي — شائع في التطبيقات المالية العربية
  return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

const CATEGORY_LABELS: Record<AccountCategory, string> = {
  pot: "وعاء مالي",
  income_source: "مصدر دخل",
  expense: "مصروف",
  recurring_debt: "دين مستمر",
  one_time_debt: "دين لمرة واحدة",
  goal: "هدف مالي",
  reserve: "احتياطي",
  asset: "أصل/مقتنى",
};

// تسميات عربية لكل نوع عملية — تُستخدَم في عرض قائمة العمليات وتفاصيلها فقط (المرحلة 3)،
// ولا تُغيّر transactionType نفسه أو أي منطق محاسبي.
const TX_TYPE_LABELS: Record<string, string> = {
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

// ============================================================
// شاشة 0 — لوحة التحكم الرئيسية: كل رقم محسوب فعليًا من القيود/المحرك، لا شيء مخزَّن مباشرة
// ============================================================
async function renderDashboardScreen() {
  const accounts = await repo.getAllAccounts();
  const periodId = await getActivePeriodId();
  const period = await repo.getPeriod(periodId);
  const periodEntries = await storage.getJournalEntriesForPeriod(periodId);

  const pots = accounts.filter((a) => a.category === "pot");
  const potBalances = await Promise.all(pots.map((p) => repo.getAccountBalance(p.id)));
  const totalPots = potBalances.reduce((s, b) => s + b, 0);

  const incomeActual = periodEntries.filter((e) => e.transactionType === "income").reduce((s, e) => s + e.lines.filter((l) => l.direction === "CREDIT").reduce((s2, l) => s2 + l.amount, 0), 0);
  const expenseActual = periodEntries.filter((e) => e.transactionType === "expense").reduce((s, e) => s + e.lines.filter((l) => l.direction === "DEBIT").reduce((s2, l) => s2 + l.amount, 0), 0);
  const netFlow = incomeActual - expenseActual;

  const debts = accounts.filter((a) => a.category === "recurring_debt" || a.category === "one_time_debt");
  const debtBalances = await Promise.all(debts.map((d) => repo.getAccountBalance(d.id)));
  const totalDebts = debtBalances.reduce((s, b) => s + b, 0);

  const goals = accounts.filter((a) => a.category === "goal");
  const goalSettings = await Promise.all(goals.map((g) => repo.getPlanningSettings(g.id)));
  const goalBalances = await Promise.all(goals.map((g) => repo.getAccountBalance(g.id)));

  const alerts: string[] = [];
  const expensesForAlerts = accounts.filter((a) => a.category === "expense");
  for (const e of expensesForAlerts) {
    const s = await repo.getPlanningSettings(e.id);
    if (!s || s.kind !== "expense") continue;
    const actual = periodEntries.reduce((sum, en) => sum + en.lines.filter((l) => l.accountId === e.id && l.direction === "DEBIT").reduce((s2, l) => s2 + l.amount, 0), 0);
    if (s.monthlyMax > 0 && actual > s.monthlyMax) {
      alerts.push(`⚠️ تجاوز "${e.name}": الفعلي (${fmt(actual)}) تجاوز الحد الأعلى (${fmt(s.monthlyMax)}) بمقدار ${fmt(actual - s.monthlyMax)}`);
    }
    if (s.dueDate) {
      const days = Math.ceil((new Date(s.dueDate).getTime() - Date.now()) / 86400000);
      if (days >= 0 && days <= 7) alerts.push(`📅 استحقاق "${e.name}" خلال ${days} يوم/أيام (${s.dueDate})`);
    }
  }
  for (const d of debts) {
    const s = await repo.getPlanningSettings(d.id);
    const dueDate = s && "dueDate" in s ? s.dueDate : undefined;
    if (dueDate) {
      const days = Math.ceil((new Date(dueDate).getTime() - Date.now()) / 86400000);
      if (days >= 0 && days <= 7) alerts.push(`📅 استحقاق دين "${d.name}" خلال ${days} يوم/أيام (${dueDate})`);
    }
  }
  for (const d of accounts.filter((a) => a.category === "recurring_debt")) {
    const s = await repo.getPlanningSettings(d.id);
    if (s?.kind !== "recurring_debt") continue;
    const bal = await repo.getAccountBalance(d.id);
    if (s.maxLimit > 0 && bal >= s.maxLimit) alerts.push(`🔴 دين "${d.name}" بلغ/تجاوز حده الأعلى (${fmt(bal)}/${fmt(s.maxLimit)}) — أولوية سداد إجباري`);
  }

  mainEl.innerHTML = `
    <div class="card">
      <h2>الفترة الحالية: ${period ? formatPeriodLabel(period) : "—"}</h2>
      <div class="row"><span>الدخل الفعلي هذه الفترة</span><b class="balance-pos">${fmt(incomeActual)}</b></div>
      <div class="row"><span>المصروفات الفعلية هذه الفترة</span><b class="balance-neg">${fmt(expenseActual)}</b></div>
      <div class="row"><span>صافي التدفق النقدي</span><b class="${netFlow >= 0 ? "balance-pos" : "balance-neg"}">${fmt(netFlow)}</b></div>
    </div>
    <div class="card">
      <h2>الأوعية المالية</h2>
      <div class="row"><span>إجمالي أرصدة الأوعية</span><b>${fmt(totalPots)}</b></div>
      ${pots.map((p, i) => `<div class="row muted"><span>${p.name}</span><span>${fmt(potBalances[i])}</span></div>`).join("")}
    </div>
    <div class="card">
      <h2>الديون والالتزامات</h2>
      <div class="row"><span>إجمالي الديون (مستمرة + لمرة واحدة)</span><b class="balance-neg">${fmt(totalDebts)}</b></div>
    </div>
    <div class="card">
      <h2>الأهداف — التقدم</h2>
      ${
        goals.length === 0
          ? `<div class="empty">لا توجد أهداف بعد.</div>`
          : goals
              .map((g, i) => {
                const s = goalSettings[i];
                const target = s?.kind === "goal" ? s.targetAmount : 0;
                const pct = target > 0 ? Math.min(100, Math.round((goalBalances[i] / target) * 100)) : 0;
                return `<div class="row"><span>${g.name}</span><span>${fmt(goalBalances[i])} / ${fmt(target)} (${pct}%)</span></div>`;
              })
              .join("")
      }
    </div>
    <div class="card">
      <h2>تنبيهات</h2>
      ${alerts.length === 0 ? `<div class="empty">لا توجد تنبيهات حاليًا.</div>` : alerts.map((a) => `<div class="row" style="justify-content:flex-start;">${a}</div>`).join("")}
    </div>
    <div class="card">
      <h2>ملخص الخطة المقترحة</h2>
      <p class="muted">لعرض التفاصيل الكاملة، افتح شاشة "الخطة".</p>
      <button class="primary" id="btn-goto-plan">فتح شاشة الخطة</button>
    </div>
  `;
  document.getElementById("btn-goto-plan")!.addEventListener("click", () => navigate("distribution"));
}

// ============================================================
// شاشة 1 — الحسابات: تعرض الأرصدة المحسوبة فعليًا من computeBalance عبر Repository،
// وتسمح بإضافة/تعديل إعدادات التخطيط الخاصة بكل فئة (تُستخدَم فعليًا في محرك التوزيع).
// ============================================================
const EXPENSE_PRIORITY_LABELS: Record<ExpensePriority, string> = {
  essential_high: "ضروري جدًا",
  essential: "ضروري",
  essential_moderate: "ضروري نوعًا ما",
};
const GOAL_PRIORITY_LABELS: Record<GoalPriority, string> = {
  critical: "مهم جدًا",
  important: "مهم",
  moderate: "مهم إلى حد ما",
};
const DEBT_PRIORITY_LABELS: Record<DebtPriority, string> = {
  urgent_high: "عاجل جدًا",
  urgent: "عاجل",
  urgent_moderate: "عاجل إلى حد ما",
};

let editingAccountId: string | null = null;
let pendingClosingMessage: string | null = null;

/** يعرض تقرير حساب قابل للطباعة (window.print) في نافذة/طبقة منفصلة — بلا تعديل على DOM الشاشة الحالية. */
async function showAccountReport(accountId: string) {
  const accounts = await repo.getAllAccounts();
  const account = accounts.find((a) => a.id === accountId);
  if (!account) return;
  const entries = await repo.getAllJournalEntries();
  const report = buildAccountLedgerReport({ account, allAccounts: accounts, entries });
  const html = renderReportToHtml(report);

  const overlay = document.createElement("div");
  overlay.id = "report-overlay";
  overlay.style.cssText = "position:fixed; inset:0; background:white; z-index:100; overflow:auto; padding:16px;";
  overlay.innerHTML = `
    <div style="max-width:640px; margin:0 auto;">
      <button id="btn-close-report" class="primary" style="width:auto; padding:8px 16px;">إغلاق</button>
      <button id="btn-print-report" class="primary" style="width:auto; padding:8px 16px; background:#333;">طباعة</button>
      ${html}
    </div>`;
  document.body.appendChild(overlay);
  document.getElementById("btn-close-report")!.addEventListener("click", () => overlay.remove());
  document.getElementById("btn-print-report")!.addEventListener("click", () => window.print());
}

// ============================================================
// شاشة 3 — التقارير (المرحلة 5، الخطوة 1): "كشف حساب" فقط. تُبنى بالكامل عبر
// buildAccountLedgerReport/renderReportToHtml الموجودتين في src/reports.ts دون أي منطق
// تقرير مواز هنا. تظهر داخل شاشة "التقارير" نفسها (لا Overlay) — showAccountReport أعلاه
// تبقى كما هي دون أي تعديل، تستمر بخدمة زر التفاصيل في شاشة الحسابات.
// ============================================================
async function renderReportsScreen() {
  const accounts = await repo.getAllAccounts();
  const sortedAccounts = [...accounts].sort((a, b) => {
    const ca = a.code ? parseInt(a.code, 10) : Number.MAX_SAFE_INTEGER;
    const cb = b.code ? parseInt(b.code, 10) : Number.MAX_SAFE_INTEGER;
    return ca - cb;
  });
  const allCurrencies = await repo.getAllCurrencies();

  mainEl.innerHTML = `
    <div class="card">
      <div id="reports-controls">
        <h2>التقارير</h2>
        <label>نوع التقرير</label>
        <select id="report-type">
          <option value="account_ledger">كشف حساب</option>
          <option value="transaction_log">سجل العمليات</option>
        </select>

        <div id="report-type-fields"></div>

        <button class="primary" id="btn-generate-report">عرض التقرير</button>
        <div id="report-msg"></div>
      </div>

      <div id="reports-result"></div>
    </div>
  `;

  const typeEl = document.getElementById("report-type") as HTMLSelectElement;
  const fieldsEl = document.getElementById("report-type-fields")!;

  function renderTypeFields() {
    const t = typeEl.value;
    if (t === "account_ledger") {
      fieldsEl.innerHTML = `
        <label>الحساب</label>
        <select id="report-account">
          <option value="">اختر حسابًا</option>
          ${sortedAccounts.map((a) => `<option value="${a.id}">${a.code ? `${a.code} — ` : ""}${a.name}</option>`).join("")}
        </select>
        <div id="report-account-meta" class="muted" style="margin:4px 0 12px;"></div>
        <label>من تاريخ (اختياري)</label>
        <input id="report-from" type="date" />
        <label>إلى تاريخ (اختياري)</label>
        <input id="report-to" type="date" />
      `;
      const accountEl = document.getElementById("report-account") as HTMLSelectElement;
      const metaEl = document.getElementById("report-account-meta")!;
      accountEl.addEventListener("change", async () => {
        const id = accountEl.value;
        if (!id) {
          metaEl.innerHTML = "";
          return;
        }
        const account = accounts.find((a) => a.id === id);
        if (!account) {
          metaEl.innerHTML = "";
          return;
        }
        const currency = await repo.getAccountCurrency(id);
        metaEl.innerHTML = `الكود: <b>${account.code ?? "—"}</b> · العملة: <b>${currency.name} (${currency.symbol})</b>`;
      });
    } else if (t === "transaction_log") {
      // لا حساب إجباري هنا: الافتراضي "كل الحسابات" — يطابق ما طُلب صراحة لسجل العمليات.
      fieldsEl.innerHTML = `
        <label>من تاريخ (اختياري)</label>
        <input id="report-from" type="date" />
        <label>إلى تاريخ (اختياري)</label>
        <input id="report-to" type="date" />
        <label>نوع العملية</label>
        <select id="report-tx-type">
          <option value="">كل الأنواع</option>
          ${Object.entries(TX_TYPE_LABELS).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}
        </select>
        <label>الحساب</label>
        <select id="report-tx-account">
          <option value="">كل الحسابات</option>
          ${sortedAccounts.map((a) => `<option value="${a.id}">${a.code ? `${a.code} — ` : ""}${a.name}</option>`).join("")}
        </select>
        <label>العملة</label>
        <select id="report-tx-currency">
          <option value="">كل العملات</option>
          ${allCurrencies.map((c) => `<option value="${c.code}">${c.name} (${c.symbol})</option>`).join("")}
        </select>
      `;
    }
  }
  typeEl.addEventListener("change", renderTypeFields);
  renderTypeFields();

  document.getElementById("btn-generate-report")!.addEventListener("click", async () => {
    const msgEl = document.getElementById("report-msg")!;
    const resultEl = document.getElementById("reports-result")!;
    msgEl.innerHTML = "";
    resultEl.innerHTML = "";
    const t = typeEl.value;

    if (t === "account_ledger") {
      const accountEl = document.getElementById("report-account") as HTMLSelectElement;
      const accountId = accountEl.value;
      if (!accountId) {
        msgEl.innerHTML = `<div class="error">يجب اختيار حساب أولًا.</div>`;
        return;
      }
      const fromDate = (document.getElementById("report-from") as HTMLInputElement).value || undefined;
      const toDate = (document.getElementById("report-to") as HTMLInputElement).value || undefined;
      if (fromDate && toDate && fromDate > toDate) {
        msgEl.innerHTML = `<div class="error">تاريخ "من" يجب ألا يكون بعد تاريخ "إلى".</div>`;
        return;
      }

      const account = accounts.find((a) => a.id === accountId)!;
      const entries = await repo.getAllJournalEntries();
      const currency = await repo.getAccountCurrency(accountId);
      // buildAccountLedgerReport نفسها من src/reports.ts — لا منطق تقرير مكرر هنا؛
      // fromDate/toDate والعملة يُمرَّران كما هما إلى الدالة الموجودة (مع تحسين المرحلة 5
      // لحساب الرصيد الافتتاحي الصحيح للفترة داخلها). renderReportToHtml وحدها تبني عرض
      // المستند (بما فيها حالة "لا حركات" — تُظهر رسالة واضحة داخل الجدول مع الإجماليات/
      // الرصيد الافتتاحي والنهائي كاملة أسفله) — لا بناء HTML مكرر هنا لأي حالة (الملاحظة 3).
      const report = buildAccountLedgerReport({ account, allAccounts: accounts, entries, fromDate, toDate, currency });

      resultEl.innerHTML = `
        <div id="reports-print-area">${renderReportToHtml(report)}</div>
        <div id="reports-actions"><button class="primary" id="btn-print-report">طباعة</button></div>
      `;
      document.getElementById("btn-print-report")!.addEventListener("click", () => window.print());
    } else if (t === "transaction_log") {
      const fromDate = (document.getElementById("report-from") as HTMLInputElement).value || undefined;
      const toDate = (document.getElementById("report-to") as HTMLInputElement).value || undefined;
      if (fromDate && toDate && fromDate > toDate) {
        msgEl.innerHTML = `<div class="error">تاريخ "من" يجب ألا يكون بعد تاريخ "إلى".</div>`;
        return;
      }
      const transactionType = (document.getElementById("report-tx-type") as HTMLSelectElement).value || undefined;
      const filterAccountId = (document.getElementById("report-tx-account") as HTMLSelectElement).value || undefined;
      const currencyCode = (document.getElementById("report-tx-currency") as HTMLSelectElement).value || undefined;

      // بيانات فعلية فقط: getAllJournalEntriesWithDisplayNumbers (المرحلة 3، بلا كتابة أي رقم
      // جديد للقيود القديمة) + عملة كل حساب فعليًا موجود (المرحلة 1) — لا بيانات مُخترَعة.
      const entriesWithNumbers = await repo.getAllJournalEntriesWithDisplayNumbers();
      const accountCurrencies = new Map(
        await Promise.all(accounts.map(async (a) => [a.id, await repo.getAccountCurrency(a.id)] as const))
      );

      const { document: report, entryIds } = buildTransactionLogReport({
        entries: entriesWithNumbers,
        accounts,
        accountCurrencies,
        fromDate,
        toDate,
        transactionType,
        accountId: filterAccountId,
        currencyCode,
      });

      const rowsHtml = report.rows
        .map((r, i) => `<tr data-open-tx-id="${entryIds[i]}" style="cursor:pointer;">${r.map((c) => `<td>${c}</td>`).join("")}</tr>`)
        .join("");
      const totalsHtml = `<div class="report-totals">${Object.entries(report.totals || {}).map(([k, v]) => `<div><b>${k}:</b> ${v}</div>`).join("")}</div>`;

      resultEl.innerHTML = `
        <div id="reports-print-area">
          <div class="report-doc">
            <h1>${report.title}</h1>
            <div class="report-meta">${report.periodLabel} — أُنشئ في ${report.generatedAt}</div>
            ${
              report.rows.length === 0
                ? `<div class="empty">لا توجد عمليات مطابقة للفلاتر المحددة.</div>`
                : `<table class="report-table">
                     <thead><tr>${report.columns.map((c) => `<th>${c}</th>`).join("")}</tr></thead>
                     <tbody>${rowsHtml}</tbody>
                   </table>`
            }
            ${totalsHtml}
          </div>
        </div>
        <div id="reports-actions"><button class="primary" id="btn-print-report">طباعة</button></div>
      `;
      document.getElementById("btn-print-report")!.addEventListener("click", () => window.print());

      // النقر على عملية: إعادة استخدام عرض تفاصيل العملية من المرحلة 3 كما هو تمامًا — عرض
      // فقط، بلا تعديل أو حذف. هذا يُظهر تبويب "العمليات" بتفاصيل هذا القيد (سلوك renderTransactionDetail
      // الأصلي دون أي تغيير فيه)، وزر "رجوع" هناك يعيد المستخدم لقائمة العمليات كالمعتاد.
      document.querySelectorAll<HTMLElement>("[data-open-tx-id]").forEach((row) => {
        row.addEventListener("click", () => {
          navButtons.forEach((b) => b.classList.toggle("active", b.dataset.screen === "transactions"));
          txDetailEntryId = row.dataset.openTxId!;
          txViewMode = "detail";
          renderTransactionsBody();
        });
      });
    }
  });
}

function planningFieldsHtml(category: AccountCategory, existing: AccountPlanningSettings | null): string {
  if (category === "expense") {
    const s = existing?.kind === "expense" ? existing : null;
    return `
      <label>الحد الأدنى الشهري</label>
      <input id="pf-min" type="number" min="0" step="0.01" value="${s?.monthlyMin ?? ""}" />
      <label>الحد الأعلى الشهري</label>
      <input id="pf-max" type="number" min="0" step="0.01" value="${s?.monthlyMax ?? ""}" />
      <label>درجة الضرورة</label>
      <select id="pf-priority">
        ${Object.entries(EXPENSE_PRIORITY_LABELS).map(([k, v]) => `<option value="${k}" ${s?.priority === k ? "selected" : ""}>${v}</option>`).join("")}
      </select>
      <label>تاريخ الاستحقاق (إن وُجد)</label>
      <input id="pf-due" type="date" value="${s?.dueDate ?? ""}" />
    `;
  }
  if (category === "goal") {
    const s = existing?.kind === "goal" ? existing : null;
    return `
      <label>الحد الأدنى للتخصيص</label>
      <input id="pf-min" type="number" min="0" step="0.01" value="${s?.minAllocation ?? ""}" />
      <label>الحد الأعلى للتخصيص</label>
      <input id="pf-max" type="number" min="0" step="0.01" value="${s?.maxAllocation ?? ""}" />
      <label>المبلغ المستهدف</label>
      <input id="pf-target" type="number" min="0" step="0.01" value="${s?.targetAmount ?? ""}" />
      <label>الأولوية</label>
      <select id="pf-priority">
        ${Object.entries(GOAL_PRIORITY_LABELS).map(([k, v]) => `<option value="${k}" ${s?.priority === k ? "selected" : ""}>${v}</option>`).join("")}
      </select>
      <label>تاريخ الاستحقاق</label>
      <input id="pf-due" type="date" value="${s?.dueDate ?? ""}" />
      <label><input id="pf-nondef" type="checkbox" style="width:auto; display:inline-block;" ${s?.isNonDeferrable ? "checked" : ""} /> التزام غير قابل للتأجيل</label>
    `;
  }
  if (category === "recurring_debt") {
    const s = existing?.kind === "recurring_debt" ? existing : null;
    return `
      <label>الحد الأدنى</label>
      <input id="pf-min" type="number" min="0" step="0.01" value="${s?.minLimit ?? ""}" />
      <label>الحد الأعلى</label>
      <input id="pf-max" type="number" min="0" step="0.01" value="${s?.maxLimit ?? ""}" />
      <label>تاريخ الاستحقاق (إن وُجد)</label>
      <input id="pf-due" type="date" value="${s?.dueDate ?? ""}" />
      <div class="muted">الرصيد الحالي يُحسب تلقائيًا من القيود الفعلية — لا يُدخَل يدويًا.</div>
    `;
  }
  if (category === "one_time_debt") {
    const s = existing?.kind === "one_time_debt" ? existing : null;
    return `
      <label>الأولوية</label>
      <select id="pf-priority">
        ${Object.entries(DEBT_PRIORITY_LABELS).map(([k, v]) => `<option value="${k}" ${s?.priority === k ? "selected" : ""}>${v}</option>`).join("")}
      </select>
      <label>تاريخ الاستحقاق</label>
      <input id="pf-due" type="date" value="${s?.dueDate ?? ""}" />
      <div class="muted">المبلغ يُحسب من رصيد الحساب الفعلي (القيود) — أنشئ الالتزام كعملية من شاشة العمليات.</div>
    `;
  }
  if (category === "income_source") {
    const s = existing?.kind === "income_source" ? existing : null;
    return `
      <label>نوع الدخل</label>
      <select id="pf-recurrence">
        <option value="fixed" ${s?.recurrenceType === "fixed" ? "selected" : ""}>ثابت</option>
        <option value="intermittent" ${s?.recurrenceType === "intermittent" ? "selected" : ""}>متقطع</option>
      </select>
      <label>المبلغ المتوقَّع</label>
      <input id="pf-amount" type="number" min="0" step="0.01" value="${s?.expectedAmount ?? ""}" />
      <label>تاريخ الاستحقاق</label>
      <input id="pf-due" type="date" value="${s?.dueDate ?? ""}" />
    `;
  }
  if (category === "asset") {
    const s = existing?.kind === "asset" ? existing : null;
    return `
      <label>قيمة الشراء</label>
      <input id="pf-purchase-value" type="number" min="0" step="0.01" value="${s?.purchaseValue ?? ""}" />
      <label>تاريخ الشراء (اختياري)</label>
      <input id="pf-purchase-date" type="date" value="${s?.purchaseDate ?? ""}" />
      <label>القيمة الحالية التقديرية (اختياري)</label>
      <input id="pf-current-value" type="number" min="0" step="0.01" value="${s?.currentValueEstimate ?? ""}" />
    `;
  }
  return `<div class="muted">لا توجد إعدادات تخطيط إضافية لهذه الفئة.</div>`;
}

function buildPlanningSettingsFromForm(accountId: string, category: AccountCategory): AccountPlanningSettings | null {
  const val = (id: string) => (document.getElementById(id) as HTMLInputElement | HTMLSelectElement | null)?.value ?? "";
  const num = (id: string) => Number(val(id)) || 0;
  const due = val("pf-due") || undefined;

  if (category === "expense") {
    return { kind: "expense", accountId, monthlyMin: num("pf-min"), monthlyMax: num("pf-max"), priority: val("pf-priority") as ExpensePriority, dueDate: due };
  }
  if (category === "goal") {
    const nondef = (document.getElementById("pf-nondef") as HTMLInputElement | null)?.checked ?? false;
    return { kind: "goal", accountId, minAllocation: num("pf-min"), maxAllocation: num("pf-max"), targetAmount: num("pf-target"), priority: val("pf-priority") as GoalPriority, dueDate: due, isNonDeferrable: nondef };
  }
  if (category === "recurring_debt") {
    return { kind: "recurring_debt", accountId, minLimit: num("pf-min"), maxLimit: num("pf-max"), dueDate: due };
  }
  if (category === "one_time_debt") {
    return { kind: "one_time_debt", accountId, priority: val("pf-priority") as DebtPriority, dueDate: due };
  }
  if (category === "income_source") {
    return { kind: "income_source", accountId, recurrenceType: val("pf-recurrence") as "fixed" | "intermittent", expectedAmount: num("pf-amount"), dueDate: due };
  }
  if (category === "asset") {
    return {
      kind: "asset",
      accountId,
      purchaseValue: num("pf-purchase-value"),
      purchaseDate: (document.getElementById("pf-purchase-date") as HTMLInputElement | null)?.value || undefined,
      currentValueEstimate: (document.getElementById("pf-current-value") as HTMLInputElement | null)?.value ? num("pf-current-value") : undefined,
    };
  }
  return null; // pot / reserve — لا إعدادات تخطيط إضافية
}

// ============================================================
// شاشة 1 — الحسابات: المرحلة 4 أعادت بناء العرض فقط (مجموعات ثمانية قابلة للطي + كود ظاهر
// ثابت لكل حساب) دون أي تغيير في category أو منطق الرصيد أو القيود أو الفئات المسموحة.
// ============================================================
type AcctViewMode = "list" | "form";
let acctViewMode: AcctViewMode = "list";
let expandedAccountGroups = new Set<number>();
/** الفئة المحدَّدة مسبقًا عند الضغط على "+" داخل مجموعة أحادية الفئة (مقفلة في النموذج). */
let addAccountCategory: AccountCategory | null = null;
/** رقم المجموعة عند الإضافة — يُستخدَم لعرض اختيار بين فئتين في مجموعة "دائنون" فقط. */
let addAccountGroupNumber: number | null = null;

async function renderAccountsScreen() {
  // كل دخول جديد للتبويب يبدأ من قائمة المجموعات دائمًا — لا نموذج مباشرةً.
  acctViewMode = "list";
  editingAccountId = null;
  addAccountCategory = null;
  addAccountGroupNumber = null;
  await renderAccountsBody();
}

async function renderAccountsBody() {
  if (acctViewMode === "form") return renderAccountForm();
  return renderAccountGroupList();
}

function planningSummary(a: Account, s: AccountPlanningSettings | null): string {
  if (!s) {
    if (["expense", "goal", "recurring_debt", "one_time_debt", "income_source"].includes(a.category)) {
      return `<span class="tag" style="background:#fdecea;color:#b3352a;">بلا إعدادات تخطيط — مُستبعَد من التوزيع</span>`;
    }
    return "";
  }
  if (s.kind === "expense") return `<span class="tag">${EXPENSE_PRIORITY_LABELS[s.priority]} · ${fmt(s.monthlyMin)}–${fmt(s.monthlyMax)}</span>`;
  if (s.kind === "goal") return `<span class="tag">${GOAL_PRIORITY_LABELS[s.priority]}${s.isNonDeferrable ? " · غير قابل للتأجيل" : ""}</span>`;
  if (s.kind === "recurring_debt") return `<span class="tag">حدود ${fmt(s.minLimit)}–${fmt(s.maxLimit)}</span>`;
  if (s.kind === "one_time_debt") return `<span class="tag">${DEBT_PRIORITY_LABELS[s.priority]}</span>`;
  if (s.kind === "income_source") return `<span class="tag">${s.recurrenceType === "fixed" ? "ثابت" : "متقطع"} · ${fmt(s.expectedAmount)}</span>`;
  if (s.kind === "asset") return `<span class="tag">قيمة الشراء ${fmt(s.purchaseValue)}${s.currentValueEstimate !== undefined ? ` · حاليًا ~${fmt(s.currentValueEstimate)}` : ""}</span>`;
  return "";
}

async function renderAccountGroupList() {
  const accounts = await repo.getAllAccounts();
  const balances = await Promise.all(accounts.map((a) => repo.getAccountBalance(a.id)));
  const balanceById = new Map(accounts.map((a, i) => [a.id, balances[i]]));
  const currencies = await Promise.all(accounts.map((a) => repo.getAccountCurrency(a.id)));
  const currencyById = new Map(accounts.map((a, i) => [a.id, currencies[i]]));
  const allSettings = await Promise.all(accounts.map((a) => repo.getPlanningSettings(a.id)));
  const settingsById = new Map(accounts.map((a, i) => [a.id, allSettings[i]]));

  const groupsHtml = ACCOUNT_GROUPS.map((g) => {
    const groupAccounts = accounts
      .filter((a) => g.categories.includes(a.category))
      .sort((a, b) => {
        const ca = a.code ? parseInt(a.code, 10) : Number.MAX_SAFE_INTEGER;
        const cb = b.code ? parseInt(b.code, 10) : Number.MAX_SAFE_INTEGER;
        return ca - cb;
      });
    const totalBalance = groupAccounts.reduce((s, a) => s + (balanceById.get(a.id) || 0), 0);
    const isOpen = expandedAccountGroups.has(g.n);

    const rowsHtml = groupAccounts
      .map((a) => {
        const bal = balanceById.get(a.id) || 0;
        const cur = currencyById.get(a.id)!;
        const cls = bal >= 0 ? "balance-pos" : "balance-neg";
        return `
          <div class="acct-row" data-open-report-id="${a.id}">
            <div class="row">
              <span><span class="tag">${a.code ?? "—"}</span> ${a.name}</span>
              <span class="${cls}">${fmt(bal)} <span class="muted">${cur.symbol}</span></span>
            </div>
            <div class="row" style="margin-top:4px;">
              <span>${planningSummary(a, settingsById.get(a.id) || null)}</span>
              <button data-edit-id="${a.id}" class="btn-secondary">تعديل</button>
            </div>
          </div>`;
      })
      .join("");

    const bodyHtml = isOpen
      ? `<div class="acct-group-body">
           ${groupAccounts.length ? rowsHtml : `<div class="empty">لا توجد حسابات في هذه المجموعة بعد.</div>`}
           <button data-add-group="${g.n}" class="fab-add" aria-label="إضافة حساب إلى ${g.label}">+</button>
         </div>`
      : "";

    return `
      <div class="acct-group">
        <div class="acct-group-header" data-toggle-group="${g.n}">
          <span>${g.n}. ${g.label} <span class="muted">(${groupAccounts.length})</span></span>
          <span class="row">
            <span class="muted">${fmt(totalBalance)}</span>
            <span>${isOpen ? "▾" : "◂"}</span>
          </span>
        </div>
        ${bodyHtml}
      </div>`;
  }).join("");

  mainEl.innerHTML = `<div class="card"><h2>الحسابات</h2>${groupsHtml}</div>`;

  document.querySelectorAll<HTMLElement>("[data-toggle-group]").forEach((el) => {
    el.addEventListener("click", () => {
      const n = Number(el.dataset.toggleGroup);
      if (expandedAccountGroups.has(n)) expandedAccountGroups.delete(n);
      else expandedAccountGroups.add(n);
      renderAccountsBody();
    });
  });
  document.querySelectorAll<HTMLElement>("[data-open-report-id]").forEach((el) => {
    el.addEventListener("click", async (ev) => {
      ev.stopPropagation();
      await showAccountReport(el.dataset.openReportId!);
    });
  });
  document.querySelectorAll<HTMLElement>("[data-edit-id]").forEach((btn) => {
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      editingAccountId = btn.dataset.editId!;
      acctViewMode = "form";
      renderAccountsBody();
    });
  });
  document.querySelectorAll<HTMLElement>("[data-add-group]").forEach((btn) => {
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const n = Number(btn.dataset.addGroup);
      const group = ACCOUNT_GROUPS.find((gr) => gr.n === n)!;
      addAccountGroupNumber = n;
      addAccountCategory = group.categories.length === 1 ? group.categories[0] : null;
      editingAccountId = null;
      acctViewMode = "form";
      renderAccountsBody();
    });
  });
}

async function renderAccountForm() {
  const accounts = await repo.getAllAccounts();
  const allCurrencies = await repo.getAllCurrencies();
  const allSettings = await Promise.all(accounts.map((a) => repo.getPlanningSettings(a.id)));

  const editingAccount = editingAccountId ? accounts.find((a) => a.id === editingAccountId) ?? null : null;
  const editingSettings = editingAccountId ? allSettings[accounts.findIndex((a) => a.id === editingAccountId)] : null;
  const editingCurrency = editingAccount ? await repo.getAccountCurrency(editingAccount.id) : null;
  // العملة المقترحة مبدئيًا لحساب جديد فقط — العملة الافتراضية المختارة من الإعدادات (الملاحظة 1 §5).
  // لا تُستخدَم إطلاقًا عند التعديل (editingCurrency له الأولوية دائمًا)، فلا تُجبَر حسابات قديمة عليها.
  const defaultCurrency = await repo.getDefaultCurrency();

  // قائمة الفئات المسموحة في النموذج: فئة واحدة مقفلة (تعديل، أو إضافة داخل مجموعة أحادية
  // الفئة)، أو فئتان يختار المستخدم بينهما (إضافة داخل مجموعة "دائنون" فقط) — بلا أي تغيير
  // على قيود كل فئة نفسها أو حقولها الخاصة.
  let categoryOptions: AccountCategory[];
  let categoryLocked: boolean;
  if (editingAccount) {
    categoryOptions = [editingAccount.category];
    categoryLocked = true;
  } else if (addAccountCategory) {
    categoryOptions = [addAccountCategory];
    categoryLocked = true;
  } else if (addAccountGroupNumber != null) {
    const group = ACCOUNT_GROUPS.find((g) => g.n === addAccountGroupNumber)!;
    categoryOptions = group.categories;
    categoryLocked = false;
  } else {
    // احتياط دفاعي فقط — لا يُفترَض حدوثه بعد المرحلة 4 (كل "+" مرتبط بمجموعة دائمًا)
    categoryOptions = Object.keys(CATEGORY_LABELS) as AccountCategory[];
    categoryLocked = false;
  }
  const formCategory = editingAccount ? editingAccount.category : categoryOptions[0];

  mainEl.innerHTML = `
    <div class="card">
      <div class="row">
        <h2>${editingAccount ? `تعديل: ${editingAccount.name}` : "إضافة حساب جديد"}</h2>
        <button id="btn-cancel-acct" class="btn-secondary">رجوع</button>
      </div>
      <label>الاسم</label>
      <input id="new-acc-name" placeholder="مثال: المحفظة" value="${editingAccount?.name ?? ""}" />
      <label>الفئة</label>
      <select id="new-acc-category" ${categoryLocked ? "disabled" : ""}>
        ${categoryOptions.map((c) => `<option value="${c}" ${formCategory === c ? "selected" : ""}>${CATEGORY_LABELS[c]}</option>`).join("")}
      </select>
      ${!editingAccount ? `<label>الرصيد الافتتاحي (اختياري)</label><input id="new-acc-opening" type="number" value="0" />` : ""}
      <label>العملة</label>
      <select id="new-acc-currency">
        ${allCurrencies
          .map(
            (c) =>
              `<option value="${c.code}" ${(editingCurrency?.code ?? defaultCurrency.code) === c.code ? "selected" : ""}>${c.name} (${c.symbol})</option>`
          )
          .join("")}
      </select>
      <div id="planning-fields">${planningFieldsHtml(formCategory as AccountCategory, editingSettings)}</div>
      <button class="primary" id="btn-add-account">${editingAccount ? "حفظ التعديلات" : "إضافة الحساب"}</button>
      <div id="acc-msg"></div>
    </div>
  `;

  document.getElementById("btn-cancel-acct")!.addEventListener("click", () => {
    acctViewMode = "list";
    editingAccountId = null;
    renderAccountsBody();
  });

  if (!categoryLocked) {
    document.getElementById("new-acc-category")!.addEventListener("change", (e) => {
      const cat = (e.target as HTMLSelectElement).value as AccountCategory;
      document.getElementById("planning-fields")!.innerHTML = planningFieldsHtml(cat, null);
    });
  }

  document.getElementById("btn-add-account")!.addEventListener("click", async () => {
    const nameEl = document.getElementById("new-acc-name") as HTMLInputElement;
    const catEl = document.getElementById("new-acc-category") as HTMLSelectElement;
    const msgEl = document.getElementById("acc-msg")!;
    const name = nameEl.value.trim();
    msgEl.innerHTML = "";
    if (!name) {
      msgEl.innerHTML = `<div class="error">الاسم مطلوب.</div>`;
      return;
    }
    try {
      const category = catEl.value as AccountCategory;
      let account: Account;
      if (editingAccount) {
        account = { ...editingAccount, name };
      } else {
        const openEl = document.getElementById("new-acc-opening") as HTMLInputElement;
        const opening = Number(openEl.value) || 0;
        if (opening < 0) throw new Error("الرصيد الافتتاحي لا يجوز أن يكون سالبًا.");
        const code = await repo.getNextAccountCode(category);
        account = { id: nextId("acc"), name, category, openingBalance: opening, status: "active", code };
      }
      await repo.saveAccount(account);

      const currencyEl = document.getElementById("new-acc-currency") as HTMLSelectElement | null;
      if (currencyEl) {
        await repo.saveAccountCurrencyLink({ accountId: account.id, currencyCode: currencyEl.value });
      }

      const settings = buildPlanningSettingsFromForm(account.id, category);
      if (settings) {
        validatePlanningSettings(settings); // تحقق برمجي: لا تواريخ وهمية، لا سالب، لا حد أعلى أقل من الأدنى
        await repo.savePlanningSettings(settings);
      }

      editingAccountId = null;
      acctViewMode = "list";
      await renderAccountsBody(); // إعادة تحميل كاملة من قاعدة البيانات — لا تحديث محلي وهمي
    } catch (e) {
      msgEl.innerHTML = `<div class="error">${(e as Error).message}</div>`;
    }
  });
}

// ============================================================
// شاشة 2 — العمليات: كل عملية تُبنى عبر transactions.ts (قيد مزدوج حقيقي) ثم تُحفَظ عبر Repository.
// المرحلة 3: إعادة تصميم الدخول (قائمة أولًا، ثم "+" لفتح النموذج) ورقم عملية ظاهر —
// بلا أي تغيير في recordIncome/recordExpense/recordTransfer/recordDirectEntry أو منطق القيد.
// ============================================================
type TxViewMode = "list" | "form" | "detail";
let txViewMode: TxViewMode = "list";
let txDetailEntryId: string | null = null;
/**
 * false = النموذج يُنشئ عملية جديدة (كما كان دائمًا). true = النموذج يعدِّل العملية التي
 * يشير إليها txDetailEntryId حاليًا (الملاحظة 4) — نفس النموذج بالضبط، فقط مُعبَّأ ببيانات
 * العملية الحالية ومُوجَّه لمسار الحفظ المختلف (updateJournalEntryAndPersist بدل persist/
 * recordDirectEntryAndPersist). يُعاد لـfalse دائمًا عند مغادرة النموذج (نجاحًا أو إلغاءً).
 */
let txFormIsEdit = false;

async function renderTransactionsScreen() {
  // كل دخول جديد للتبويب (من القائمة العلوية) يبدأ من القائمة دائمًا — لا نموذج مباشرةً.
  txViewMode = "list";
  txDetailEntryId = null;
  txFormIsEdit = false;
  await renderTransactionsBody();
}

async function renderTransactionsBody() {
  if (txViewMode === "form") return renderTransactionForm();
  if (txViewMode === "detail") return renderTransactionDetail();
  return renderTransactionList();
}

async function renderTransactionList() {
  const withNumbers = await repo.getAllJournalEntriesWithDisplayNumbers();
  const accounts = await repo.getAllAccounts();
  const accName = (id: string) => accounts.find((a) => a.id === id)?.name || id;

  // الأحدث أولًا حسب تاريخ العملية، وترتيب مستقر عند تساوي التاريخ عبر id الداخلي
  // (id يتضمّن وقت الإنشاء الفعلي، فهو فاصل زمني موثوق دون أي اعتماد على operationNumber).
  const sorted = [...withNumbers].sort((a, b) => {
    if (a.entryDate !== b.entryDate) return a.entryDate < b.entryDate ? 1 : -1;
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  });

  const addButton = `<button id="btn-new-tx" class="fab-add" aria-label="إضافة عملية جديدة">+</button>`;

  const listHtml =
    sorted.length === 0
      ? `<div class="empty">
           <div>لا توجد عمليات بعد</div>
           <div class="muted" style="margin-top:6px;">ابدأ بإضافة أول عملية مالية</div>
         </div>`
      : `<div class="tx-list">${sorted.map((e) => renderTxRow(e, accName)).join("")}</div>`;

  mainEl.innerHTML = `
    <div class="card">
      <div class="row"><h2>العمليات</h2>${addButton}</div>
      ${listHtml}
    </div>
  `;

  document.getElementById("btn-new-tx")!.addEventListener("click", () => {
    txFormIsEdit = false;
    txDetailEntryId = null;
    txViewMode = "form";
    renderTransactionsBody();
  });
  document.querySelectorAll<HTMLElement>("[data-open-entry]").forEach((el) => {
    el.addEventListener("click", () => {
      txViewMode = "detail";
      txDetailEntryId = el.dataset.openEntry!;
      renderTransactionsBody();
    });
  });
}

function renderTxRow(e: JournalEntry & { displayOperationNumber: string }, accName: (id: string) => string): string {
  const amount = e.lines.filter((l) => l.direction === "DEBIT").reduce((s, l) => s + l.amount, 0);
  const typeLabel = TX_TYPE_LABELS[e.transactionType] || e.transactionType;
  const linesSummary = e.lines.map((l) => `${l.direction === "DEBIT" ? "مدين" : "دائن"}: ${accName(l.accountId)}`).join(" ← ");
  return `
    <div class="tx-row" data-open-entry="${e.id}">
      <div class="row">
        <span class="tag">#${e.displayOperationNumber}</span>
        <span class="muted">${e.entryDate}</span>
      </div>
      <div class="tx-row-main">
        <span class="tx-type">${typeLabel}</span>
        <span class="tx-amount">${fmt(amount)}</span>
      </div>
      <div class="muted">${linesSummary}</div>
      ${e.description ? `<div class="muted">${e.description}</div>` : ""}
    </div>`;
}

/** يُحدِّد أي قيمة من قائمة "نوع العملية" في النموذج تُطابق قيدًا موجودًا — للتعديل فقط (الملاحظة 4). */
function inferFormTypeForEntry(e: JournalEntry, accounts: Account[]): string {
  if (e.transactionType === "income") return "income";
  if (e.transactionType === "expense") return "expense";
  if (e.transactionType === "transfer") return "transfer";
  if (e.transactionType === "direct_entry") return "direct_entry";
  if (e.transactionType === "debt_payment") {
    const debitAcc = accounts.find((a) => a.id === e.lines.find((l) => l.direction === "DEBIT")?.accountId);
    if (debitAcc?.category === "recurring_debt") return "recurring_debt_payment";
    if (debitAcc?.category === "one_time_debt") return "one_time_debt_payment";
  }
  // نوع لا يُنشئه نموذج الإنشاء الحالي إطلاقًا (لا يحدث عبر الواجهة اليوم) — قيد مباشر عام
  // (بلا قيد فئة على أي طرف) هو الحل الآمن الوحيد المتاح لتعديله دون اختراع قواعد جديدة.
  return "direct_entry";
}

async function renderTransactionForm() {
  const accounts = await repo.getAllAccounts();
  const pots = accounts.filter((a) => a.category === "pot");
  const incomeSources = accounts.filter((a) => a.category === "income_source");
  const expenses = accounts.filter((a) => a.category === "expense");
  const recurringDebts = accounts.filter((a) => a.category === "recurring_debt");
  const oneTimeDebts = accounts.filter((a) => a.category === "one_time_debt");

  // وضع التعديل (الملاحظة 4): نفس النموذج بالضبط، مُعبَّأ ببيانات العملية الحالية —
  // txDetailEntryId يشير إليها (نفس المتغيّر المستخدَم لشاشة التفاصيل). id/periodId/رقم
  // العملية لا تُقرأ أبدًا من هذا النموذج عند الحفظ — Repository.updateJournalEntryAndPersist
  // تُثبِّتها من العملية الأصلية دائمًا، بصرف النظر عمّا يظهر هنا.
  const editingEntry = txFormIsEdit && txDetailEntryId ? await repo.getJournalEntry(txDetailEntryId) : null;
  const editingDisplayNumber = editingEntry
    ? (await repo.getAllJournalEntriesWithDisplayNumbers()).find((e) => e.id === editingEntry.id)?.displayOperationNumber ?? ""
    : "";
  const prefillDebitId = editingEntry?.lines.find((l) => l.direction === "DEBIT")?.accountId;
  const prefillCreditId = editingEntry?.lines.find((l) => l.direction === "CREDIT")?.accountId;
  const prefillAmount = editingEntry ? editingEntry.lines.filter((l) => l.direction === "DEBIT").reduce((s, l) => s + l.amount, 0) : undefined;
  const initialType = editingEntry ? inferFormTypeForEntry(editingEntry, accounts) : "income";

  const potOptions = (id?: string) => pots.map((p) => `<option value="${p.id}" ${p.id === id ? "selected" : ""}>${p.name}</option>`).join("");
  const accOptions = (list: Account[], id?: string) => list.map((s) => `<option value="${s.id}" ${s.id === id ? "selected" : ""}>${s.name}</option>`).join("");
  const suggestedNumber = editingEntry ? editingDisplayNumber : await repo.getNextOperationNumber();

  mainEl.innerHTML = `
    <div class="card">
      <div class="row">
        <h2>${editingEntry ? `تعديل العملية #${editingDisplayNumber}` : "عملية جديدة"}</h2>
        <button id="btn-cancel-tx" class="btn-secondary">رجوع</button>
      </div>
      <label>رقم العملية</label>
      <input id="tx-opnum" type="text" value="${suggestedNumber}" ${editingEntry ? "disabled" : ""} />
      ${editingEntry ? `<div class="muted" style="margin-top:-6px; margin-bottom:10px;">رقم العملية لا يتغيّر عند التعديل.</div>` : ""}
      <label>نوع العملية</label>
      <select id="tx-type">
        <option value="income" ${initialType === "income" ? "selected" : ""}>دخل</option>
        <option value="expense" ${initialType === "expense" ? "selected" : ""}>مصروف</option>
        <option value="transfer" ${initialType === "transfer" ? "selected" : ""}>تحويل بين أوعية</option>
        <option value="recurring_debt_payment" ${initialType === "recurring_debt_payment" ? "selected" : ""}>سداد دين مستمر</option>
        <option value="one_time_debt_payment" ${initialType === "one_time_debt_payment" ? "selected" : ""}>سداد دين لمرة واحدة</option>
        <option value="direct_entry" ${initialType === "direct_entry" ? "selected" : ""}>قيد مباشر</option>
      </select>
      <div id="tx-fields"></div>
      <label>المبلغ</label>
      <input id="tx-amount" type="number" min="0" step="0.01" value="${prefillAmount ?? ""}" />
      <label>التاريخ</label>
      <input id="tx-date" type="date" value="${editingEntry?.entryDate ?? new Date().toISOString().slice(0, 10)}" />
      <button class="primary" id="btn-submit-tx">${editingEntry ? "حفظ التعديلات" : "تسجيل العملية (قيد مزدوج)"}</button>
      <div id="tx-msg"></div>
    </div>
  `;

  document.getElementById("btn-cancel-tx")!.addEventListener("click", () => {
    txViewMode = editingEntry ? "detail" : "list";
    txFormIsEdit = false;
    renderTransactionsBody();
  });

  const typeEl = document.getElementById("tx-type") as HTMLSelectElement;
  const fieldsEl = document.getElementById("tx-fields")!;

  function renderFields() {
    const t = typeEl.value;
    if (t === "income") {
      fieldsEl.innerHTML = `
        <label>مصدر الدخل</label>
        <select id="tx-income-source">${incomeSources.length ? accOptions(incomeSources, prefillCreditId) : `<option value="">لا يوجد — أضف مصدر دخل أولًا من شاشة الحسابات</option>`}</select>
        <label>الوعاء المستلم</label>
        <select id="tx-pot">${potOptions(prefillDebitId)}</select>`;
    } else if (t === "expense") {
      fieldsEl.innerHTML = `
        <label>فئة المصروف</label>
        <select id="tx-expense-cat">${expenses.length ? accOptions(expenses, prefillDebitId) : `<option value="">لا يوجد — أضف فئة مصروف أولًا</option>`}</select>
        <label>الوعاء المدفوع منه</label>
        <select id="tx-pot">${potOptions(prefillCreditId)}</select>`;
    } else if (t === "transfer") {
      fieldsEl.innerHTML = `
        <label>من وعاء</label>
        <select id="tx-pot-from">${potOptions(prefillCreditId)}</select>
        <label>إلى وعاء</label>
        <select id="tx-pot-to">${potOptions(prefillDebitId)}</select>`;
    } else if (t === "recurring_debt_payment") {
      fieldsEl.innerHTML = `
        <label>الدين المستمر</label>
        <select id="tx-rdebt">${recurringDebts.length ? accOptions(recurringDebts, prefillDebitId) : `<option value="">لا يوجد</option>`}</select>
        <label>الوعاء المدفوع منه</label>
        <select id="tx-pot">${potOptions(prefillCreditId)}</select>`;
    } else if (t === "one_time_debt_payment") {
      fieldsEl.innerHTML = `
        <label>الدين لمرة واحدة</label>
        <select id="tx-odebt">${oneTimeDebts.length ? accOptions(oneTimeDebts, prefillDebitId) : `<option value="">لا يوجد</option>`}</select>
        <label>الوعاء المدفوع منه</label>
        <select id="tx-pot">${potOptions(prefillCreditId)}</select>`;
    } else if (t === "direct_entry") {
      // قيد مباشر بين أي حسابين — بلا حقل "الوعاء" إطلاقًا، والاختيار من كل الحسابات بغض النظر عن الفئة.
      const allAccountOptions = (id?: string) => accounts.map((a) => `<option value="${a.id}" ${a.id === id ? "selected" : ""}>${a.name} (${CATEGORY_LABELS[a.category]})</option>`).join("");
      fieldsEl.innerHTML = `
        <label>الحساب المدين</label>
        <select id="tx-direct-debit">${accounts.length ? allAccountOptions(prefillDebitId) : `<option value="">لا توجد حسابات — أضف حسابين على الأقل أولًا</option>`}</select>
        <label>الحساب الدائن</label>
        <select id="tx-direct-credit">${accounts.length ? allAccountOptions(prefillCreditId) : `<option value="">لا توجد حسابات — أضف حسابين على الأقل أولًا</option>`}</select>
        <label>الوصف (اختياري)</label>
        <input id="tx-direct-desc" type="text" placeholder="مثال: تسوية بين حسابين" value="${editingEntry?.description ?? ""}" />`;
    }
  }
  typeEl.addEventListener("change", renderFields);
  renderFields();

  document.getElementById("btn-submit-tx")!.addEventListener("click", async () => {
    const msgEl = document.getElementById("tx-msg")!;
    msgEl.innerHTML = "";
    const amount = Number((document.getElementById("tx-amount") as HTMLInputElement).value);
    const date = (document.getElementById("tx-date") as HTMLInputElement).value;
    const t = typeEl.value;
    try {
      if (!amount || amount <= 0) throw new Error("المبلغ يجب أن يكون رقمًا موجبًا.");
      if (!date) throw new Error("التاريخ مطلوب.");

      if (editingEntry) {
        // ------------ مسار التعديل (الملاحظة 4) ------------
        const periodId = editingEntry.periodId; // يبقى كما هو دائمًا — لا getActivePeriodId هنا إطلاقًا
        if (t === "income") {
          const source = accounts.find((a) => a.id === (document.getElementById("tx-income-source") as HTMLSelectElement).value);
          const pot = accounts.find((a) => a.id === (document.getElementById("tx-pot") as HTMLSelectElement).value);
          if (!source || !pot) throw new Error("يجب اختيار مصدر الدخل والوعاء.");
          await repo.updateJournalEntryAndPersist(editingEntry.id, recordIncome(source, pot, amount, date, periodId));
        } else if (t === "expense") {
          const cat = accounts.find((a) => a.id === (document.getElementById("tx-expense-cat") as HTMLSelectElement).value);
          const pot = accounts.find((a) => a.id === (document.getElementById("tx-pot") as HTMLSelectElement).value);
          if (!cat || !pot) throw new Error("يجب اختيار فئة المصروف والوعاء.");
          // رصيد الوعاء *باستثناء* النسخة القديمة من هذه العملية نفسها — تحقق حد صحيح عند التعديل.
          const potBalance = await repo.getAccountBalanceExcludingEntry(pot.id, editingEntry.id);
          await repo.updateJournalEntryAndPersist(editingEntry.id, recordExpense(cat, pot, amount, date, periodId, false, potBalance));
        } else if (t === "transfer") {
          const from = accounts.find((a) => a.id === (document.getElementById("tx-pot-from") as HTMLSelectElement).value);
          const to = accounts.find((a) => a.id === (document.getElementById("tx-pot-to") as HTMLSelectElement).value);
          if (!from || !to) throw new Error("يجب اختيار الوعاءين.");
          if (from.id === to.id) throw new Error("لا يمكن التحويل لنفس الوعاء.");
          await repo.updateJournalEntryAndPersist(editingEntry.id, recordTransfer(from, to, amount, date, periodId));
        } else if (t === "recurring_debt_payment") {
          const debt = accounts.find((a) => a.id === (document.getElementById("tx-rdebt") as HTMLSelectElement).value);
          const pot = accounts.find((a) => a.id === (document.getElementById("tx-pot") as HTMLSelectElement).value);
          if (!debt || !pot) throw new Error("يجب اختيار الدين والوعاء.");
          await repo.updateJournalEntryAndPersist(editingEntry.id, recordRecurringDebtPayment(debt, pot, amount, date, periodId));
        } else if (t === "one_time_debt_payment") {
          const debt = accounts.find((a) => a.id === (document.getElementById("tx-odebt") as HTMLSelectElement).value);
          const pot = accounts.find((a) => a.id === (document.getElementById("tx-pot") as HTMLSelectElement).value);
          if (!debt || !pot) throw new Error("يجب اختيار الدين والوعاء.");
          const currentBalance = await repo.getAccountBalanceExcludingEntry(debt.id, editingEntry.id);
          await repo.updateJournalEntryAndPersist(editingEntry.id, recordOneTimeDebtPayment(debt, pot, amount, date, periodId, currentBalance));
        } else if (t === "direct_entry") {
          const debitId = (document.getElementById("tx-direct-debit") as HTMLSelectElement).value;
          const creditId = (document.getElementById("tx-direct-credit") as HTMLSelectElement).value;
          const description = (document.getElementById("tx-direct-desc") as HTMLInputElement).value.trim() || undefined;
          if (!debitId || !creditId) throw new Error("يجب اختيار الحساب المدين والحساب الدائن.");
          if (debitId === creditId) throw new Error("لا يجوز اختيار الحساب نفسه للطرفين المدين والدائن.");
          await repo.updateDirectEntryAndPersist(editingEntry.id, debitId, creditId, amount, date, description);
        }
        txViewMode = "detail";
        txFormIsEdit = false;
        await renderTransactionsBody();
        return;
      }

      // ------------ مسار الإنشاء (كما كان دائمًا، بلا أي تغيير) ------------
      const opNumber = (document.getElementById("tx-opnum") as HTMLInputElement).value.trim();
      if (!opNumber) throw new Error("رقم العملية مطلوب.");
      if (await repo.isOperationNumberTaken(opNumber)) {
        throw new Error(`رقم العملية "${opNumber}" مستخدَم بالفعل لعملية أخرى — اختر رقمًا آخر.`);
      }

      if (t === "income") {
        const sourceId = (document.getElementById("tx-income-source") as HTMLSelectElement).value;
        const potId = (document.getElementById("tx-pot") as HTMLSelectElement).value;
        const source = accounts.find((a) => a.id === sourceId);
        const pot = accounts.find((a) => a.id === potId);
        if (!source || !pot) throw new Error("يجب اختيار مصدر الدخل والوعاء.");
        const periodId = await getActivePeriodId();
        const entry = recordIncome(source, pot, amount, date, periodId);
        entry.operationNumber = opNumber;
        await repo.persistJournalEntry(entry);
      } else if (t === "expense") {
        const catId = (document.getElementById("tx-expense-cat") as HTMLSelectElement).value;
        const potId = (document.getElementById("tx-pot") as HTMLSelectElement).value;
        const cat = accounts.find((a) => a.id === catId);
        const pot = accounts.find((a) => a.id === potId);
        if (!cat || !pot) throw new Error("يجب اختيار فئة المصروف والوعاء.");
        const potBalance = await repo.getAccountBalance(pot.id);
        const periodId = await getActivePeriodId();
        const entry = recordExpense(cat, pot, amount, date, periodId, false, potBalance);
        entry.operationNumber = opNumber;
        await repo.persistJournalEntry(entry);
      } else if (t === "transfer") {
        const fromId = (document.getElementById("tx-pot-from") as HTMLSelectElement).value;
        const toId = (document.getElementById("tx-pot-to") as HTMLSelectElement).value;
        const from = accounts.find((a) => a.id === fromId);
        const to = accounts.find((a) => a.id === toId);
        if (!from || !to) throw new Error("يجب اختيار الوعاءين.");
        if (from.id === to.id) throw new Error("لا يمكن التحويل لنفس الوعاء.");
        const periodId = await getActivePeriodId();
        const entry = recordTransfer(from, to, amount, date, periodId);
        entry.operationNumber = opNumber;
        await repo.persistJournalEntry(entry);
      } else if (t === "recurring_debt_payment") {
        const debtId = (document.getElementById("tx-rdebt") as HTMLSelectElement).value;
        const potId = (document.getElementById("tx-pot") as HTMLSelectElement).value;
        const debt = accounts.find((a) => a.id === debtId);
        const pot = accounts.find((a) => a.id === potId);
        if (!debt || !pot) throw new Error("يجب اختيار الدين والوعاء.");
        const periodId = await getActivePeriodId();
        const entry = recordRecurringDebtPayment(debt, pot, amount, date, periodId);
        entry.operationNumber = opNumber;
        await repo.persistJournalEntry(entry);
      } else if (t === "one_time_debt_payment") {
        const debtId = (document.getElementById("tx-odebt") as HTMLSelectElement).value;
        const potId = (document.getElementById("tx-pot") as HTMLSelectElement).value;
        const debt = accounts.find((a) => a.id === debtId);
        const pot = accounts.find((a) => a.id === potId);
        if (!debt || !pot) throw new Error("يجب اختيار الدين والوعاء.");
        const currentBalance = await repo.getAccountBalance(debt.id);
        const periodId = await getActivePeriodId();
        const entry = recordOneTimeDebtPayment(debt, pot, amount, date, periodId, currentBalance);
        entry.operationNumber = opNumber;
        await repo.persistJournalEntry(entry);
      } else if (t === "direct_entry") {
        const debitId = (document.getElementById("tx-direct-debit") as HTMLSelectElement).value;
        const creditId = (document.getElementById("tx-direct-credit") as HTMLSelectElement).value;
        const descEl = document.getElementById("tx-direct-desc") as HTMLInputElement;
        const description = descEl.value.trim() || undefined;
        if (!debitId || !creditId) throw new Error("يجب اختيار الحساب المدين والحساب الدائن.");
        if (debitId === creditId) throw new Error("لا يجوز اختيار الحساب نفسه للطرفين المدين والدائن.");
        const periodId = await getActivePeriodId();
        // بناء القيد وحفظه والتحقق من توافق العملة كلها عبر Repository (recordDirectEntryAndPersist)
        // — ليست بناءً محليًا في الواجهة ثم persistJournalEntry كبقية الأنواع، لأن هذا النوع وحده
        // يحتاج تحقق العملة قبل البناء.
        await repo.recordDirectEntryAndPersist(debitId, creditId, amount, date, periodId, description, opNumber);
      }
      // العودة إلى القائمة (الأحدث أولًا) بدل إعادة عرض النموذج — يطابق تصميم المرحلة 3.
      txViewMode = "list";
      await renderTransactionsBody();
    } catch (e) {
      msgEl.innerHTML = `<div class="error">${(e as Error).message}</div>`;
    }
  });
}

async function renderTransactionDetail() {
  const id = txDetailEntryId;
  const withNumbers = await repo.getAllJournalEntriesWithDisplayNumbers();
  const entry = withNumbers.find((e) => e.id === id);
  const accounts = await repo.getAllAccounts();
  const accName = (aid: string) => accounts.find((a) => a.id === aid)?.name || aid;

  if (!entry) {
    mainEl.innerHTML = `
      <div class="card">
        <div class="row"><h2>تفاصيل العملية</h2><button id="btn-back-detail" class="btn-secondary">رجوع</button></div>
        <div class="error">تعذَّر العثور على هذه العملية.</div>
      </div>`;
    document.getElementById("btn-back-detail")!.addEventListener("click", () => {
      txViewMode = "list";
      renderTransactionsBody();
    });
    return;
  }

  // الملاحظة 4: تعديل وحذف. editable يفحص فقط حالة فترة العملية (مغلقة أم لا) — القرار
  // الفعلي (الرفض عند فترة مغلقة) يحدث مرة أخرى داخل Repository نفسها عند الحفظ/الحذف
  // الفعليين، فهذا الفحص هنا مجرد تحسين واجهة (إخفاء/تعطيل الأزرار)، وليس نقطة الحماية الوحيدة.
  const editable = await repo.isEntryEditable(entry.id);
  const amount = entry.lines.filter((l) => l.direction === "DEBIT").reduce((s, l) => s + l.amount, 0);
  const typeLabel = TX_TYPE_LABELS[entry.transactionType] || entry.transactionType;
  const linesHtml = entry.lines
    .map((l) => `<div class="row"><span class="muted">${l.direction === "DEBIT" ? "مدين" : "دائن"}</span><span>${accName(l.accountId)} — ${fmt(l.amount)}</span></div>`)
    .join("");

  mainEl.innerHTML = `
    <div class="card">
      <div class="row"><h2>تفاصيل العملية</h2><button id="btn-back-detail" class="btn-secondary">رجوع</button></div>
      <div class="row"><span class="tag">#${entry.displayOperationNumber}</span><span class="muted">${entry.entryDate}</span></div>
      <div style="margin-top:10px;"><span class="tx-type">${typeLabel}</span></div>
      ${entry.description ? `<div class="muted" style="margin-top:6px;">${entry.description}</div>` : ""}
      <div style="margin-top:12px; font-weight:700;">${fmt(amount)}</div>
      <div class="muted" style="margin-top:14px;">تفاصيل القيد المحاسبي:</div>
      <div style="margin-top:6px;">${linesHtml}</div>
      ${
        editable
          ? `<div class="row" style="margin-top:16px;">
               <button id="btn-edit-tx" class="btn-secondary">تعديل</button>
               <button id="btn-delete-tx" class="btn-danger">حذف</button>
             </div>`
          : `<div class="muted" style="margin-top:16px;">هذه العملية ضمن فترة مغلقة — لا يمكن تعديلها أو حذفها.</div>`
      }
      <div id="tx-detail-msg"></div>
    </div>
  `;

  document.getElementById("btn-back-detail")!.addEventListener("click", () => {
    txViewMode = "list";
    renderTransactionsBody();
  });

  if (editable) {
    document.getElementById("btn-edit-tx")!.addEventListener("click", () => {
      txFormIsEdit = true;
      txViewMode = "form";
      renderTransactionsBody();
    });
    document.getElementById("btn-delete-tx")!.addEventListener("click", async () => {
      const confirmed = window.confirm(`سيتم حذف العملية #${entry.displayOperationNumber} نهائيًا ولا يمكن التراجع عن ذلك. هل أنت متأكد؟`);
      if (!confirmed) return;
      const msgEl = document.getElementById("tx-detail-msg")!;
      try {
        await repo.deleteJournalEntryAndPersist(entry.id);
        txViewMode = "list";
        txDetailEntryId = null;
        await renderTransactionsBody();
      } catch (e) {
        msgEl.innerHTML = `<div class="error">${(e as Error).message}</div>`;
      }
    });
  }
}

// ============================================================
// شاشة 3 — التوزيع: تشغيل محرك التوزيع الحقيقي على الحسابات المحمَّلة من التخزين
// ============================================================
const STAGE_LABELS: Record<number, string> = {
  0: "المرحلة 0 — العجز المرحّل",
  1: "المرحلة 1 — الحد الأدنى للمصروفات/الالتزامات غير القابلة للتأجيل",
  2: "المرحلة 2 — أهداف مهمة جدًا (الحد الأدنى)",
  3: "المرحلة 3 — رفع المصروفات نحو الحد الأعلى",
  4: "المرحلة 4 — استكمال الأهداف (الحد الأدنى)",
  5: "المرحلة 5 — سداد الديون لمرة واحدة",
  6: "المرحلة 6 — الدين المستمر (سداد إجباري / تخفيض الحد الأدنى)",
  7: "المرحلة 7 — رفع نهائي للمصروفات",
  8: "المرحلة 8 — الفائض النهائي → الاحتياطي",
};

/** تدرّج لوني حسب نسبة الاقتراب من الحد (§23 من المواصفة الأصلية) — عتبات ثابتة برمجيًا وليست عشوائية. */
function progressColor(pct: number): string {
  if (pct < 40) return "#0a5c3e"; // أخضر داكن
  if (pct < 60) return "#4caf7d"; // أخضر فاتح
  if (pct < 75) return "#d4c22a"; // أصفر
  if (pct < 90) return "#e08a2e"; // برتقالي
  if (pct < 100) return "#e0578f"; // وردي
  if (pct <= 110) return "#e0574a"; // أحمر فاتح
  return "#8c1f16"; // أحمر داكن — تجاوز الخطر
}

function progressBarHtml(label: string, value: number, limit: number): string {
  const pct = limit > 0 ? Math.min(140, Math.round((value / limit) * 100)) : 0;
  const color = progressColor(pct);
  const overLimit = limit > 0 && value > limit;
  return `
    <div style="margin-top:8px;">
      <div class="row muted" style="font-size:12px;"><span>${label}</span><span>${fmt(value)} / ${fmt(limit)}${overLimit ? " ⚠️ تجاوز" : ""}</span></div>
      <div style="background:#eee; border-radius:6px; height:10px; overflow:hidden;">
        <div style="width:${Math.min(100, pct)}%; background:${color}; height:100%;"></div>
      </div>
    </div>`;
}

async function renderDistributionScreen() {
  const accounts = await repo.getAllAccounts();
  const periodId = await getActivePeriodId();
  const periodEntries = await storage.getJournalEntriesForPeriod(periodId);

  mainEl.innerHTML = `
    <div class="card">
      <h2>تشغيل التوزيع</h2>
      <p class="muted">يُبنى من إعدادات التخطيط الحقيقية المحفوظة لكل حساب. النتيجة اقتراح تخطيطي فقط — لا يُغيِّر أي رصيد فعلي؛ المستخدم هو من ينفّذ العملية الفعلية لاحقًا.</p>
      <label>الدخل المتاح لهذه الفترة</label>
      <input id="dist-income" type="number" min="0" />
      <button class="primary" id="btn-run-dist">تشغيل المحرك</button>
    </div>
    <div id="dist-result"></div>
  `;

  document.getElementById("btn-run-dist")!.addEventListener("click", async () => {
    const resultEl = document.getElementById("dist-result")!;
    const income = Number((document.getElementById("dist-income") as HTMLInputElement).value) || 0;

    const { input, skippedAccounts } = await repo.buildDistributionInput(periodId, income);
    const result = repo.runDistributionPreview(input);
    const accName = (id: string) => accounts.find((a) => a.id === id)?.name || id;

    const skippedWarning = skippedAccounts.length
      ? `<div class="error">تنبيه: ${skippedAccounts.length} حساب مُستبعَد من هذا التوزيع لعدم وجود إعدادات تخطيط محفوظة له بعد: ${skippedAccounts.map(accName).join("، ")}. أضِف إعداداته من شاشة الحسابات.</div>`
      : "";

    // تجميع الأسطر حسب Stage 0-8 مع عرض السبب صراحةً لكل تخصيص (البند 9) — يُبنى دائمًا،
    // حتى في حالة نقص الدخل، لأن Stage 0 قد ينجح جزئيًا قبل توقف Stage 1 (مطابقة لِـresult.allocations الفعلية).
    const stageNumbers = Array.from(new Set(result.allocations.map((a) => a.stage))).sort((a, b) => a - b);
    const stageBlocks = stageNumbers
      .map((stageNum) => {
        const lines = result.allocations
          .filter((a) => a.stage === stageNum)
          .map((a) => `<tr><td>${accName(a.accountId)}</td><td>${fmt(a.amount)}</td></tr><tr><td colspan="2" class="muted" style="border-bottom:1px solid var(--border); padding-top:0;">${a.reasonText}</td></tr>`)
          .join("");
        return `<div class="card"><h2>${STAGE_LABELS[stageNum] ?? "المرحلة " + stageNum}</h2><table><tbody>${lines}</tbody></table></div>`;
      })
      .join("");

    if (result.insufficientAllocationReport) {
      const rep = result.insufficientAllocationReport;
      const perAccountRows = rep.perAccount
        .map(
          (a) => `<tr><td>${accName(a.accountId)}<div class="muted">${a.reasonNotFunded ?? ""}</div></td><td>${fmt(a.totalNeeded)}</td><td>${fmt(a.funded)}</td><td class="balance-neg">${fmt(a.remaining)}</td></tr>`
        )
        .join("");
      resultEl.innerHTML = `
        ${skippedWarning}
        <div class="card">
          <h2>⚠️ الدخل غير كافٍ — توقفت المراحل الاختيارية (2-8)</h2>
          <p class="muted">ما يلي هو ما نُفِّذ فعليًا قبل التوقف (قد يشمل تغطية جزئية أو كاملة لعجز مرحّل في المرحلة 0) — ثم التفصيل الكامل للنقص.</p>
          <div class="row"><span>إجمالي المطلوب</span><b>${fmt(rep.totalRequired)}</b></div>
          <div class="row"><span>الممول فعليًا</span><b>${fmt(rep.totalFunded)}</b></div>
          <div class="row"><span>غير الممول</span><b class="balance-neg">${fmt(rep.totalUnfunded)}</b></div>
          <table style="margin-top:10px;"><thead><tr><th>الحساب</th><th>المطلوب</th><th>المموَّل</th><th>المتبقي</th></tr></thead><tbody>${perAccountRows}</tbody></table>
        </div>
        ${stageBlocks}`;
      return;
    }


    const expenseAccounts = accounts.filter((a) => a.category === "expense");
    const progressBlocks = (
      await Promise.all(
        expenseAccounts.map(async (e) => {
          const s = await repo.getPlanningSettings(e.id);
          if (!s || s.kind !== "expense") return "";
          const plannedTotal = result.allocations.filter((a) => a.accountId === e.id).reduce((sum, a) => sum + a.amount, 0);
          const actualTotal = periodEntries.reduce((sum, en) => sum + en.lines.filter((l) => l.accountId === e.id && l.direction === "DEBIT").reduce((s2, l) => s2 + l.amount, 0), 0);
          const diff = actualTotal - plannedTotal;
          return `
          <div class="card">
            <h2>${e.name}</h2>
            ${progressBarHtml("المخطَّط مقابل الحد الأعلى", plannedTotal, s.monthlyMax)}
            ${progressBarHtml("الفعلي مقابل الحد الأعلى", actualTotal, s.monthlyMax)}
            <div class="row muted" style="margin-top:6px;"><span>الفارق (فعلي − مخطَّط)</span><span class="${diff > 0 ? "balance-neg" : "balance-pos"}">${diff > 0 ? "+" : ""}${fmt(diff)}</span></div>
          </div>`;
        })
      )
    ).join("");

    resultEl.innerHTML = `
      ${skippedWarning}
      ${stageBlocks}
      <div class="card">
        <div class="row"><span>المتبقي غير المخصَّص</span><b>${fmt(result.remainingAfterAllStages)}</b></div>
      </div>
      ${progressBlocks}
    `;
  });
}

// ============================================================
// شاشة 4 — إغلاق الشهر: تستخدم closePeriodAndPersist مباشرة
// ============================================================
async function renderClosingScreen() {
  const accounts = await repo.getAllAccounts();
  const periodId = await getActivePeriodId();
  const period = await repo.getPeriod(periodId);
  if (!period) return; // getActivePeriodId يضمن وجودها دائمًا عمليًا

  const relevant = accounts.filter((a) => ["expense", "goal", "one_time_debt", "recurring_debt", "reserve"].includes(a.category));
  const settingsList = await Promise.all(relevant.map((a) => repo.getPlanningSettings(a.id)));
  const banner = pendingClosingMessage ? `<div class="success">${pendingClosingMessage}</div>` : "";
  pendingClosingMessage = null;

  // الفعلي (Actual) لكل حساب لهذه الفترة يُحسب تلقائيًا من القيود الحقيقية ضمن نطاق الفترة — لا يُدخَل يدويًا أبدًا
  const periodEntries = await storage.getJournalEntriesForPeriod(periodId);
  function actualForAccount(accountId: string, category: string): number {
    // مجموع الحركة "الطبيعية" لهذا الحساب ضمن قيود هذه الفترة فقط (وليس الرصيد التراكمي الكلي)
    let sum = 0;
    for (const e of periodEntries) {
      for (const l of e.lines) {
        if (l.accountId !== accountId) continue;
        const isDebitNormal = category === "expense" || category === "goal" || category === "reserve";
        if (isDebitNormal) sum += l.direction === "DEBIT" ? l.amount : -l.amount;
        else sum += l.direction === "CREDIT" ? l.amount : -l.amount; // دين مستمر/لمرة واحدة (دائنة الطبيعة)
      }
    }
    return sum;
  }

  mainEl.innerHTML = `
    ${banner}
    <div class="card">
      <h2>الفترة الحالية: ${formatPeriodLabel(period)}</h2>
      <div class="muted">الحالة: ${period.status === "open" ? "مفتوحة" : "مغلقة"}</div>
    </div>
    ${
      period.status === "closed"
        ? `<div class="card"><div class="empty">هذه الفترة مغلقة بالفعل — سجل الإغلاق دائم ولا يُعاد حسابه (منع الإغلاق المكرر).</div></div>`
        : `<div class="card">
             <h2>إغلاق الفترة</h2>
             <p class="muted">المعتمد يُدخَل من الخطة، والفعلي محسوب تلقائيًا من القيود الحقيقية لهذه الفترة — الفائض/العجز المرحّل يُحسَب منهما تلقائيًا.</p>
             <div id="closing-fields">
               ${relevant
                 .map((a, i) => {
                   const s = settingsList[i];
                   const suggestedApproved = s?.kind === "expense" ? s.monthlyMin : s?.kind === "goal" ? s.minAllocation : 0;
                   const actual = actualForAccount(a.id, a.category);
                   return `
                 <div class="row" style="margin-top:8px; flex-wrap: wrap;">
                   <span style="flex:1 1 100%;">${a.name} <span class="muted">(${CATEGORY_LABELS[a.category]}) — الفعلي المحسوب: ${fmt(actual)}</span></span>
                   <input type="number" placeholder="معتمد" data-approved="${a.id}" value="${suggestedApproved || ""}" style="flex:1;" />
                   <input type="number" data-actual="${a.id}" value="${actual}" readonly style="flex:1; background:#f2f2f2;" />
                   ${
                     a.category === "expense" && actual < suggestedApproved
                       ? `<label style="flex:1 1 100%; font-size:12px;"><input type="checkbox" data-pending="${a.id}" style="width:auto; display:inline-block;" /> يوجد التزام/عملية مؤجَّلة مرتبطة — لا تُحرِّر الفائض كمال حر الآن</label>`
                       : ""
                   }
                 </div>`;
                 })
                 .join("")}
             </div>
             <button class="primary" id="btn-close-period">إغلاق الفترة الآن وترحيل الفائض/العجز</button>
             <div id="closing-msg"></div>
           </div>`
    }
    <div class="card">
      <h2>سجل الإغلاق لفترات سابقة</h2>
      <div id="closing-history">جارٍ التحميل…</div>
    </div>
  `;

  if (period.status === "open") {
    document.getElementById("btn-close-period")!.addEventListener("click", async () => {
      const msgEl = document.getElementById("closing-msg")!;
      try {
        const accountActuals = relevant.map((a) => {
          const approvedInput = document.querySelector<HTMLInputElement>(`[data-approved="${a.id}"]`)!;
          const actualInput = document.querySelector<HTMLInputElement>(`[data-actual="${a.id}"]`)!;
          const pendingInput = document.querySelector<HTMLInputElement>(`[data-pending="${a.id}"]`);
          return {
            account: a,
            approvedAmount: Number(approvedInput.value) || 0,
            actualAmount: Number(actualInput.value) || 0,
            hasPendingObligation: pendingInput?.checked ?? false,
          };
        });
        const nextPeriodId = "period_" + Date.now();
        const today = new Date().toISOString().slice(0, 10);
        const result = await repo.closePeriodAndPersist(period.id, nextPeriodId, accountActuals, { startDate: today, endDate: today });
        pendingClosingMessage = `أُغلقت الفترة بنجاح. عدد أسطر السجل التاريخي: ${result.summaryLines.length}. الفترة الجديدة المفتوحة تلقائيًا: ${formatPeriodLabel({ startDate: today, endDate: today })}`;
        await renderClosingScreen();
      } catch (e) {
        msgEl.innerHTML = `<div class="error">${(e as Error).message}</div>`;
      }
    });
  }

  await renderClosingHistory();
}

const CATEGORY_VARIANCE_LABELS: Record<string, Record<string, string>> = {
  expense: { surplus: "فائض مصروف", deficit: "عجز/تجاوز مصروف" },
  goal: { surplus: "فائض هدف", deficit: "عجز هدف" },
  one_time_debt: { surplus: "فائض سداد دين لمرة واحدة", deficit: "عجز سداد دين لمرة واحدة" },
  recurring_debt: { surplus: "فائض سداد دين مستمر", deficit: "عجز سداد دين مستمر" },
  reserve: { surplus: "فائض احتياطي", deficit: "عجز احتياطي" },
};

function effectOnNextPeriodText(l: { category: string; varianceType: string; releasedAsFreeCash: boolean; carriedToNextPeriodAsDeficit: boolean; carriedToNextPeriodAsSurplus: boolean }): string {
  if (l.category === "expense" && l.varianceType === "surplus") {
    return l.releasedAsFreeCash
      ? "تحرَّر كمال حر ضمن الدخل المتاح للفترة القادمة (freeCarriedSurplus)."
      : "معلَّق — لا يُحرَّر كمال حر بسبب التزام مؤجَّل مرتبط؛ يبقى في رصيد الوعاء فقط.";
  }
  if (l.category === "expense" && l.varianceType === "deficit") {
    return "يدخل المرحلة 0 (المجموعة 0.1 — المصروفات) بأولوية قصوى على هذا الحساب تحديدًا في الفترة القادمة.";
  }
  if (l.category === "goal") {
    return l.varianceType === "deficit"
      ? "يدخل المرحلة 0 (المجموعة 0.3 — الأهداف) بأولوية قصوى قبل أي تخصيص جديد لهذا الهدف."
      : "يخفِّض الحد الأدنى الفعلي المطلوب لنفس الهدف تلقائيًا في المرحلة 2/4 من الفترة القادمة.";
  }
  if (l.category === "one_time_debt") {
    return l.varianceType === "deficit"
      ? "يدخل المرحلة 0 (المجموعة 0.2 — الالتزامات) بأولوية قصوى في الفترة القادمة."
      : "ينعكس مباشرة في الرصيد الفعلي المنخفض أصلًا من الدفتر — لا ترحيل منفصل.";
  }
  if (l.category === "recurring_debt") {
    return l.varianceType === "deficit"
      ? "يدخل المرحلة 0 (المجموعة 0.2) فقط إن كان عجزًا عن خطة سابقة معتمَدة (نادر) — منفصل تمامًا عن آلية الحد الأدنى/الأعلى التي تُدار حيًا داخل المرحلة 6 من كل فترة."
      : "لا يُرحَّل بالمعنى التقليدي — أي فائض سداد يُعالَج فورًا ضمن نفس الفترة عبر المرحلة 6 (تخفيض الحد الأدنى ثم الرصيد)، راجع شاشة الخطة.";
  }
  if (l.category === "reserve") {
    return l.varianceType === "deficit" ? "يدخل المرحلة 0 (المجموعة 0.4 — الاحتياطي) في الفترة القادمة." : "ينعكس في رصيد الاحتياطي الفعلي مباشرة.";
  }
  return "";
}

async function renderClosingHistory() {
  const el = document.getElementById("closing-history");
  if (!el) return;
  const allPeriods = await storage.getAllFinancialPeriods();
  const closedPeriods = allPeriods.filter((p) => p.status === "closed");
  if (closedPeriods.length === 0) {
    el.innerHTML = `<div class="empty">لا توجد فترات مغلقة بعد.</div>`;
    return;
  }
  const accounts = await repo.getAllAccounts();
  const accName = (id: string) => accounts.find((a) => a.id === id)?.name || id;
  const parts: string[] = [];
  for (const p of closedPeriods) {
    const result = await repo.getPeriodCloseResult(p.id);
    if (!result) continue;
    const nextPeriod = allPeriods.find((x) => x.id === result.nextPeriodId);
    const meaningfulLines = result.summaryLines.filter((l) => l.varianceType !== "none");
    const rows = meaningfulLines
      .map((l) => {
        const label = CATEGORY_VARIANCE_LABELS[l.category]?.[l.varianceType] ?? `${l.varianceType} (${l.category})`;
        const carriedAmount = l.carriedToNextPeriodAsDeficit || l.carriedToNextPeriodAsSurplus ? fmt(l.varianceAmount) : l.releasedAsFreeCash ? fmt(l.varianceAmount) + " (تحرَّر فورًا)" : "0 (لم يُرحَّل)";
        return `
          <div class="row" style="flex-wrap:wrap; border-bottom:1px solid var(--border); padding-bottom:8px; margin-bottom:8px;">
            <span style="flex:1 1 100%; font-weight:600;">${accName(l.accountId)} — <span class="tag">${label}</span></span>
            <span class="muted" style="flex:1 1 100%;">معتمد: ${fmt(l.approvedAmount)} · فعلي: ${fmt(l.actualAmount)} · الفارق: ${fmt(l.varianceAmount)}</span>
            <span class="muted" style="flex:1 1 100%;">السبب: ${l.explanation}</span>
            <span class="muted" style="flex:1 1 100%;">المرحَّل للفترة القادمة: ${carriedAmount}</span>
            <span class="muted" style="flex:1 1 100%;">الأثر على التوزيع القادم: ${effectOnNextPeriodText(l)}</span>
          </div>`;
      })
      .join("");
    parts.push(`
      <div class="card">
        <h2>فترة ${formatPeriodLabel(p)} → ${nextPeriod ? formatPeriodLabel(nextPeriod) : "—"}</h2>
        ${rows || `<div class="empty">لا فروقات — كل شيء طابق المعتمَد تمامًا.</div>`}
      </div>`);
  }
  el.innerHTML = parts.join("");
}

// ============================================================
// شاشة الإعدادات (الملاحظة 1) — قسمان فقط: العملات، والنسخ الاحتياطي/الاستعادة.
// لا تلمس أي منطق قيد مزدوج أو توزيع أو إغلاق — كل التعديلات هنا تمر حصرًا عبر
// Repository.addCurrency / setDefaultCurrency / exportBackup / restoreBackup.
// ============================================================
async function renderSettingsScreen() {
  const currencies = await repo.getAllCurrencies();
  const defaultCurrency = await repo.getDefaultCurrency();

  const currenciesRowsHtml = currencies
    .map((c) => {
      const isDefault = c.code === defaultCurrency.code;
      return `
        <div class="row" style="margin-top:8px;">
          <span><b>${c.code}</b> — ${c.name} <span class="muted">(${c.symbol})</span>${isDefault ? ` <span class="tag">الافتراضية</span>` : ""}</span>
          ${isDefault ? "" : `<button data-set-default-currency="${c.code}" class="btn-secondary">اجعلها الافتراضية</button>`}
        </div>`;
    })
    .join("");

  mainEl.innerHTML = `
    <div class="card">
      <h2>العملات</h2>
      <p class="muted">العملة الافتراضية تُستخدَم فقط لاقتراح عملة مبدئية عند إنشاء بيانات جديدة — لا تُغيّر عملة أي حساب أو عملية موجودة بالفعل.</p>
      ${currenciesRowsHtml || `<div class="empty">لا توجد عملات بعد.</div>`}
      <div style="margin-top:16px; border-top:1px solid var(--border); padding-top:12px;">
        <label>اسم العملة</label>
        <input id="new-cur-name" placeholder="مثال: ريال يمني" />
        <label>كود العملة (ISO)</label>
        <input id="new-cur-code" placeholder="مثال: YER" maxlength="6" style="text-transform:uppercase;" />
        <label>رمز العرض</label>
        <input id="new-cur-symbol" placeholder="مثال: ﷼" />
        <button class="primary" id="btn-add-currency">إضافة عملة</button>
        <div id="currency-msg"></div>
      </div>
    </div>

    <div class="card">
      <h2>النسخ الاحتياطي والاستعادة</h2>
      <p class="muted">النسخة الاحتياطية تشمل كل بيانات التطبيق الفعلية (الحسابات، العمليات، الفترات، سجلات الإغلاق، إعدادات التخطيط، والعملات) — وليست إعدادات الواجهة فقط.</p>
      <button class="primary" id="btn-export-backup">إنشاء نسخة احتياطية</button>
      <div id="backup-export-area"></div>

      <div style="margin-top:16px; border-top:1px solid var(--border); padding-top:12px;">
        <p class="muted"><b>تحذير:</b> استعادة نسخة احتياطية تستبدل جميع البيانات الحالية بالكامل بمحتوى الملف المختار. لا يمكن التراجع عن هذا بعد التأكيد.</p>
        <button class="btn-secondary" id="btn-restore-backup">اختيار ملف نسخة احتياطية للاستعادة</button>
        <input type="file" id="restore-file-input" accept="application/json,.json" style="display:none;" />
        <div id="restore-msg"></div>
      </div>
    </div>
  `;

  document.querySelectorAll<HTMLElement>("[data-set-default-currency]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      try {
        await repo.setDefaultCurrency(btn.dataset.setDefaultCurrency!);
        await renderSettingsScreen();
      } catch (e) {
        const msgEl = document.getElementById("currency-msg")!;
        msgEl.innerHTML = `<div class="error">${(e as Error).message}</div>`;
      }
    });
  });

  document.getElementById("btn-add-currency")!.addEventListener("click", async () => {
    const nameEl = document.getElementById("new-cur-name") as HTMLInputElement;
    const codeEl = document.getElementById("new-cur-code") as HTMLInputElement;
    const symbolEl = document.getElementById("new-cur-symbol") as HTMLInputElement;
    const msgEl = document.getElementById("currency-msg")!;
    msgEl.innerHTML = "";
    try {
      await repo.addCurrency({ name: nameEl.value.trim(), code: codeEl.value.trim(), symbol: symbolEl.value.trim() });
      await renderSettingsScreen();
    } catch (e) {
      msgEl.innerHTML = `<div class="error">${(e as Error).message}</div>`;
    }
  });

  document.getElementById("btn-export-backup")!.addEventListener("click", async () => {
    const areaEl = document.getElementById("backup-export-area")!;
    try {
      const backup: BackupFile = await repo.exportBackup();
      const json = JSON.stringify(backup, null, 2);
      const fileName = `isnad-backup-${backup.exportedAt.replace(/[:.]/g, "-")}.json`;

      // محاولة تنزيل مباشر عبر Blob (تعمل كاملة في متصفح/PWA عادي). في بعض بيئات
      // WebView على أندرويد قد لا يُشغِّل هذا مدير تنزيل النظام تلقائيًا — لهذا نعرض
      // أيضًا المحتوى كنص قابل للنسخ اليدوي كحل بديل مضمون العمل في كل الحالات.
      try {
        const blob = new Blob([json], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
      } catch {
        // تجاهل فشل التنزيل المباشر — النص أدناه يبقى متاحًا دائمًا كبديل يدوي
      }

      areaEl.innerHTML = `
        <div class="success">تم إنشاء النسخة الاحتياطية (${fileName}). إن لم يبدأ التنزيل تلقائيًا، انسخ المحتوى أدناه واحفظه في ملف ‎.json يدويًا.</div>
        <label>محتوى النسخة الاحتياطية</label>
        <textarea id="backup-json-text" readonly rows="6" style="width:100%; font-family:monospace; font-size:12px; padding:8px; border:1px solid var(--border); border-radius:8px;">${json}</textarea>
      `;
    } catch (e) {
      areaEl.innerHTML = `<div class="error">تعذَّر إنشاء النسخة الاحتياطية: ${(e as Error).message}</div>`;
    }
  });

  const restoreInput = document.getElementById("restore-file-input") as HTMLInputElement;
  document.getElementById("btn-restore-backup")!.addEventListener("click", () => restoreInput.click());
  restoreInput.addEventListener("change", async () => {
    const msgEl = document.getElementById("restore-msg")!;
    msgEl.innerHTML = "";
    const file = restoreInput.files?.[0];
    if (!file) return;

    try {
      const text = await file.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error("الملف المختار ليس JSON صالحًا — تم رفضه دون أي تغيير في البيانات الحالية.");
      }

      // خطوة 1-2: تحقق كامل من البنية وتوافق schemaVersion قبل أي تأكيد أو أي لمس للتخزين
      const validated = validateBackupFile(parsed);

      // خطوة 4: تحذير واضح قبل الاستعادة الفعلية فقط بعد التأكد من صحة الملف
      const confirmed = window.confirm(
        `سيتم استبدال جميع البيانات الحالية بالكامل بمحتوى هذا الملف (تاريخ التصدير: ${validated.exportedAt}).\nهذا الإجراء لا يمكن التراجع عنه. هل تريد المتابعة؟`
      );
      if (!confirmed) {
        msgEl.innerHTML = `<div class="muted">أُلغيت عملية الاستعادة.</div>`;
        return;
      }

      // خطوة 5: الاستبدال الفعلي عبر storage.replaceAllData (ذرّي قدر الإمكان لكل تنفيذ تخزين)
      await repo.restoreBackup(validated);
      msgEl.innerHTML = `<div class="success">تمت الاستعادة بنجاح. أعِد فتح أي شاشة أخرى لرؤية البيانات المستعادة.</div>`;
    } catch (e) {
      msgEl.innerHTML = `<div class="error">${(e as Error).message}</div>`;
    } finally {
      restoreInput.value = "";
    }
  });
}

// ============================================================
// نقطة البداية
// ============================================================
// نضمن وجود عملة افتراضية واحدة على الأقل، وأن كل حساب قديم يملك كود مجموعة ثابتًا،
// قبل أول عرض — استدعاءان آمنان للتكرار ولا يُنشئان أي عملية أو بيانات مالية جديدة
// (انظر Repository.ensureDefaultCurrency وRepository.ensureAccountCodesAssigned).
(async () => {
  await repo.ensureDefaultCurrency();
  await repo.ensureAccountCodesAssigned();
  navigate("dashboard");
})();

// ============================================================
// تسجيل Service Worker — تخزين ملفات التطبيق فقط، لا علاقة له بـIndexedDB إطلاقًا.
// فشل التسجيل (متصفح لا يدعمه، أو بيئة اختبار بلا Service Worker) لا يمنع عمل التطبيق نفسه.
// ============================================================
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch((err) => {
      console.warn("تعذَّر تسجيل Service Worker (لا يمنع عمل التطبيق):", err);
    });
  });
}
