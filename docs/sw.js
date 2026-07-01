/* Service Worker — uygulamayı offline çalıştırır (app shell önbelleği).
   Kod güncellendiğinde CACHE sürümünü artır (v1 → v2 ...). */

const CACHE = "ciftlik-v7";

const VARLIKLAR = [
  "index.html",
  "tablo.html",
  "style.css",
  "store.js",
  "app.js",
  "tablo.js",
  "etiket.js",
  "manifest.webmanifest",
  "icon-192.png",
  "icon-512.png",
  "vendor/leaflet.js",
  "vendor/leaflet.css",
  "vendor/leaflet-geoman.min.js",
  "vendor/leaflet-geoman.css",
  "vendor/jspdf.umd.min.js",
  "vendor/qrcode.js",
  "vendor/images/marker-icon.png",
  "vendor/images/marker-icon-2x.png",
  "vendor/images/marker-shadow.png",
  "vendor/images/layers.png",
  "vendor/images/layers-2x.png",
];

self.addEventListener("install", (e) => {
  // Her varlığı tek tek ekle: biri inmezse (allSettled) kurulum bozulmasın.
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => Promise.allSettled(VARLIKLAR.map((u) => c.add(u))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  e.respondWith(
    caches.match(req).then(
      (hit) =>
        hit ||
        fetch(req)
          .then((res) => {
            const kopya = res.clone();
            caches.open(CACHE).then((c) => {
              try { c.put(req, kopya); } catch (_) {}
            });
            return res;
          })
          .catch(() => caches.match("index.html"))
    )
  );
});
