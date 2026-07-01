/* Tarla Haritası — ağaç noktaları, cinsler, sulama, hasat, çizim.
   Leaflet (CRS.Simple) + Leaflet-Geoman kullanır. */

"use strict";

// ----------------------------------------------------------------------------
// Küçük yardımcılar
// ----------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);

// Offline sürüm: sunucu yerine tarayıcıdaki IndexedDB (store.js) kullanılır.
async function api(url, options = {}) {
  return window.localApi(url, options);
}

const bugun = () => new Date().toISOString().slice(0, 10);

// ISO tarihi (yyyy-mm-dd) Türkçe biçime çevir: gg.aa.yyyy
function trTarih(iso) {
  if (!iso) return "";
  const p = String(iso).slice(0, 10).split("-");
  return p.length === 3 ? `${p[2]}.${p[1]}.${p[0]}` : iso;
}

function yasHesapla(dikimTarihi) {
  if (!dikimTarihi) return "";
  const d = new Date(dikimTarihi);
  if (isNaN(d)) return "";
  const gun = (new Date() - d) / (1000 * 60 * 60 * 24);
  if (gun < 0) return "";
  const yil = gun / 365.25;
  if (yil < 1) return `≈ ${Math.round(gun / 30)} ay`;
  return `≈ ${yil.toFixed(1)} yıl`;
}

// ----------------------------------------------------------------------------
// Durum
// ----------------------------------------------------------------------------
let map;
let imageOverlay = null;
let bounds;
let agacKatmani;              // ağaç işaretçileri (L.FeatureGroup)
let cizimKatmani;            // çizimler (L.FeatureGroup)
const markerlar = new Map(); // tree_id -> L.marker
let cinsler = [];            // [{id, name, color}]
let seciliAgacId = null;
let agacEkleModu = false;
let tasimaAktif = false;      // varsayılan: ağaçlar kilitli (kazara kaymasın)
let esikGun = 7;
let fitZoom = 0;              // görselin tam sığdığı zoom (etiket eşiği için)
let radyalEl = null;          // açık hızlı menü
let hizliHasatEl = null;      // açık hızlı hasat kartı

const RENK_PALETI = [
  "#2e7d32", "#1565c0", "#c62828", "#ef6c00", "#6a1b9a",
  "#00838f", "#9e9d24", "#4e342e", "#ad1457", "#283593",
];

function cinsRengi(species_id, verilen) {
  if (verilen) return verilen;
  if (!species_id) return "#9e9e9e";
  return RENK_PALETI[species_id % RENK_PALETI.length];
}

// ----------------------------------------------------------------------------
// Başlangıç
// ----------------------------------------------------------------------------
window.addEventListener("DOMContentLoaded", init);

async function init() {
  const config = await api("/api/config");
  esikGun = config.watering_threshold_days;
  $("sulama-esigi").value = esikGun;
  $("esik-deger").textContent = esikGun;

  await haritaKur(config.field_image_url);
  await agaclariYukle();
  await cizimleriYukle();
  olaylariBagla();

  // Panel tarih alanlarına bugünü koy
  $("sulama-tarih").value = bugun();
  $("hasat-tarih").value = bugun();

  // QR ile açılış (#t=<uuid>) ve sonradan QR okutma
  qrDerinBaglanti();
  window.addEventListener("hashchange", qrDerinBaglanti);
}

// QR koddan gelen #t=<uuid> → o ağacı bul, ortala ve kartını aç
function qrDerinBaglanti() {
  const m = (location.hash || "").match(/t=([0-9a-fA-F-]{36})/);
  if (!m) return;
  const mk = markerlar.get(m[1]);
  if (mk) {
    map.setView(mk.getLatLng(), Math.max(map.getZoom(), fitZoom + 2));
    agacSec(m[1]);
  } else {
    toast("Bu QR'daki ağaç bu cihazda bulunamadı");
  }
}

// ----------------------------------------------------------------------------
// Harita kurulumu (görsel varsa yükle, yoksa boş tuval)
// ----------------------------------------------------------------------------
function haritaKur(gorselUrl) {
  return new Promise((resolve) => {
    const kur = (w, h) => {
      bounds = [[0, 0], [h, w]];
      map = L.map("harita", {
        crs: L.CRS.Simple,
        minZoom: -5,
        maxZoom: 4,
        zoomSnap: 0.25,
        attributionControl: false,
        // Eski telefonlar için: ağır animasyonları kapat (çok işaretçide fark eder)
        fadeAnimation: false,
        markerZoomAnimation: false,
      });
      map.fitBounds(bounds);
      fitZoom = map.getZoom();
      map.on("zoomend", etiketGuncelle);
      etiketGuncelle();

      if (gorselUrl) {
        imageOverlay = L.imageOverlay(gorselUrl, bounds).addTo(map);
      }

      agacKatmani = L.featureGroup().addTo(map);
      cizimKatmani = L.featureGroup().addTo(map);

      cizimAraclariKur();
      // Mobilde/konteyner boyutu geç oturduğunda haritayı yenile
      setTimeout(() => map.invalidateSize(), 150);
      resolve();
    };

    if (gorselUrl) {
      const img = new Image();
      img.onload = () => kur(img.naturalWidth, img.naturalHeight);
      img.onerror = () => kur(1600, 1000); // görsel bozuksa boş tuval
      img.src = gorselUrl;
    } else {
      kur(1600, 1000);
    }
  });
}

// ----------------------------------------------------------------------------
// Çizim araçları (Geoman)
// ----------------------------------------------------------------------------
function cizimAraclariKur() {
  map.pm.addControls({
    position: "topright",
    drawMarker: false,
    drawCircleMarker: false,
    drawText: false,
    drawCircle: false,
    rotateMode: false,
  });
  map.pm.setLang("tr");

  // Yeni şekil çizildiğinde kaydet
  map.on("pm:create", async (e) => {
    const layer = e.layer;
    cizimKatmani.addLayer(layer);
    try {
      const kayit = await api("/api/shapes", {
        method: "POST",
        body: { geojson: layer.toGeoJSON() },
      });
      layer._dbId = kayit.id;
      cizimLayerBagla(layer);
    } catch (err) {
      alert("Çizim kaydedilemedi: " + err.message);
    }
  });

  // Şekil silindiğinde
  map.on("pm:remove", async (e) => {
    const id = e.layer._dbId;
    if (id) {
      try { await api(`/api/shapes/${id}`, { method: "DELETE" }); } catch (_) {}
    }
  });
}

