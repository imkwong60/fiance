/* J.Law Portfolio Tracking — Service Worker
 * 離線策略對齊 boardgame 水準：分層快取、API 不攔截、CDN 可離線
 * Cache: jlaw-portfolio-v2 (主) + jlaw-portfolio-cdn-v1 (第三方 SDK/樣式)
 */
const CACHE = 'jlaw-portfolio-v2';
const CDN_CACHE = 'jlaw-portfolio-cdn-v1';

/** 預快取核心（same-origin）。若實際 HTML 檔名不同，請改這裡並重新部署。 */
const CORE = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png'
];

// ---------- 判斷函式（分層策略用） ----------

/** Supabase REST / Auth：動態資料，絕對不攔截、不快取 */
function isSupabaseApi(url) {
  return (
    url.hostname.endsWith('.supabase.co') &&
    (url.pathname.includes('/rest/v1/') || url.pathname.includes('/auth/v1/'))
  );
}

/** 匯率 API：動態，不攔截 */
function isRateApi(url) {
  return url.hostname === 'open.er-api.com' || url.hostname.endsWith('er-api.com');
}

/** stock-sdk 動態 import（esm.sh）：行為複雜，直接放行 */
function isStockSdk(url) {
  return url.hostname === 'esm.sh' || url.hostname.endsWith('.esm.sh');
}

/** Supabase JS SDK（jsdelivr 固定路徑）：可 cache-first，離線才能初始化 client */
function isSupabaseSdk(url) {
  return (
    url.hostname === 'cdn.jsdelivr.net' &&
    url.pathname.includes('@supabase/supabase-js')
  );
}

/** Tailwind CDN：可快取以便離線有樣式（正式環境不建議用 CDN，此為 PWA 離線 workaround） */
function isTailwind(url) {
  return url.hostname === 'cdn.tailwindcss.com';
}

/** Lucide icons：可 cache-first；強烈建議 HTML 改固定版本而非 @latest */
function isLucide(url) {
  return url.hostname === 'unpkg.com' && url.pathname.includes('lucide');
}

/** Google Fonts CSS（若日後加上 link） */
function isFontCss(url) {
  return url.hostname === 'fonts.googleapis.com';
}

/** Google Fonts 字型檔 */
function isFontFile(url) {
  return url.hostname === 'fonts.gstatic.com';
}

/** 其他常見 CDN：預設 cache-first */
function isOtherCdn(url) {
  const hosts = [
    'cdn.jsdelivr.net',
    'unpkg.com',
    'cdnjs.cloudflare.com',
    'cdn.skypack.dev'
  ];
  return hosts.some((h) => url.hostname === h || url.hostname.endsWith('.' + h));
}

function isSameOrigin(url) {
  return url.origin === self.location.origin;
}

// ---------- Cache helpers ----------

async function cacheFirst(req, cacheName) {
  const cached = await caches.match(req);
  if (cached) return cached;
  try {
    const res = await fetch(req);
    if (res && res.ok) {
      const clone = res.clone();
      const cache = await caches.open(cacheName);
      await cache.put(req, clone);
    }
    return res;
  } catch (err) {
    // 離線且無 cache：回簡單 503，避免 unhandled rejection
    return new Response('Offline and not cached', {
      status: 503,
      statusText: 'Service Unavailable',
      headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    });
  }
}

/** network-first，失敗才用 cache（字型 CSS 用） */
async function networkFirst(req, cacheName) {
  try {
    const res = await fetch(req);
    if (res && res.ok) {
      const clone = res.clone();
      const cache = await caches.open(cacheName);
      await cache.put(req, clone);
    }
    return res;
  } catch (err) {
    const cached = await caches.match(req);
    if (cached) return cached;
    return new Response('Offline and not cached', {
      status: 503,
      statusText: 'Service Unavailable',
      headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    });
  }
}

/** same-origin：cache-first，成功後更新 cache；導航失敗時回 precache HTML */
async function sameOriginStrategy(req) {
  const cached = await caches.match(req);
  const fetchAndUpdate = fetch(req)
    .then((res) => {
      if (res && res.ok) {
        const clone = res.clone();
        caches.open(CACHE).then((cache) => cache.put(req, clone));
      }
      return res;
    })
    .catch(() => null);

  if (cached) {
    // 背景更新，先回 cache
    fetchAndUpdate.catch(() => {});
    return cached;
  }

  const networkRes = await fetchAndUpdate;
  if (networkRes) return networkRes;

  // 導航請求離線且 miss：回 precache HTML，避免白屏
  if (req.mode === 'navigate') {
    const fallback =
      (await caches.match('./index.html')) ||
      (await caches.match('./')) ||
      (await caches.match('./J.Law_Portfolio_Tracking.html'));
    if (fallback) return fallback;
  }

  return new Response('Offline', {
    status: 503,
    statusText: 'Service Unavailable',
    headers: { 'Content-Type': 'text/plain; charset=utf-8' }
  });
}

// ---------- Lifecycle ----------

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(CORE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  const allow = new Set([CACHE, CDN_CACHE]);
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => !allow.has(k)).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

// ---------- Fetch：分層分派 ----------

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // 非 GET 不攔截
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // 1. Supabase REST/Auth — 完全不攔截（動態 notepad_data 等）
  if (isSupabaseApi(url)) return;

  // 2. 匯率 API — 不攔截
  if (isRateApi(url)) return;

  // 3. stock-sdk (esm.sh) — 不攔截
  if (isStockSdk(url)) return;

  // 4. Supabase JS SDK — cache-first（離線可初始化 client）
  if (isSupabaseSdk(url)) {
    event.respondWith(cacheFirst(req, CDN_CACHE));
    return;
  }

  // 5. Tailwind CDN — cache-first
  if (isTailwind(url)) {
    event.respondWith(cacheFirst(req, CDN_CACHE));
    return;
  }

  // 6. Lucide — cache-first
  if (isLucide(url)) {
    event.respondWith(cacheFirst(req, CDN_CACHE));
    return;
  }

  // 7. Google Fonts CSS — network-first + fallback cache
  if (isFontCss(url)) {
    event.respondWith(networkFirst(req, CDN_CACHE));
    return;
  }

  // 8. Google Fonts 檔案 — cache-first
  if (isFontFile(url)) {
    event.respondWith(cacheFirst(req, CDN_CACHE));
    return;
  }

  // 9. 其他 CDN — cache-first
  if (isOtherCdn(url)) {
    event.respondWith(cacheFirst(req, CDN_CACHE));
    return;
  }

  // 10. 跨域其餘請求：不攔截（避免誤快取未知動態資源）
  if (!isSameOrigin(url)) return;

  // 11. same-origin 靜態資源 + 導航
  event.respondWith(sameOriginStrategy(req));
});
