/* 惡搞棋院 service worker — beta1.0
   刻意只接管「頁面導覽」請求做離線後備。
   API（POST /api/*）、socket.io 連線、CDN、字型一律「不攔截」，直接走網路，
   所以絕不會弄壞登入 / 對局 / 線上連線，也不會回傳過期的 API 資料。 */
const CACHE = 'chess-academy-beta1_0';
const SHELL = ['./', './index.html', './manifest.json', './icon-192.png', './icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting())   // 就算某個殼資源抓不到也不擋安裝
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;                 // 不碰 POST（API 全部放行）
  if (req.mode === 'navigate') {
    // 開頁 / 重新整理：先連網拿最新版，沒網路才用快取的殼（離線也打得開）
    e.respondWith(fetch(req).catch(() => caches.match('./index.html')));
  }
  // 其餘請求（/api/*、socket.io、字型、CDN…）不處理，交給瀏覽器預設網路行為
});