function cizimLayerBagla(layer) {
  // Şekil düzenlenince: eskisini sil, yenisini kaydet (basit yaklaşım)
  layer.on("pm:update", async () => {
    try {
      if (layer._dbId) await api(`/api/shapes/${layer._dbId}`, { method: "DELETE" });
      const kayit = await api("/api/shapes", {
        method: "POST",
        body: { geojson: layer.toGeoJSON() },
      });
      layer._dbId = kayit.id;
    } catch (err) {
      console.error(err);
    }
  });

  // Çizime tıklayınca kolay silme balonu (telçit/parsel silmek için)
  const kutu = document.createElement("div");
  kutu.className = "sekil-popup";
  kutu.innerHTML = "<span>Bu çizim</span>";
  const silBtn = document.createElement("button");
  silBtn.textContent = "🗑️ Sil";
  silBtn.className = "sekil-sil-btn";
  silBtn.addEventListener("click", async () => {
    try {
      if (layer._dbId) await api(`/api/shapes/${layer._dbId}`, { method: "DELETE" });
    } catch (_) {}
    cizimKatmani.removeLayer(layer);
    map.closePopup();
    toast("Çizim silindi");
  });
  kutu.appendChild(silBtn);
  layer.bindPopup(kutu);
}

async function cizimleriYukle() {
  const sekiller = await api("/api/shapes");
  sekiller.forEach((s) => {
    if (!s.geojson) return;
    const layer = L.geoJSON(s.geojson).getLayers()[0];
    if (!layer) return;
    layer._dbId = s.id;
    cizimKatmani.addLayer(layer);
    cizimLayerBagla(layer);
  });
}

// ----------------------------------------------------------------------------
// Ağaç işaretçileri
// ----------------------------------------------------------------------------
// Kullanılabilir ağaç ikonları (cinse atanır). Her tür kendi meyvesiyle çizilir;
// ağaç susuz kalınca griye döner. Emoji sadece açılır listede kolay seçim içindir.
const AGAC_IKONLARI = [
  { key: "genel", ad: "🌳 Genel Ağaç" },
  { key: "genel_meyve", ad: "🍏 Genel Meyve Ağacı" },
  { key: "elma", ad: "🍎 Elma" },
  { key: "armut", ad: "🍐 Armut" },
  { key: "ayva", ad: "🟡 Ayva" },
  { key: "kiraz", ad: "🍒 Kiraz" },
  { key: "visne", ad: "🍒 Vişne" },
  { key: "erik", ad: "🟣 Erik" },
  { key: "murdum", ad: "🟪 Mürdüm eriği" },
  { key: "kayisi", ad: "🟠 Kayısı" },
  { key: "seftali", ad: "🍑 Şeftali" },
  { key: "nektarin", ad: "🍑 Nektarin" },
  { key: "dut_kirmizi", ad: "🔴 Dut (kırmızı)" },
  { key: "dut_beyaz", ad: "⚪ Dut (beyaz)" },
  { key: "asma", ad: "🍇 Asma (üzüm)" },
  { key: "gul", ad: "🌹 Gül" },
  { key: "ihlamur", ad: "🌼 Ihlamur" },
  { key: "ceviz", ad: "🌰 Ceviz" },
  { key: "zeytin", ad: "🫒 Zeytin" },
  { key: "incir", ad: "🟣 İncir" },
];

// --- Ortak SVG parçaları (viewBox 0 0 32 34) -------------------------------
// Kökten yükselen, tabanı hafif genişleyen gövde (ışıklı-gölgeli)
const GOVDE =
  '<path d="M12.8 31.6c.9-1.9 2-2.9 3.2-2.9s2.3 1 3.2 2.9z" fill="#7a5230"/>' +
  '<rect x="14.5" y="18.5" width="3" height="12.2" rx="1.4" fill="#8a5a34"/>' +
  '<rect x="14.5" y="18.5" width="1.4" height="12.2" rx="0.7" fill="#754d2e"/>';

// Üç loblu bulut kanopi: koyu zemin + ana yeşil + üst ışık lekesi
function kanopi(koyu, ana, isik) {
  return (
    `<circle cx="16" cy="12" r="10.7" fill="${koyu}"/>` +
    `<circle cx="10.6" cy="13.6" r="6.5" fill="${ana}"/>` +
    `<circle cx="21.4" cy="13.6" r="6.5" fill="${ana}"/>` +
    `<circle cx="16" cy="8.4" r="7.6" fill="${ana}"/>` +
    `<circle cx="16" cy="13.4" r="5.7" fill="${ana}"/>` +
    `<ellipse cx="12.3" cy="7.8" rx="3" ry="2.2" fill="${isik}" opacity="0.6"/>`
  );
}

// Parlak yuvarlak meyve (üst-sol köşede küçük ışık noktası)
function meyve(cx, cy, r, renk, isik) {
  return (
    `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${renk}"/>` +
    `<circle cx="${cx - r * 0.32}" cy="${cy - r * 0.34}" r="${Math.max(0.45, r * 0.3)}" fill="${isik || "#ffffff"}" opacity="0.5"/>`
  );
}

// Dikey oval meyve (armut, dut, incir, zeytin vb.)
function meyveOval(cx, cy, rx, ry, renk) {
  return (
    `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="${renk}"/>` +
    `<circle cx="${cx - rx * 0.3}" cy="${cy - ry * 0.35}" r="${rx * 0.32}" fill="#ffffff" opacity="0.45"/>`
  );
}

// Ağacın dibine düşmüş iki meyve
function yerMeyve(renk) {
  return (
    `<ellipse cx="10.4" cy="31.3" rx="1.7" ry="1.35" fill="${renk}"/>` +
    `<ellipse cx="21.4" cy="31.5" rx="1.5" ry="1.2" fill="${renk}"/>`
  );
}

// Sapıyla bir çift kiraz/vişne
function kirazCift(cx, cy, renk) {
  return (
    `<path d="M${cx} ${cy - 3.6}c-1.5 1-2.5 2.1-2.8 3.3M${cx} ${cy - 3.6}c1.4 1 2.3 1.9 2.7 3" stroke="#5b7d24" stroke-width="0.7" fill="none" stroke-linecap="round"/>` +
    meyve(cx - 2.6, cy + 0.7, 1.75, renk) +
    meyve(cx + 2.6, cy + 0.4, 1.75, renk)
  );
}

