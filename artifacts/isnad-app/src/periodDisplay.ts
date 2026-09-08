// ============================================================
// إسناد — تسمية عرض الفترات (الملاحظة 2، §1)
// ملف عرض بحت (pure): لا يقرأ أو يكتب أي تخزين، ولا علاقة له بمنطق فتح/إغلاق الفترات في
// period.ts (لم يُلمَس إطلاقًا). الغرض الوحيد: تحويل startDate/endDate (بصيغة ISO كما تُخزَّن
// فعليًا) إلى نص عربي مفهوم للمستخدم، بدل عرض المعرّف الداخلي period_<timestamp> مباشرة.
// يدعم أي نطاق زمني تعسفي، وليس الأشهر فقط — إن كان النطاق شهرًا تقويميًا كاملًا بالضبط
// (من اليوم الأول إلى آخر يوم في نفس الشهر) يُعرض بصيغة "الشهر السنة" المختصرة، وإلا يُعرض
// المدى الكامل "DD الشهر YYYY – DD الشهر YYYY". المعرّف الداخلي في التخزين لا يتغيّر أبدًا.
// ============================================================

const ARABIC_MONTH_NAMES = [
  "يناير",
  "فبراير",
  "مارس",
  "أبريل",
  "مايو",
  "يونيو",
  "يوليو",
  "أغسطس",
  "سبتمبر",
  "أكتوبر",
  "نوفمبر",
  "ديسمبر",
];

interface ParsedIsoDate {
  year: number;
  month: number; // 1-12
  day: number;
}

/** يفكّك تاريخًا بصيغة ISO "YYYY-MM-DD" (كما تُخزَّن startDate/endDate فعليًا) بلا أي منطقة زمنية. */
function parseIsoDate(iso: string): ParsedIsoDate {
  const [y, m, d] = iso.split("-").map((part) => Number(part));
  return { year: y, month: m, day: d };
}

/** عدد أيام شهر ميلادي مُعطى (يراعي السنوات الكبيسة تلقائيًا عبر Date.UTC). */
function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function formatSingleDate(d: ParsedIsoDate): string {
  const dayPadded = String(d.day).padStart(2, "0");
  return `${dayPadded} ${ARABIC_MONTH_NAMES[d.month - 1]} ${d.year}`;
}

/**
 * يبني اسم عرض مفهومًا لفترة مالية من حدودها الزمنية فقط — لا يقرأ أو يحتاج المعرّف الداخلي.
 * أمثلة:
 *   { startDate: "2026-09-01", endDate: "2026-09-30" } → "سبتمبر 2026"
 *   { startDate: "2026-09-01", endDate: "2026-09-15" } → "01 سبتمبر 2026 – 15 سبتمبر 2026"
 */
export function formatPeriodLabel(period: { startDate: string; endDate: string }): string {
  const start = parseIsoDate(period.startDate);
  const end = parseIsoDate(period.endDate);

  const isFullCalendarMonth =
    start.year === end.year && start.month === end.month && start.day === 1 && end.day === daysInMonth(end.year, end.month);

  if (isFullCalendarMonth) {
    return `${ARABIC_MONTH_NAMES[start.month - 1]} ${start.year}`;
  }

  return `${formatSingleDate(start)} – ${formatSingleDate(end)}`;
}
