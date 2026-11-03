/* J.Law Portfolio Tracking — Service Worker v5
 * UI 完全本機化：tailwind-built.css / lucide.min.js / supabase.min.js
 * 離線可見完整原本介面；動態 API 仍不攔截
 */
const CACHE = 'jlaw-portfolio-v5';

const CORE = [
  './',
  './index.html',
  './manifest.webmanifest',
  './sw.js',
  './tailwind-built.css',
  './lucide.min.js',
  './supabase.min.js',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png',
  './favicon.ico'
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
    const res = await fetch(url, { cache: 'reload' });
    if (res && res.ok) {
      await cache.put(url, res);
      return true;
    }
  } catch (_) {}
  return false;
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      await Promise.all(CORE.map((u) => cacheOne(cache, u)));
      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // 動態 API / 報價 SDK：不攔截
  if (isSupabaseApi(url) || isRateApi(url) || isStockSdk(url)) return;

  // 其餘跨域（若仍有）不攔截
  if (!isSameOrigin(url)) return;

  // same-origin：cache-first + 背景更新
  event.respondWith(
    (async () => {
      const cached = await caches.match(req);

      const networkPromise = fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            event.waitUntil(caches.open(CACHE).then((c) => c.put(req, copy)));
          }
          return res;
        })
        .catch(() => null);

      if (cached) {
        networkPromise.catch(() => {});
        return cached;
      }

      const net = await networkPromise;
      if (net) return net;

      if (isNavigation(req)) {
        return (
          (await caches.match('./index.html')) ||
          (await caches.match('./')) ||
          new Response(
            '<!DOCTYPE html><html><body style="font-family:system-ui;padding:2rem;background:#0f172a;color:#fff;text-align:center"><h1>離線</h1><p>請先在有網路時開啟一次完成快取。</p></body></html>',
            { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
          )
        );
      }
      return new Response('Offline', { status: 503 });
    })()
  );
});