// Aşağı doğru sivrilen üzüm salkımı
function uzumSalkim(cx, cy, renk) {
  const pts = [[-2, 0], [0, 0], [2, 0], [-1, 1.8], [1, 1.8], [0, 3.5]];
  return pts.map(([dx, dy]) => meyve(cx + dx, cy + dy, 1.5, renk)).join("");
}

// Çoğu ağaç için ortak yeşil tonları
const Y = { koyu: "#1f6f2b", ana: "#3a9a3f", isik: "#93d38f" };

// Bir ikon anahtarına göre SVG iç şekillerini döndürür (viewBox 0 0 32 34)
function ikonIcSvg(key) {
  switch (key) {
    case "elma": // yeşil kanopi + kırmızı elmalar
      return yerMeyve("#d63c33") + GOVDE + kanopi(Y.koyu, Y.ana, Y.isik) +
        meyve(11.4, 15, 2.2, "#e53935") + meyve(20.6, 14.4, 2.2, "#e53935") +
        meyve(16, 17.6, 2.1, "#ef5350");

    case "armut": // uzun/oval kanopi + damla biçimli armutlar
      return yerMeyve("#c0ca33") + GOVDE +
        '<ellipse cx="16" cy="11.5" rx="8.2" ry="11.2" fill="#1f6f2b"/>' +
        '<ellipse cx="13.2" cy="11" rx="4.4" ry="7.6" fill="#3a9a3f"/>' +
        '<ellipse cx="18.8" cy="12" rx="4.4" ry="7.6" fill="#3a9a3f"/>' +
        '<ellipse cx="12.4" cy="7.2" rx="2.3" ry="3" fill="#93d38f" opacity="0.55"/>' +
        meyveOval(12.6, 15, 1.7, 2.4, "#cddc39") + meyveOval(19.4, 14, 1.7, 2.4, "#c0ca33");

    case "ayva": // iri altın-sarısı ayvalar
      return yerMeyve("#e0b83a") + GOVDE + kanopi(Y.koyu, Y.ana, Y.isik) +
        meyve(12.5, 15, 2.7, "#f4c430") + meyve(20, 15.5, 2.7, "#e6b800");

    case "kiraz": // saplı, parlak kırmızı kirazlar
      return yerMeyve("#e53935") + GOVDE + kanopi("#256b2c", "#3f9142", "#8fd08a") +
        kirazCift(12, 16.5, "#e53935") + kirazCift(20, 15.5, "#e53935");

    case "visne": // koyu kırmızı vişneler
      return yerMeyve("#9e1b1b") + GOVDE + kanopi("#215f27", "#357a38", "#7cc07a") +
        kirazCift(12, 16.5, "#c1121f") + kirazCift(20, 15.5, "#a4161a");

    case "erik": // mor erikler (üzeri puslu → mavimsi ışık)
      return yerMeyve("#6a3d9a") + GOVDE + kanopi(Y.koyu, Y.ana, Y.isik) +
        meyve(12, 15, 2.1, "#7b52ab", "#cbb6e6") + meyve(20, 14.5, 2.1, "#7b52ab", "#cbb6e6") +
        meyve(16, 17.4, 2, "#8e5cc0", "#cbb6e6");

    case "murdum": // koyu mor küçük mürdüm erikleri
      return yerMeyve("#4a148c") + GOVDE + kanopi("#1d5f27", "#37913c", "#8ccf88") +
        meyve(11.8, 15.2, 1.8, "#4a148c", "#b39ddb") + meyve(16, 16.6, 1.8, "#5b1a9e", "#b39ddb") +
        meyve(20.2, 14.8, 1.8, "#4a148c", "#b39ddb");

    case "kayisi": // turuncu kayısılar
      return yerMeyve("#ef8f2a") + GOVDE + kanopi(Y.koyu, Y.ana, Y.isik) +
        meyve(12, 15, 2.2, "#f5a623") + meyve(20, 14.6, 2.2, "#f39c12") +
        meyve(16, 17.4, 2, "#f7b733");

    case "seftali": // pembe-turuncu şeftaliler (yanağı kızarık)
      return yerMeyve("#f6a583") + GOVDE + kanopi("#2a7531", "#3f9142", "#8fd08a") +
        meyve(12, 15, 2.4, "#ffb38a", "#ffe3d4") + '<circle cx="10.9" cy="15.7" r="1" fill="#f2694a" opacity="0.65"/>' +
        meyve(20, 14.6, 2.4, "#ffb38a", "#ffe3d4") + '<circle cx="18.9" cy="15.3" r="1" fill="#f2694a" opacity="0.65"/>';

    case "nektarin": // daha kırmızı, parlak (tüysüz şeftali)
      return yerMeyve("#c0392b") + GOVDE + kanopi("#2a7531", "#3f9142", "#8fd08a") +
        meyve(12, 15, 2.4, "#e85d3d", "#ffd0b0") + '<circle cx="11" cy="15.8" r="1" fill="#a02b18" opacity="0.6"/>' +
        meyve(20, 14.6, 2.4, "#e04e2f", "#ffd0b0") + '<circle cx="19" cy="15.4" r="1" fill="#a02b18" opacity="0.6"/>';

    case "dut_kirmizi": // kümelenmiş koyu kırmızı dutlar
      return yerMeyve("#8e1b2e") + GOVDE + kanopi(Y.koyu, Y.ana, Y.isik) +
        meyveOval(12, 15.5, 1.4, 2.1, "#b3172d") + meyveOval(16, 16.8, 1.4, 2.1, "#c1121f") +
        meyveOval(20, 15, 1.4, 2.1, "#a4161a");

    case "dut_beyaz": // soluk açık yeşil-beyaz dutlar
      return yerMeyve("#dfe6b0") + GOVDE + kanopi(Y.koyu, Y.ana, Y.isik) +
        meyveOval(12, 15.5, 1.4, 2.1, "#f0f4c3") + meyveOval(16, 16.8, 1.4, 2.1, "#eef1b8") +
        meyveOval(20, 15, 1.4, 2.1, "#f7fbd0");

    case "asma": // çardak + sarkan üzüm salkımları
      return (
        '<path d="M8.5 31V16M23.5 31V16M8.5 17.5h15" stroke="#8a6a45" stroke-width="1.4" fill="none" stroke-linecap="round"/>' +
        '<circle cx="11.5" cy="12.5" r="5.2" fill="#3a9a3f"/><circle cx="20.5" cy="12.5" r="5.2" fill="#3a9a3f"/>' +
        '<circle cx="16" cy="9.5" r="5.8" fill="#2e8b34"/>' +
        '<ellipse cx="12.5" cy="8.5" rx="2.2" ry="1.6" fill="#8fd08a" opacity="0.55"/>' +
        uzumSalkim(11, 19, "#6a3d9a") + uzumSalkim(20, 19.5, "#7e4fb0")
      );

    case "gul": // yeşil çalı + tepede açmış gül
      return (
        '<path d="M16 31V18" stroke="#4f7a2e" stroke-width="1.5" stroke-linecap="round"/>' +
        '<path d="M16 24c-2.5-.3-4-1.6-4.6-3.4 2.2-.1 3.8.9 4.6 3.4z" fill="#4f9a3e"/>' +
        '<path d="M16 21c2.4-.4 4-1.6 4.5-3.3-2.1-.1-3.7.9-4.5 3.3z" fill="#4f9a3e"/>' +
        '<circle cx="10.5" cy="22.5" r="4" fill="#3a9a3f"/><circle cx="21.5" cy="22.5" r="4" fill="#3a9a3f"/>' +
        '<path d="M16 6.2c3.2 0 5.8 2.6 5.8 5.8S19.2 17.8 16 17.8s-5.8-2.6-5.8-5.8S12.8 6.2 16 6.2z" fill="#c2185b"/>' +
        '<circle cx="16" cy="12" r="3.7" fill="#e63b7a"/>' +
        '<circle cx="16" cy="12" r="1.8" fill="#f8a5c2"/>' +
        '<path d="M16 6.4v11.2M11 9.3l10 5.4M11 14.7l10-5.4" stroke="#ad1457" stroke-width="0.5" opacity="0.45" fill="none"/>'
      );

    case "ihlamur": // gür, uzun kanopi + soluk sarı ıhlamur çiçekleri
      return GOVDE +
        '<ellipse cx="16" cy="11" rx="9.6" ry="11.6" fill="#1f6f2b"/>' +
        '<circle cx="11" cy="12.5" r="6" fill="#3a9a3f"/><circle cx="21" cy="12.5" r="6" fill="#3a9a3f"/>' +
        '<circle cx="16" cy="8" r="7" fill="#46a94b"/>' +
        '<ellipse cx="12.4" cy="6.6" rx="2.4" ry="3.1" fill="#9fdc98" opacity="0.5"/>' +
        meyve(11, 13, 1, "#eef2a0") + meyve(19.5, 11.5, 1, "#eef2a0") +
        meyve(16, 15, 1, "#f2f6b8") + meyve(21, 14, 1, "#eef2a0") + meyve(13.5, 16, 1, "#f2f6b8");

    case "ceviz": // büyük yuvarlak kanopi + yeşil kabuklu cevizler
      return yerMeyve("#8a6a45") + GOVDE +
        '<circle cx="16" cy="11" r="11" fill="#1f6f2b"/>' +
        '<circle cx="11" cy="12" r="5.5" fill="#3a9a3f"/><circle cx="21" cy="12" r="5.5" fill="#3a9a3f"/>' +
        '<circle cx="16" cy="8" r="6.5" fill="#43a047"/>' +
        '<ellipse cx="12.5" cy="7" rx="2.6" ry="1.9" fill="#93d38f" opacity="0.55"/>' +
        meyve(12.5, 15, 2, "#7a9a3a", "#c5d98a") + meyve(20, 14.5, 2, "#7a9a3a", "#c5d98a");

    case "zeytin": // ince, gümüşi-yeşil kanopi + koyu zeytinler
      return yerMeyve("#3b4a1e") + GOVDE +
        '<ellipse cx="16" cy="11.5" rx="8" ry="11" fill="#5f7d4f"/>' +
        '<ellipse cx="13" cy="11" rx="4" ry="7" fill="#7a9a68"/>' +
        '<ellipse cx="19" cy="12" rx="4" ry="7" fill="#7a9a68"/>' +
        '<ellipse cx="12.5" cy="7.5" rx="2" ry="2.6" fill="#b7c9a3" opacity="0.5"/>' +
        meyveOval(12.5, 14.5, 1.3, 1.9, "#3b4a1e") + meyveOval(19, 15, 1.3, 1.9, "#556b2f") +
        meyveOval(16, 17, 1.3, 1.9, "#3b4a1e");

    case "incir": // yeşil kanopi + mor incirler
      return yerMeyve("#7e57c2") + GOVDE +
        '<circle cx="16" cy="11" r="10.5" fill="#1f6f2b"/>' +
        '<circle cx="10.5" cy="13" r="6" fill="#3a9a3f"/><circle cx="21.5" cy="13" r="6" fill="#3a9a3f"/>' +
        '<circle cx="16" cy="8.5" r="7" fill="#43a047"/>' +
        '<ellipse cx="12.5" cy="7.5" rx="2.5" ry="1.8" fill="#93d38f" opacity="0.55"/>' +
        meyveOval(12.5, 15.5, 1.9, 2.2, "#8e5ea8") + meyveOval(20, 15, 1.9, 2.2, "#7e57c2");

    case "genel_meyve": // genel meyve ağacı: yeşil kanopi + karışık meyveler
      return yerMeyve("#d98a3d") + GOVDE + kanopi(Y.koyu, Y.ana, Y.isik) +
        meyve(11.4, 15, 2.2, "#e53935") + meyve(20.6, 14.4, 2.2, "#f5a623") +
        meyve(16, 17.6, 2.1, "#e6b800");

    default: // genel ağaç (meyvesiz, gür yeşil)
      return GOVDE + kanopi(Y.koyu, Y.ana, Y.isik);
  }
}

