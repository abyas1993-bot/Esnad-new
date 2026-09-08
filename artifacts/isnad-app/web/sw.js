// ============================================================
// إسناد — Service Worker مبدئي
// يخزّن فقط ملفات التطبيق الثابتة (Cache API). لا علاقة له بـIndexedDB إطلاقًا —
// بيانات المستخدم (الحسابات/القيود/الإعدادات) لا تُمس هنا بأي شكل، لا قراءة ولا حذف.
// ============================================================

// رقم إصدار الكاش: أي تغيير في ملفات التطبيق يتطلب زيادة هذا الرقم يدويًا لاحقًا
// حتى يُنزَّل الإصدار الجديد بدل الاستمرار في تقديم نسخة قديمة من الكاش.
const CACHE_VERSION = "isnad-cache-v1";

const APP_SHELL_URLS = [
  "index.html",
  "manifest.json",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/icon-maskable-512.png",
  "../web-dist/web/app.js",
  "../web-dist/src/distribution.js",
  "../web-dist/src/ledger.js",
  "../web-dist/src/period.js",
  "../web-dist/src/recurringDebt.js",
  "../web-dist/src/reports.js",
  "../web-dist/src/repository.js",
  "../web-dist/src/storage.js",
  "../web-dist/src/transactions.js",
  "../web-dist/src/types.js",
  "../web-dist/src/variance.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(APP_SHELL_URLS))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    // حذف نسخ الكاش القديمة فقط (ملفات التطبيق) — لا علاقة بهذا بقاعدة بيانات IndexedDB إطلاقًا،
    // فهي مخزَّن منفصل تمامًا يديره المتصفح ولا يُلمَس أبدًا من كود الكاش هذا.
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request)
        .then((response) => {
          // تخزين نسخة من أي ملف جديد يُطلَب بنجاح (لتغطية ملفات لم تكن في القائمة الأصلية)
          if (response && response.status === 200 && response.type === "basic") {
            const clone = response.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => cached); // لا اتصال ولا كاش لهذا الملف — يفشل الطلب بصمت (متوقَّع لملفات غير أساسية)
    })
  );
});
