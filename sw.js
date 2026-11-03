/* J.Law Portfolio Tracking — Service Worker v4
 * - App shell 逐個 cache + offline-fallback.css
 * - 關鍵 CDN install 預拉 + cache-first（多種 URL match）
 * - Supabase REST/Auth、匯率、esm.sh：不攔截
 */
const CACHE = 'jlaw-portfolio-v4';
const CDN_CACHE = 'jlaw-portfolio-cdn-v4';

const CORE = [
  './',
  './index.html',
  './manifest.webmanifest',
  './sw.js',
  './offline-fallback.css',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png',
  './favicon.ico'
];

const CRITICAL_CDN = [
  'https://cdn.tailwindcss.com',
  'https://unpkg.com/lucide@0.460.0',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2'
];

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
  return url.hostname === 'cdn.jsdelivr.net' && url.pathname.includes('@supabase/supabase-js');
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
  const hosts = ['cdn.jsdelivr.net', 'unpkg.com', 'cdnjs.cloudflare.com', 'cdn.skypack.dev'];
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

async function cacheOne(cache, url) {
  try {
    const res = await fetch(url, { cache: 'reload', credentials: 'omit', mode: 'cors' });
    if (res && (res.ok || res.type === 'opaque')) {
      await cache.put(url, res.clone ? res.clone() : res);
      return true;
    }
  } catch (_) {}
  return false;
}

async function matchCache(req, cacheName) {
  const url = typeof req === 'string' ? req : req.url;
  const cache = await caches.open(cacheName);
  return (
    (await cache.match(req)) ||
    (await cache.match(url)) ||
    (await caches.match(req)) ||
    (await caches.match(url))
  );
}

async function cacheFirst(req, cacheName) {
  const cached = await matchCache(req, cacheName);
  if (cached) return cached;
  try {
    const res = await fetch(req, { credentials: 'omit' });
    if (res && res.ok) {
      const clone = res.clone();
      const cache = await caches.open(cacheName);
      await cache.put(req, clone);
      try { await cache.put(req.url, res.clone()); } catch (_) {}
    }
    return res;
  } catch (_) {
    const again = await matchCache(req, cacheName);
    if (again) return again;
    return new Response('Offline and not cached', {
      status: 503,
      statusText: 'Service Unavailable',
      headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    });
  }
}

async function networkFirst(req, cacheName) {
  try {
    const res = await fetch(req, { credentials: 'omit' });
    if (res && res.ok) {
      const clone = res.clone();
      const cache = await caches.open(cacheName);
      await cache.put(req, clone);
    }
    return res;
  } catch (_) {
    const cached = await matchCache(req, cacheName);
    if (cached) return cached;
    return new Response('Offline and not cached', {
      status: 503,
      statusText: 'Service Unavailable',
      headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    });
  }
}

async function sameOriginStrategy(req, event) {
  const cached = await caches.match(req) || await caches.match(req.url);
  const fetchAndUpdate = fetch(req)
    .then((res) => {
      if (res && res.ok) {
        const clone = res.clone();
        const p = caches.open(CACHE).then((c) => c.put(req, clone));
        if (event && event.waitUntil) event.waitUntil(p);
        else p.catch(() => {});
      }
      return res;
    })
    .catch(() => null);

  if (cached) {
    fetchAndUpdate.catch(() => {});
    return cached;
  }
  const networkRes = await fetchAndUpdate;
  if (networkRes) return networkRes;

  if (isNavigation(req)) {
    const fallback =
      (await caches.match('./index.html')) ||
      (await caches.match('./')) ||
      (await caches.match('/index.html'));
    if (fallback) return fallback;
    return new Response(
      '<!DOCTYPE html><html lang="zh-TW"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>離線</title></head><body style="font-family:system-ui;padding:2rem;text-align:center;background:#0f172a;color:#e2e8f0"><h1>離線模式</h1><p>請先在有網路時開啟一次，完成快取後再離線使用。</p></body></html>',
      { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
    );
  }
  return new Response('Offline', {
    status: 503,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' }
  });
}

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
      await Promise.all(keys.filter((k) => !allow.has(k)).map((k) => caches.delete(k)));
      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (isSupabaseApi(url)) return;
  if (isRateApi(url)) return;
  if (isStockSdk(url)) return;

  if (isSupabaseSdk(url) || isTailwind(url) || isLucide(url)) {
    event.respondWith(cacheFirst(req, CDN_CACHE));
    return;
  }
  if (isFontCss(url)) {
    event.respondWith(networkFirst(req, CDN_CACHE));
    return;
  }
  if (isFontFile(url) || isOtherCdn(url)) {
    event.respondWith(cacheFirst(req, CDN_CACHE));
    return;
  }
  if (!isSameOrigin(url)) return;
  event.respondWith(sameOriginStrategy(req, event));
});