function miniIkon(key) {
  return `<svg viewBox="0 0 32 34" width="22" height="23" class="mini-agac-svg">${ikonIcSvg(key || "genel")}</svg>`;
}

// Emoji ön ekini atıp yalnızca adı ver ("🍒 Kiraz" → "Kiraz")
function ikonAdi(key) {
  const i = AGAC_IKONLARI.find((x) => x.key === key) || AGAC_IKONLARI[0];
  return i.ad.replace(/^\S+\s/, "");
}

// İkon seçme butonunu (seçili ikon + ad + ok) doldur
function ikonBtnDoldur(btn) {
  const key = btn.dataset.key || "genel";
  btn.innerHTML =
    `<span class="cins-ikon">${miniIkon(key)}</span>` +
    `<span class="isb-ad">${escapeHtml(ikonAdi(key))}</span>` +
    `<span class="isb-ok">▾</span>`;
}

// --- Görsel ikon seçici (tıklayınca gerçek ikonların ızgarası açılır) ---
let ikonSeciciEl = null;

function ikonSeciciKapat() {
  if (!ikonSeciciEl) return;
  ikonSeciciEl.remove();
  ikonSeciciEl = null;
  document.removeEventListener("pointerdown", ikonSeciciDisTikla, true);
}

function ikonSeciciDisTikla(e) {
  if (ikonSeciciEl && !ikonSeciciEl.contains(e.target)) ikonSeciciKapat();
}

