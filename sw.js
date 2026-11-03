/* J.Law Portfolio Tracking — Service Worker
 * 離線策略（對齊分享本本 v3 + 原有分層 API 策略）：
 * - App shell：逐個 cache（唔用會全死嘅 addAll）
 * - 關鍵 CDN：install 預拉 + cache-first（Tailwind / Lucide / Supabase SDK）
 * - Supabase REST/Auth、匯率 API、esm.sh：完全不攔截
 * - 導航：cache-first + 離線 fallback index.html
 * Cache: jlaw-portfolio-v3 (主) + jlaw-portfolio-cdn-v3 (第三方)
 */
const CACHE = 'jlaw-portfolio-v3';
const CDN_CACHE = 'jlaw-portfolio-cdn-v3';

/** 預快取核心（same-origin）。缺檔唔會令整個 install 失敗。 */
const CORE = [
  './',
  './index.html',
  './manifest.webmanifest',
  './sw.js',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png',
  './favicon.ico'
];

/** 關鍵 CDN：首次在線時寫入，離線先有樣式 / 圖示 / Supabase client */
const CRITICAL_CDN = [
  'https://cdn.tailwindcss.com',
  'https://unpkg.com/lucide@0.460.0',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2'
];

// ---------- 判斷函式 ----------

function isSupabaseApi(url) {
  return (
    url.hostname.endsWith('.supabase.co') &&
    (url.pathname.includes('/rest/v1/') || url.pathname.includes('/auth/v1/'))
  );
}

function isRateApi(url) {
  return url.hostname === 'open.er-api.com' || url.hostname.endsWith('er-api.com');
}

function isStockSdk(url) {
  return url.hostname === 'esm.sh' || url.hostname.endsWith('.esm.sh');
}

function isSupabaseSdk(url) {
  return (
    url.hostname === 'cdn.jsdelivr.net' &&
    url.pathname.includes('@supabase/supabase-js')
  );
}

function isTailwind(url) {
  return url.hostname === 'cdn.tailwindcss.com';
}

function isLucide(url) {
  return url.hostname === 'unpkg.com' && url.pathname.includes('lucide');
}

function isFontCss(url) {
  return url.hostname === 'fonts.googleapis.com';
}

function isFontFile(url) {
  return url.hostname === 'fonts.gstatic.com';
}

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

function isNavigation(request) {
  return (
    request.mode === 'navigate' ||
    (request.method === 'GET' &&
      (request.headers.get('accept') || '').includes('text/html'))
  );
}

// ---------- Cache helpers ----------

async function cacheOne(cache, url) {
  try {
    const res = await fetch(url, { cache: 'reload' });
    if (res && res.ok) {
      await cache.put(url, res);
      return true;
    }
  } catch (_) {}
  return false;
}

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
  } catch (_) {
    // 試 URL 字串 match（redirect / 變體）
    const byUrl = await caches.match(new URL(req.url).href);
    if (byUrl) return byUrl;
    return new Response('Offline and not cached', {
      status: 503,
      statusText: 'Service Unavailable',
      headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    });
  }
}

async function networkFirst(req, cacheName) {
  try {
    const res = await fetch(req);
    if (res && res.ok) {
      const clone = res.clone();
      const cache = await caches.open(cacheName);
      await cache.put(req, clone);
    }
    return res;
  } catch (_) {
    const cached = await caches.match(req);
    if (cached) return cached;
    return new Response('Offline and not cached', {
      status: 503,
      statusText: 'Service Unavailable',
      headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    });
  }
}

async function sameOriginStrategy(req, event) {
  const cached = await caches.match(req);

  const fetchAndUpdate = fetch(req)
    .then((res) => {
      if (res && res.ok) {
        const clone = res.clone();
        const p = caches.open(CACHE).then((cache) => cache.put(req, clone));
        if (event && event.waitUntil) event.waitUntil(p);
        else p.catch(() => {});
      }
      return res;
    })
    .catch(() => null);

  if (cached) {
    // 背景更新
    fetchAndUpdate.catch(() => {});
    return cached;
  }

  const networkRes = await fetchAndUpdate;
  if (networkRes) return networkRes;

  // 導航離線 miss → precache HTML，避免白屏
  if (isNavigation(req)) {
    const fallback =
      (await caches.match('./index.html')) ||
      (await caches.match('./')) ||
      (await caches.match('/index.html')) ||
      (await caches.match('./J.Law_Portfolio_Tracking.html'));
    if (fallback) return fallback;
    return new Response(
      '<!DOCTYPE html><html lang="zh-TW"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>離線</title></head><body style="font-family:system-ui;padding:2rem;text-align:center;background:#0f172a;color:#e2e8f0"><h1>離線模式</h1><p>請先在有網路時開啟一次本 App，讓資源完成快取後再離線使用。</p></body></html>',
      { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
    );
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
    (async () => {
      const cache = await caches.open(CACHE);
      await Promise.all(CORE.map((u) => cacheOne(cache, u)));

      const cdnCache = await caches.open(CDN_CACHE);
      await Promise.all(CRITICAL_CDN.map((u) => cacheOne(cdnCache, u)));

      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  const allow = new Set([CACHE, CDN_CACHE]);
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((k) => !allow.has(k)).map((k) => caches.delete(k))
      );
      await self.clients.claim();
    })()
  );
});

// ---------- Fetch：分層分派 ----------

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // 1. Supabase REST/Auth — 完全不攔截
  if (isSupabaseApi(url)) return;

  // 2. 匯率 API — 不攔截
  if (isRateApi(url)) return;

  // 3. stock-sdk (esm.sh) — 不攔截（頁面已有 .catch 降級手動填價）
  if (isStockSdk(url)) return;

  // 4. Supabase JS SDK — cache-first
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

  // 7. Google Fonts CSS — network-first + cache fallback
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

  // 10. 其餘跨域：不攔截
  if (!isSameOrigin(url)) return;

  // 11. same-origin 靜態資源 + 導航
  event.respondWith(sameOriginStrategy(req, event));
});
