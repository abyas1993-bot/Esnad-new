// ============================================================
// إسناد — نظام العملات المتعددة (Multi-Currency)
// كيان مستقل تمامًا عن محرك القيود (ledger.ts) — لا يُغيّر منطق التوازن المحاسبي
// ولا طريقة حساب الأرصدة. كل حساب يُربط اختياريًا بعملة عبر AccountCurrencyLink؛
// الحساب بلا رابط صريح يُعامَل بالعملة الافتراضية عند العرض فقط.
// لا يوجد هنا أي تحويل عملات أو أسعار صرف — هذا خارج نطاق هذه المرحلة عمدًا (§9 و§10
// من مواصفة هذه المرحلة)، ولا يُسمح بقيد مباشر بين عملتين مختلفتين ما دام FX غير موجود.
// ============================================================

export interface Currency {
  code: string; // مثال: "SAR" — معرّف فريد للعملة
  name: string; // مثال: "ريال سعودي"
  symbol: string; // مثال: "ر.س" — يُعرض بجانب الأرصدة في الواجهة
  /**
   * هل هذه هي "العملة الافتراضية للتطبيق" التي يختارها المستخدم من الإعدادات؟ (الملاحظة 1).
   * حقل اختياري بحت لا علاقة له بـ DEFAULT_CURRENCY أدناه (وهي عملة البداية الثابتة SAR فقط،
   * ولا تتغيّر أبدًا). يُستخدَم فقط لاقتراح عملة مبدئية عند إنشاء بيانات جديدة تحتاج اختيار
   * عملة — لا يُغيّر عملة أي حساب أو قيد قديم بأي شكل (انظر Repository.getAccountCurrency
   * التي تبقى معتمِدة على DEFAULT_CURRENCY الثابتة للبيانات القديمة بلا رابط صريح، لا هذا الحقل).
   * يجب ألا تحمل أكثر من عملة واحدة `isDefault: true` في نفس الوقت — Repository.setDefaultCurrency
   * هي الطريقة الوحيدة المعتمَدة لضمان ذلك.
   */
  isDefault?: boolean;
}

export class DuplicateCurrencyCodeError extends Error {
  constructor(code: string) {
    super(`عملة بنفس الكود (${code}) موجودة بالفعل — لا يجوز إضافة عملة بكود مكرر.`);
    this.name = "DuplicateCurrencyCodeError";
  }
}

/**
 * تحقق من صحة مدخلات عملة جديدة قبل الحفظ (الملاحظة 1، §2 "التحقق من المدخلات قبل الحفظ").
 * لا يتحقق من التكرار هنا (ذلك يتطلب قراءة من التخزين) — انظر Repository.addCurrency.
 */
export function validateCurrencyInput(currency: Currency): void {
  const code = currency.code?.trim() ?? "";
  const name = currency.name?.trim() ?? "";
  const symbol = currency.symbol?.trim() ?? "";
  if (!code) throw new Error("كود العملة مطلوب.");
  if (!/^[A-Za-z]{2,6}$/.test(code)) {
    throw new Error(`كود العملة غير صالح: "${currency.code}" — يجب أن يتكوّن من 2 إلى 6 أحرف لاتينية فقط (مثال: SAR، YER، OMR).`);
  }
  if (!name) throw new Error("اسم العملة مطلوب.");
  if (!symbol) throw new Error("رمز عرض العملة مطلوب.");
}

export interface AccountCurrencyLink {
  accountId: string;
  currencyCode: string;
}

/**
 * العملة الافتراضية — تُستخدَم للعرض فقط لأي حساب بلا رابط عملة صريح.
 * توفيرها لا يُنشئ أي بيانات مالية أو عمليات افتراضية للمستخدم؛
 * هي سجل مرجعي (Currency) وحده، وليست حسابًا أو قيدًا.
 */
export const DEFAULT_CURRENCY: Currency = {
  code: "SAR",
  name: "ريال سعودي",
  symbol: "ر.س",
};