// anchorEl'e yakın konumlanır; seçilince onSec(key) çağırır.
function ikonSeciciAc(anchorEl, seciliKey, onSec) {
  ikonSeciciKapat();
  const el = document.createElement("div");
  el.className = "ikon-secici";
  el.innerHTML =
    `<div class="is-baslik">Ağaç ikonu seç</div>` +
    `<div class="is-izgara">` +
    AGAC_IKONLARI.map(
      (i) =>
        `<button type="button" class="is-secenek${i.key === (seciliKey || "genel") ? " secili" : ""}" data-key="${i.key}">` +
        `<svg viewBox="0 0 32 34" width="40" height="42">${ikonIcSvg(i.key)}</svg>` +
        `<span>${escapeHtml(ikonAdi(i.key))}</span>` +
        `</button>`
    ).join("") +
    `</div>`;
  document.body.appendChild(el);

  // Buton hizasına konumlandır (ekran dışına taşmasın)
  const r = anchorEl.getBoundingClientRect();
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  let left = r.left;
  let top = r.bottom + 6;
  if (left + w > window.innerWidth - 8) left = window.innerWidth - w - 8;
  if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 6);
  el.style.left = Math.max(8, left) + "px";
  el.style.top = top + "px";

  el.querySelectorAll(".is-secenek").forEach((b) =>
    b.addEventListener("click", () => {
      const k = b.dataset.key;
      ikonSeciciKapat();
      onSec(k);
    })
  );

  ikonSeciciEl = el;
  // Dışarı tıklayınca kapat (açılış tıklamasını yakalamamak için sonraki döngüde bağla)
  setTimeout(() => document.addEventListener("pointerdown", ikonSeciciDisTikla, true), 0);
}

function agacIkonu(agac) {
  const key = agac.category || agac.species_icon || "genel";
  const su = agac.needs_water ? '<div class="su-damla">💧</div>' : "";
  // Yakınlaşınca görünen etiket: numara (varsa) + ne ağacı olduğu
  const no = agac.label ? `<b class="ae-no">${escapeHtml(agac.label)}</b>` : "";
  const ad = agac.species_name ? `<span class="ae-cins">${escapeHtml(agac.species_name)}</span>` : "";
  const etiket = (no || ad) ? `<div class="agac-etiket">${no}${ad}</div>` : "";
  const svg = `<svg class="agac-svg" viewBox="0 0 32 34" width="30" height="32">${ikonIcSvg(key)}</svg>`;
  return L.divIcon({
    className: "agac-ikon-sarmal" + (agac.needs_water ? " susuz" : ""),
    html: `<div class="agac-marker">${svg}${su}${etiket}</div>`,
    iconSize: [30, 32],
    iconAnchor: [15, 31],
  });
}

// Fareyle üzerine gelince "ne ağacı" olduğunu baloncukla göster (her zoom'da)
function tooltipKur(m, agac) {
  const metin = [agac.label, agac.species_name].filter(Boolean).join(" • ");
  if (metin) {
    m.bindTooltip(metin, { direction: "top", offset: [0, -26], className: "agac-tip", opacity: 1 });
  } else {
    m.unbindTooltip();
  }
}

function markerEkle(agac) {
  const m = L.marker([agac.lat, agac.lng], {
    icon: agacIkonu(agac),
    draggable: tasimaAktif,
  });
  m._agac = agac;
  m.addTo(agacKatmani);
  markerlar.set(agac.id, m);
  tooltipKur(m, agac);

  m.on("click", (e) => {
    L.DomEvent.stopPropagation(e);
    if (m._uzunBasti) { m._uzunBasti = false; return; } // uzun basmaydı, menü açma
    radyalGoster(m._agac, m.getLatLng());
  });

  m.on("dragstart", () => clearTimeout(m._kilitZaman));

  m.on("dragend", async () => {
    const ll = m.getLatLng();
    try {
      await api(`/api/trees/${agac.id}`, {
        method: "PATCH",
        body: { lat: ll.lat, lng: ll.lng },
      });
      agac.lat = ll.lat;
      agac.lng = ll.lng;
    } catch (err) {
      alert("Konum kaydedilemedi: " + err.message);
    }
    kilitle(m); // bırakınca tekrar kilitle (global taşıma kapalıysa)
  });

  baglaUzunBasma(m);
  return m;
}

// Bir ağacı tekrar kilitle (global taşıma modu kapalıysa)
function kilitle(m) {
  if (tasimaAktif) return;
  if (!m._kilitAcik) return;
  m.dragging.disable();
  m._kilitAcik = false;
  const el = m.getElement();
  if (el) el.classList.remove("tasinabilir");
}

// Ağaca basılı tutunca (uzun basma) o ağacın taşınmasını aç
function baglaUzunBasma(m) {
  const el = m.getElement();
  if (!el) return;
  let baslangic = null;

  const iptal = () => {
    clearTimeout(m._basTimer);
    document.removeEventListener("pointermove", hareket);
    document.removeEventListener("pointerup", birak);
    document.removeEventListener("pointercancel", birak);
    baslangic = null;
  };
  const hareket = (e) => {
    if (!baslangic) return;
    if (Math.hypot(e.clientX - baslangic.x, e.clientY - baslangic.y) > 10) iptal();
  };
  const birak = () => iptal();

  el.addEventListener("pointerdown", (e) => {
    if (tasimaAktif) return; // global taşıma zaten açık
    baslangic = { x: e.clientX, y: e.clientY };
    document.addEventListener("pointermove", hareket);
    document.addEventListener("pointerup", birak);
    document.addEventListener("pointercancel", birak);
    m._basTimer = setTimeout(() => {
      // Yeterince basılı tutuldu → bu ağacı taşınabilir yap
      m.dragging.enable();
      m._kilitAcik = true;
      m._uzunBasti = true; // hemen ardından menü açılmasın
      el.classList.add("tasinabilir");
      radyalKapat();
      toast("🔓 Taşıma açıldı — sürükle, bırakınca kilitlenir");
      // Sürüklenmezse 6 sn sonra tekrar kilitle
      m._kilitZaman = setTimeout(() => kilitle(m), 6000);
      iptal();
    }, 450);
  });
}

async function agaclariYukle() {
  const agaclar = await api("/api/trees");
  agacKatmani.clearLayers();
  markerlar.clear();
  agaclar.forEach(markerEkle);
}

function markerYenile(agac) {
  const m = markerlar.get(agac.id);
  if (!m) return;
  m._agac = agac;
  m.setIcon(agacIkonu(agac));
  tooltipKur(m, agac);
}

// Numaralar (etiketler) yalnızca yeterince yakınlaşınca görünür
function etiketGuncelle() {
  if (!map) return;
  const goster = map.getZoom() >= fitZoom + 1;
  map.getContainer().classList.toggle("etiket-goster", goster);
}

// ----------------------------------------------------------------------------
// Hızlı menü (ağacın etrafında yuvarlak butonlar)
// ----------------------------------------------------------------------------
function radyalGoster(agac, latlng) {
  radyalKapat();
  hizliHasatKapat();
  if (window.aracKapat) window.aracKapat();

  const p = map.latLngToContainerPoint(latlng);
  const el = document.createElement("div");
  el.className = "radyal-menu";
  el.style.left = p.x + "px";
  el.style.top = p.y + "px";

  // Üstte küçük bilgi rozeti
  const bilgi = document.createElement("div");
  bilgi.className = "radyal-bilgi";
  bilgi.textContent =
    (agac.label ? agac.label + " • " : "") + (agac.species_name || "ağaç");
  el.appendChild(bilgi);

  const eylemler = [
    { ikon: "💧", baslik: "Suladım", sinif: "e-su", fn: () => hizliSula(agac) },
    { ikon: "🧺", baslik: "Hasat", sinif: "e-hasat", fn: () => hizliHasat(agac, latlng) },
    { ikon: "✋", baslik: "Taşı", sinif: "e-tasi", fn: () => tasiyaAl(agac.id) },
    { ikon: "✏️", baslik: "Detay", sinif: "e-detay", fn: () => { radyalKapat(); agacSec(agac.id); } },
    { ikon: "🗑️", baslik: "Sil", sinif: "e-sil", fn: () => agacSilRadyal(agac) },
  ];

  // Butonları ağacın altına doğru yay şeklinde diz (kanopiyi kapatmasın)
  const n = eylemler.length, R = 56, bas = 20, son = 160;
  eylemler.forEach((e, i) => {
    const derece = bas + (son - bas) * (n === 1 ? 0.5 : i / (n - 1));
    const rad = (derece * Math.PI) / 180;
    const b = document.createElement("button");
    b.className = "radyal-btn " + e.sinif;
    b.title = e.baslik;
    b.innerHTML = `<span>${e.ikon}</span>`;
    b.style.left = Math.cos(rad) * R + "px";
    b.style.top = Math.sin(rad) * R + "px";
    b.addEventListener("click", (ev) => { ev.stopPropagation(); e.fn(); });
    el.appendChild(b);
  });

  map.getContainer().appendChild(el);
  radyalEl = el;
}

function radyalKapat() {
  if (radyalEl) { radyalEl.remove(); radyalEl = null; }
}

// Menüden "Taşı" → bu ağacı sürüklenebilir yap (bırakınca tekrar kilitlenir)
function tasiyaAl(agacId) {
  const m = markerlar.get(agacId);
  if (!m) return;
  radyalKapat();
  m.dragging.enable();
  m._kilitAcik = true;
  const el = m.getElement();
  if (el) el.classList.add("tasinabilir");
  toast("✋ Sürükle — bırakınca kilitlenir");
  clearTimeout(m._kilitZaman);
  m._kilitZaman = setTimeout(() => kilitle(m), 8000);
}

async function hizliSula(agac) {
  radyalKapat();
  try {
    await api(`/api/trees/${agac.id}/waterings`, {
      method: "POST",
      body: { watered_on: bugun(), note: null },
    });
    toast("Sulandı 💧");
    await tekAgacYenile(agac.id);
    if (seciliAgacId === agac.id) agacSec(agac.id); // panel açıksa tazele
  } catch (err) {
    alert(err.message);
  }
}

function hizliHasat(agac, latlng) {
  radyalKapat();
  hizliHasatKapat();
  const p = map.latLngToContainerPoint(latlng);
  const el = document.createElement("div");
  el.className = "hizli-hasat";
  el.style.left = p.x + "px";
  el.style.top = p.y + "px";
  el.innerHTML = `
    <div class="hh-baslik">🧺 Hasat — ${escapeHtml(agac.label || "ağaç")}</div>
    <div class="hh-satir">
      <input type="number" step="any" placeholder="Miktar" class="hh-miktar">
      <input type="text" placeholder="birim" class="hh-birim" value="kg">
    </div>
    <div class="hh-satir">
      <button class="hh-ekle">Ekle</button>
      <button class="hh-iptal">İptal</button>
    </div>`;
  map.getContainer().appendChild(el);
  hizliHasatEl = el;
  const miktar = el.querySelector(".hh-miktar");
  miktar.focus();
  el.querySelector(".hh-iptal").addEventListener("click", hizliHasatKapat);
  el.querySelector(".hh-ekle").addEventListener("click", async () => {
    try {
      await api(`/api/trees/${agac.id}/harvests`, {
        method: "POST",
        body: {
          harvested_on: bugun(),
          amount: miktar.value ? parseFloat(miktar.value) : null,
          unit: el.querySelector(".hh-birim").value.trim() || null,
          note: null,
        },
      });
      toast("Hasat eklendi 🧺");
      hizliHasatKapat();
      if (seciliAgacId === agac.id) agacSec(agac.id);
    } catch (err) {
      alert(err.message);
    }
  });
  miktar.addEventListener("keydown", (e) => {
    if (e.key === "Enter") el.querySelector(".hh-ekle").click();
  });
}

function hizliHasatKapat() {
  if (hizliHasatEl) { hizliHasatEl.remove(); hizliHasatEl = null; }
}

async function agacSilRadyal(agac) {
  if (!confirm("Bu ağacı silmek istiyor musun?")) return;
  const m = markerlar.get(agac.id);
  try {
    await api(`/api/trees/${agac.id}`, { method: "DELETE" });
  } catch (err) {
    alert(err.message);
    return;
  }
  if (m) agacKatmani.removeLayer(m);
  markerlar.delete(agac.id);
  radyalKapat();
  if (seciliAgacId === agac.id) panelKapat();
  toast("Ağaç silindi");
}

// Kısa bilgi baloncuğu
function toast(msg) {
  let t = document.getElementById("toast");
  if (!t) {
    t = document.createElement("div");
    t.id = "toast";
    t.className = "toast";
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.classList.add("gorunur");
  clearTimeout(t._zamanlayici);
  t._zamanlayici = setTimeout(() => t.classList.remove("gorunur"), 1800);
}

// (Cins yönetimi kaldırıldı — ağaç türü artık statik kategori listesinden seçilir.)

// ----------------------------------------------------------------------------
// Ağaç seçimi ve kimlik kartı
// ----------------------------------------------------------------------------
async function agacSec(treeId) {
  seciliAgacId = treeId;
  const agac = await api(`/api/trees/${treeId}`);

  $("agac-uuid").textContent = agac.id;
  $("agac-numara").value = agac.label || "";
  const katBtn = $("agac-kategori");
  katBtn.dataset.key = agac.category || agac.species_icon || "genel";
  ikonBtnDoldur(katBtn);
  $("agac-dikim").value = agac.planted_on || "";
  $("agac-yas").textContent = yasHesapla(agac.planted_on);
  $("agac-notlar").value = agac.notes || "";

  sulamaListesiCiz(agac.waterings);
  hasatListesiCiz(agac.harvests);

  if (window.aracKapat) window.aracKapat(); // mobilde araç çekmecesini kapat
  $("agac-panel").classList.remove("gizli");
}

function panelKapat() {
  seciliAgacId = null;
  $("agac-panel").classList.add("gizli");
}

function sulamaListesiCiz(kayitlar) {
  const ul = $("sulama-liste");
  ul.innerHTML = "";
  if (!kayitlar || kayitlar.length === 0) {
    ul.innerHTML = '<li class="bos">Kayıt yok.</li>';
    return;
  }
  kayitlar.forEach((w) => {
    const li = document.createElement("li");
    li.innerHTML = `<span>${trTarih(w.watered_on)}${w.note ? " — " + escapeHtml(w.note) : ""}</span>
                    <button class="mini-btn sil" title="Sil">✕</button>`;
    li.querySelector(".sil").addEventListener("click", async () => {
      await api(`/api/waterings/${w.id}`, { method: "DELETE" });
      await agacSec(seciliAgacId);
      await tekAgacYenile(seciliAgacId);
    });
    ul.appendChild(li);
  });
}

function hasatListesiCiz(kayitlar) {
  const ul = $("hasat-liste");
  ul.innerHTML = "";
  let toplam = 0;
  let birim = "";
  if (!kayitlar || kayitlar.length === 0) {
    ul.innerHTML = '<li class="bos">Kayıt yok.</li>';
    $("hasat-toplam").textContent = "";
    return;
  }
  kayitlar.forEach((h) => {
    if (h.amount) { toplam += h.amount; birim = h.unit || birim; }
    const miktar = h.amount ? `${h.amount} ${h.unit || ""}`.trim() : "";
    const li = document.createElement("li");
    li.innerHTML = `<span>${trTarih(h.harvested_on)}${miktar ? " — " + miktar : ""}${h.note ? " (" + escapeHtml(h.note) + ")" : ""}</span>
                    <button class="mini-btn sil" title="Sil">✕</button>`;
    li.querySelector(".sil").addEventListener("click", async () => {
      await api(`/api/harvests/${h.id}`, { method: "DELETE" });
      await agacSec(seciliAgacId);
    });
    ul.appendChild(li);
  });
  $("hasat-toplam").textContent = toplam
    ? `Toplam ürün: ${toplam.toFixed(2)} ${birim}`.trim()
    : "";
}

async function tekAgacYenile(treeId) {
  // İşaretçiyi (su damlası vb.) güncellemek için tek ağacı yeniden çek
  const agaclar = await api("/api/trees");
  const agac = agaclar.find((a) => a.id === treeId);
  if (agac) markerYenile(agac);
}

// ----------------------------------------------------------------------------
// Olay bağlama
// ----------------------------------------------------------------------------
// Detay panelinde bir alanı ANINDA (otomatik) kaydet — Kaydet butonu yok
async function alanKaydet(govde) {
  if (!seciliAgacId) return;
  kayitDurum("kaydediliyor");
  try {
    await api(`/api/trees/${seciliAgacId}`, { method: "PATCH", body: govde });
    await tekAgacYenile(seciliAgacId);
    kayitDurum("kaydedildi");
  } catch (e) {
    kayitDurum("hata");
  }
}

function kayitDurum(durum) {
  const el = $("kayit-durum");
  if (!el) return;
  clearTimeout(el._z);
  if (durum === "kaydediliyor") {
    el.textContent = "Kaydediliyor…";
    el.className = "kayit-durum bekliyor";
  } else if (durum === "kaydedildi") {
    el.textContent = "✓ Kaydedildi";
    el.className = "kayit-durum tamam";
    el._z = setTimeout(() => {
      el.textContent = "Otomatik kaydedilir";
      el.className = "kayit-durum";
    }, 1600);
  } else {
    el.textContent = "⚠ Kaydedilemedi";
    el.className = "kayit-durum hata";
  }
}

function olaylariBagla() {
  // --- Yüzen paneller (cinsler / ayarlar) ---
  // Butonlara/panellere yapılan tıklamalar haritaya geçmesin (yanlışlıkla ağaç eklenmesin)
  ["harita-araclar", "ayarlar-panel"].forEach((id) => {
    const el = $(id);
    if (el) { L.DomEvent.disableClickPropagation(el); L.DomEvent.disableScrollPropagation(el); }
  });

  window.aracKapat = () => {
    $("ayarlar-panel").classList.add("gizli");
  };
  const paneliAcKapat = (id) => {
    const acik = !$(id).classList.contains("gizli");
    window.aracKapat();
    if (!acik) $(id).classList.remove("gizli");
  };
  $("fab-ayarlar").addEventListener("click", () => paneliAcKapat("ayarlar-panel"));
  document.querySelectorAll(".yp-kapat").forEach((b) =>
    b.addEventListener("click", () => $(b.dataset.panel).classList.add("gizli"))
  );

  // Görsel yükleme
  $("gorsel-yukle").addEventListener("change", async (e) => {
    const dosya = e.target.files[0];
    if (!dosya) return;
    const form = new FormData();
    form.append("file", dosya);
    try {
      await api("/api/field-image", { method: "POST", body: form });
      window.location.reload(); // yeni görselle temiz başla
    } catch (err) {
      alert("Görsel yüklenemedi: " + err.message);
    }
  });

  // Görsel görünürlük
  $("gorsel-goster").addEventListener("change", (e) => {
    if (!imageOverlay) return;
    if (e.target.checked) imageOverlay.addTo(map);
    else map.removeLayer(imageOverlay);
  });

  // Şeffaflık
  $("seffaflik").addEventListener("input", (e) => {
    const v = e.target.value;
    $("seffaflik-deger").textContent = v + "%";
    if (imageOverlay) imageOverlay.setOpacity(v / 100);
  });

  // Ağaç ekleme modu (yüzen + butonu)
  $("fab-agac-ekle").addEventListener("click", () => {
    agacEkleModu = !agacEkleModu;
    $("fab-agac-ekle").classList.toggle("aktif", agacEkleModu);
    map.getContainer().style.cursor = agacEkleModu ? "crosshair" : "";
    window.aracKapat();
    toast(agacEkleModu ? "Ağaç ekleme AÇIK — haritaya dokun" : "Ağaç ekleme kapandı");
  });

  // Haritaya tıklama → ekleme modundaysa ağaç düşür, değilse menüleri kapat
  map.on("click", async (e) => {
    radyalKapat();
    hizliHasatKapat();
    if (!agacEkleModu) return;
    if (map.pm.globalDrawModeEnabled && map.pm.globalDrawModeEnabled()) return;
    try {
      const agac = await api("/api/trees", {
        method: "POST",
        body: { lat: e.latlng.lat, lng: e.latlng.lng },
      });
      markerEkle(agac);
      toast("Ağaç eklendi 🌳");
    } catch (err) {
      alert("Ağaç eklenemedi: " + err.message);
    }
  });

  // Harita kaydırılınca/yakınlaşınca açık menüleri kapat
  map.on("movestart", () => { radyalKapat(); hizliHasatKapat(); });
  map.on("zoomstart", () => { radyalKapat(); hizliHasatKapat(); });

  // Ağaç türü (kategori) seçici — seçilince ANINDA kaydet
  const katBtn = $("agac-kategori");
  katBtn.addEventListener("click", () => {
    ikonSeciciAc(katBtn, katBtn.dataset.key, (key) => {
      katBtn.dataset.key = key;
      ikonBtnDoldur(katBtn);
      alanKaydet({ category: key });
    });
  });

  // Numara / Notlar → yazarken (kısa gecikmeyle) otomatik kaydet
  let _yaziZaman = null;
  const yaziAuto = (alan, el) =>
    el.addEventListener("input", () => {
      clearTimeout(_yaziZaman);
      _yaziZaman = setTimeout(
        () => alanKaydet({ [alan]: el.value.trim() || null }),
        500
      );
    });
  yaziAuto("label", $("agac-numara"));
  yaziAuto("notes", $("agac-notlar"));

  // Dikim tarihi → değişince anında kaydet + yaşı güncelle
  $("agac-dikim").addEventListener("change", () => {
    const v = $("agac-dikim").value || null;
    $("agac-yas").textContent = yasHesapla(v);
    alanKaydet({ planted_on: v });
  });

  // Sulama eşiği
  $("sulama-esigi").addEventListener("change", async (e) => {
    const gun = parseInt(e.target.value, 10);
    if (isNaN(gun)) return;
    esikGun = gun;
    $("esik-deger").textContent = gun;
    await api("/api/config", { method: "PATCH", body: { watering_threshold_days: gun } });
    await agaclariYukle(); // su işaretleri yeni eşiğe göre güncellensin
  });

  // (Kaydet butonu kaldırıldı — alanlar otomatik kaydedilir)

  // Panel: sil
  $("agac-sil").addEventListener("click", async () => {
    if (!seciliAgacId) return;
    if (!confirm("Bu ağacı silmek istiyor musun?")) return;
    const m = markerlar.get(seciliAgacId);
    await api(`/api/trees/${seciliAgacId}`, { method: "DELETE" });
    if (m) agacKatmani.removeLayer(m);
    markerlar.delete(seciliAgacId);
    panelKapat();
  });

  $("panel-kapat").addEventListener("click", panelKapat);

  // UUID kopyala
  $("agac-uuid").addEventListener("click", () => {
    navigator.clipboard?.writeText($("agac-uuid").textContent);
  });

  // Sulama ekle
  $("sulama-ekle").addEventListener("click", async () => {
    if (!seciliAgacId) return;
    const govde = {
      watered_on: $("sulama-tarih").value || bugun(),
      note: $("sulama-not").value.trim() || null,
    };
    await api(`/api/trees/${seciliAgacId}/waterings`, { method: "POST", body: govde });
    $("sulama-not").value = "";
    await agacSec(seciliAgacId);
    await tekAgacYenile(seciliAgacId);
  });

  // Hasat ekle
  $("hasat-ekle").addEventListener("click", async () => {
    if (!seciliAgacId) return;
    const miktar = $("hasat-miktar").value;
    const govde = {
      harvested_on: $("hasat-tarih").value || bugun(),
      amount: miktar ? parseFloat(miktar) : null,
      unit: $("hasat-birim").value.trim() || null,
      note: $("hasat-not").value.trim() || null,
    };
    await api(`/api/trees/${seciliAgacId}/harvests`, { method: "POST", body: govde });
    $("hasat-miktar").value = "";
    $("hasat-not").value = "";
    await agacSec(seciliAgacId);
  });
}

// ----------------------------------------------------------------------------
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}
