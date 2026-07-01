/* store.js — Offline veri katmanı (IndexedDB).
   Python'daki db.py + main.py API'lerinin tarayıcı karşılığı.
   window.localApi(url, options) ile eski `api()` çağrıları birebir çalışır. */

"use strict";

const DB_ADI = "ciftlik_db";
const DB_SURUM = 1;
const ESIK_VARSAYILAN = 7;

// Sabit (statik) ağaç kategorileri — anahtar = ikon anahtarı. Kullanıcı cins
// eklemez; ağaç doğrudan bu listeden tür seçer. İkon çizimleri app.js'te.
const KATEGORILER = [
  { key: "genel", ad: "Genel Ağaç" },
  { key: "genel_meyve", ad: "Genel Meyve Ağacı" },
  { key: "elma", ad: "Elma" },
  { key: "armut", ad: "Armut" },
  { key: "ayva", ad: "Ayva" },
  { key: "kiraz", ad: "Kiraz" },
  { key: "visne", ad: "Vişne" },
  { key: "erik", ad: "Erik" },
  { key: "murdum", ad: "Mürdüm eriği" },
  { key: "kayisi", ad: "Kayısı" },
  { key: "seftali", ad: "Şeftali" },
  { key: "nektarin", ad: "Nektarin" },
  { key: "dut_kirmizi", ad: "Dut (kırmızı)" },
  { key: "dut_beyaz", ad: "Dut (beyaz)" },
  { key: "asma", ad: "Asma (üzüm)" },
  { key: "gul", ad: "Gül" },
  { key: "ihlamur", ad: "Ihlamur" },
  { key: "ceviz", ad: "Ceviz" },
  { key: "zeytin", ad: "Zeytin" },
  { key: "incir", ad: "İncir" },
];
const KAT_AD = {};
const KAT_KEYS = new Set();
for (const k of KATEGORILER) { KAT_AD[k.key] = k.ad; KAT_KEYS.add(k.key); }

// Eski veriyi (cins adı/ikonu) statik kategoriye çevir (geçmiş taşıma için)
function kategoriCoz(ad, ikon) {
  if (ikon && KAT_KEYS.has(ikon)) return ikon;
  const t = (ad || "").toLowerCase().trim()
    .replace(/ş/g, "s").replace(/ı/g, "i").replace(/ç/g, "c")
    .replace(/ö/g, "o").replace(/ü/g, "u").replace(/ğ/g, "g");
  if (!t) return "genel";
  // Dut: renk ayrımı (çok kelimeli "Dut (kırmızı)" / "Dut (beyaz)" de yakalanır)
  if (t.includes("dut")) return t.includes("beyaz") ? "dut_beyaz" : "dut_kirmizi";
  // Anahtar kelime İÇERİYOR mu? — çok kelimeli adları da yakalar
  // (sıra önemli: "mürdüm eriği" önce "murdum" ile eşleşsin, "erik" ile değil)
  const kelimeler = [
    ["murdum", "murdum"], ["nektarin", "nektarin"], ["seftali", "seftali"],
    ["kayisi", "kayisi"], ["visne", "visne"], ["kiraz", "kiraz"], ["erik", "erik"],
    ["ceviz", "ceviz"], ["elma", "elma"], ["armut", "armut"], ["ayva", "ayva"],
    ["uzum", "asma"], ["asma", "asma"], ["ihlamur", "ihlamur"], ["gul", "gul"],
    ["zeytin", "zeytin"], ["incir", "incir"],
  ];
  for (const [kelime, kat] of kelimeler) if (t.includes(kelime)) return kat;
  if (t.includes("meyve")) return "genel_meyve";
  return "genel";
}

// ---------------------------------------------------------------------------
// IndexedDB temel yardımcıları
// ---------------------------------------------------------------------------
let _dbSoz = null;

function dbAc() {
  if (_dbSoz) return _dbSoz;
  _dbSoz = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_ADI, DB_SURUM);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("trees")) {
        const s = db.createObjectStore("trees", { keyPath: "id" });
        s.createIndex("species_id", "species_id");
      }
      if (!db.objectStoreNames.contains("species")) {
        db.createObjectStore("species", { keyPath: "id", autoIncrement: true });
      }
      if (!db.objectStoreNames.contains("waterings")) {
        const s = db.createObjectStore("waterings", { keyPath: "id", autoIncrement: true });
        s.createIndex("tree_id", "tree_id");
      }
      if (!db.objectStoreNames.contains("harvests")) {
        const s = db.createObjectStore("harvests", { keyPath: "id", autoIncrement: true });
        s.createIndex("tree_id", "tree_id");
      }
      if (!db.objectStoreNames.contains("shapes")) {
        db.createObjectStore("shapes", { keyPath: "id", autoIncrement: true });
      }
      if (!db.objectStoreNames.contains("settings")) {
        db.createObjectStore("settings", { keyPath: "key" });
      }
      if (!db.objectStoreNames.contains("meta")) {
        db.createObjectStore("meta", { keyPath: "key" }); // tarla görseli (Blob) vb.
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return _dbSoz;
}

function tx(store, mod = "readonly") {
  return dbAc().then((db) => db.transaction(store, mod).objectStore(store));
}

function istek(r) {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

const dbGetAll = (store) => tx(store).then((s) => istek(s.getAll()));
const dbGet = (store, key) => tx(store).then((s) => istek(s.get(key)));
const dbPut = (store, val) => tx(store, "readwrite").then((s) => istek(s.put(val)));
const dbAdd = (store, val) => tx(store, "readwrite").then((s) => istek(s.add(val)));
const dbDel = (store, key) => tx(store, "readwrite").then((s) => istek(s.delete(key)));
const dbClear = (store) => tx(store, "readwrite").then((s) => istek(s.clear()));

function nowIso() {
  return new Date().toISOString().slice(0, 19);
}

// ---------------------------------------------------------------------------
// Ayarlar
// ---------------------------------------------------------------------------
async function ayarGetir(key, varsayilan) {
  const row = await dbGet("settings", key);
  return row ? row.value : varsayilan;
}
async function ayarYaz(key, value) {
  await dbPut("settings", { key, value: String(value) });
}
async function sulamaEsigi() {
  const v = parseInt(await ayarGetir("watering_threshold_days", ESIK_VARSAYILAN), 10);
  return isNaN(v) ? ESIK_VARSAYILAN : v;
}

// ---------------------------------------------------------------------------
// Tarla görseli (Blob → object URL)
// ---------------------------------------------------------------------------
let _gorselUrl = null;
async function gorselUrlAl() {
  const row = await dbGet("meta", "field_image");
  if (!row || !row.blob) return null;
  if (_gorselUrl) URL.revokeObjectURL(_gorselUrl);
  _gorselUrl = URL.createObjectURL(row.blob);
  return _gorselUrl;
}
async function gorselKaydet(blob) {
  await dbPut("meta", { key: "field_image", blob });
  return gorselUrlAl();
}

// ---------------------------------------------------------------------------
// Sulama "su lazım mı" hesabı (db.py._needs_water karşılığı)
// ---------------------------------------------------------------------------
function suLazimMi(sonSulamaIso, esik) {
  if (!sonSulamaIso) return true;
  const son = new Date(sonSulamaIso + "T00:00:00");
  if (isNaN(son)) return true;
  const gun = (Date.now() - son.getTime()) / 86400000;
  return gun > esik;
}

// ---------------------------------------------------------------------------
// Cinsler
// ---------------------------------------------------------------------------
async function cinsListe() {
  const list = await dbGetAll("species");
  return list.sort((a, b) =>
    String(a.name).localeCompare(String(b.name), "tr", { sensitivity: "base" })
  );
}
async function cinsEkle(name, icon, color) {
  const id = await dbAdd("species", { name, icon: icon || null, color: color || null, created_at: nowIso() });
  return { id, name, icon: icon || null, color: color || null };
}
async function cinsGuncelle(id, alanlar) {
  const c = await dbGet("species", Number(id));
  if (!c) return;
  if (alanlar.name != null) c.name = alanlar.name;
  if (alanlar.icon != null) c.icon = alanlar.icon;
  if (alanlar.color != null) c.color = alanlar.color;
  await dbPut("species", c);
}
async function cinsSil(id) {
  await dbDel("species", Number(id));
  // Bu cinse bağlı ağaçların species_id'sini boşalt
  const trees = await dbGetAll("trees");
  for (const t of trees) {
    if (t.species_id === Number(id)) {
      t.species_id = null;
      await dbPut("trees", t);
    }
  }
}

// ---------------------------------------------------------------------------
// Ağaçlar
// ---------------------------------------------------------------------------
async function agacListe() {
  const [trees, waterings, harvests, esik] = await Promise.all([
    dbGetAll("trees"), dbGetAll("waterings"), dbGetAll("harvests"), sulamaEsigi(),
  ]);
  const sonSu = new Map();
  for (const w of waterings) {
    const cur = sonSu.get(w.tree_id);
    if (!cur || w.watered_on > cur) sonSu.set(w.tree_id, w.watered_on);
  }
  const toplamUrun = new Map();
  const sonHasat = new Map();
  for (const h of harvests) {
    toplamUrun.set(h.tree_id, (toplamUrun.get(h.tree_id) || 0) + (Number(h.amount) || 0));
    const cur = sonHasat.get(h.tree_id);
    if (!cur || h.harvested_on > cur) sonHasat.set(h.tree_id, h.harvested_on);
  }
  return trees
    .map((t) => {
      const kat = t.category || "genel";
      const lw = sonSu.get(t.id) || null;
      return {
        ...t,
        category: kat,
        species_icon: kat,               // işaretçi ikonu = kategori
        species_name: KAT_AD[kat] || null, // gösterim adı
        species_color: null,
        last_watered_on: lw,
        total_harvest: toplamUrun.get(t.id) || 0,
        last_harvest_on: sonHasat.get(t.id) || null,
        needs_water: suLazimMi(lw, esik),
      };
    })
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
}

async function agacOlustur(lat, lng, label) {
  const id = (crypto.randomUUID && crypto.randomUUID()) || String(Date.now() + Math.random());
  const t = {
    id, label: label || null, category: "genel",
    lat, lng, planted_on: null, notes: null, created_at: nowIso(),
  };
  await dbPut("trees", t);
  return agacDetay(id);
}

async function agacGuncelle(id, alanlar) {
  const t = await dbGet("trees", id);
  if (!t) return null;
  const izin = ["label", "category", "lat", "lng", "planted_on", "notes"];
  for (const k of izin) if (k in alanlar) t[k] = alanlar[k];
  await dbPut("trees", t);
  return agacDetay(id);
}

async function agacSil(id) {
  await dbDel("trees", id);
  const [waterings, harvests] = await Promise.all([dbGetAll("waterings"), dbGetAll("harvests")]);
  for (const w of waterings) if (w.tree_id === id) await dbDel("waterings", w.id);
  for (const h of harvests) if (h.tree_id === id) await dbDel("harvests", h.id);
}

async function agacDetay(id) {
  const t = await dbGet("trees", id);
  if (!t) return null;
  const [waterings, harvests] = await Promise.all([
    dbGetAll("waterings"), dbGetAll("harvests"),
  ]);
  const kat = t.category || "genel";
  const suLar = waterings.filter((w) => w.tree_id === id)
    .sort((a, b) => (b.watered_on > a.watered_on ? 1 : b.watered_on < a.watered_on ? -1 : b.id - a.id));
  const hasatlar = harvests.filter((h) => h.tree_id === id)
    .sort((a, b) => (b.harvested_on > a.harvested_on ? 1 : b.harvested_on < a.harvested_on ? -1 : b.id - a.id));
  return {
    ...t,
    category: kat,
    species_icon: kat,
    species_name: KAT_AD[kat] || null,
    species_color: null,
    waterings: suLar,
    harvests: hasatlar,
  };
}

// ---------------------------------------------------------------------------
// Sulama / Hasat
// ---------------------------------------------------------------------------
async function sulamaEkle(tree_id, watered_on, note) {
  await dbAdd("waterings", { tree_id, watered_on, note: note || null, created_at: nowIso() });
  return agacDetay(tree_id);
}
async function sulamaSil(id) { await dbDel("waterings", Number(id)); }

async function hasatEkle(tree_id, harvested_on, amount, unit, note) {
  await dbAdd("harvests", {
    tree_id, harvested_on,
    amount: amount == null ? null : Number(amount),
    unit: unit || null, note: note || null, created_at: nowIso(),
  });
  return agacDetay(tree_id);
}
async function hasatSil(id) { await dbDel("harvests", Number(id)); }

// ---------------------------------------------------------------------------
// Çizimler (shapes)
// ---------------------------------------------------------------------------
async function sekilListe() {
  const list = await dbGetAll("shapes");
  return list.sort((a, b) => a.id - b.id).map((s) => ({ id: s.id, geojson: s.geojson }));
}
async function sekilEkle(geojson) {
  const id = await dbAdd("shapes", { geojson, created_at: nowIso() });
  return { id, geojson };
}
async function sekilSil(id) { await dbDel("shapes", Number(id)); }

// ---------------------------------------------------------------------------
// Yedekleme (JSON dışa/içe aktar) + WhatsApp vb. paylaşım
// ---------------------------------------------------------------------------
function blobDataUrl(blob) {
  return new Promise((resolve) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => resolve(null); // bozuk blob → dışa aktarım donmasın
    try { fr.readAsDataURL(blob); } catch (_) { resolve(null); }
  });
}
function dataUrlBlob(dataUrl) {
  try {
    if (typeof dataUrl !== "string" || dataUrl.indexOf(",") < 0) return null;
    const [bas, b64] = dataUrl.split(",");
    const tur = (bas.match(/data:(.*?);/) || [])[1] || "image/png";
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: tur });
  } catch (_) {
    return null; // bozuk base64 → görseli atla (veriyi silme/patlatma)
  }
}

async function disaAktar() {
  const [trees, species, waterings, harvests, shapes, settings, gorsel] = await Promise.all([
    dbGetAll("trees"), dbGetAll("species"), dbGetAll("waterings"),
    dbGetAll("harvests"), dbGetAll("shapes"), dbGetAll("settings"),
    dbGet("meta", "field_image"),
  ]);
  return {
    surum: 1,
    tarih: new Date().toISOString(),
    trees, species, waterings, harvests, shapes, settings,
    field_image: gorsel && gorsel.blob ? await blobDataUrl(gorsel.blob) : null,
  };
}

async function iceAktar(veri) {
  // --- Doğrulama (bozuk dosya mevcut veriyi ASLA silmesin) ---
  if (!veri || typeof veri !== "object" || veri.surum == null)
    throw new Error("Geçersiz yedek dosyası");
  const diziMi = (x) => x == null || Array.isArray(x);
  if (![veri.trees, veri.species, veri.waterings, veri.harvests, veri.shapes, veri.settings].every(diziMi))
    throw new Error("Yedek dosyası bozuk (beklenen alanlar dizi değil)");

  // --- 1) Riskli işlemleri SİLMEDEN ÖNCE yap ---
  const spById = new Map((veri.species || []).map((s) => [s.id, s]));
  const gecerliAgaclar = [];
  for (const t of veri.trees || []) {
    // Bozuk ağaçları atla (kimlik/konum şart)
    if (!t || t.id == null || typeof t.lat !== "number" || typeof t.lng !== "number") continue;
    if (!t.category) {
      const sp = t.species_id != null ? spById.get(t.species_id) : null;
      t.category = kategoriCoz(sp && sp.name, sp && sp.icon);
    }
    gecerliAgaclar.push(t);
  }
  // Görseli önceden çöz; bozuksa null (görseli atla, veriyi silme)
  const gorselBlob = veri.field_image ? dataUrlBlob(veri.field_image) : null;

  // --- 2) Artık güvenli → temizle ve yaz ---
  for (const s of ["trees", "species", "waterings", "harvests", "shapes", "settings", "meta"]) {
    await dbClear(s);
  }
  for (const t of gecerliAgaclar) await dbPut("trees", t);
  for (const s of veri.species || []) await dbPut("species", s);
  for (const w of veri.waterings || []) await dbPut("waterings", w);
  for (const h of veri.harvests || []) await dbPut("harvests", h);
  for (const sh of veri.shapes || []) await dbPut("shapes", sh);
  for (const st of veri.settings || []) await dbPut("settings", st);
  if (gorselBlob) await dbPut("meta", { key: "field_image", blob: gorselBlob });
}

async function yedekPaylas() {
  const veri = await disaAktar();
  const gun = new Date().toISOString().slice(0, 10);
  const ad = `ciftlik-yedek-${gun}.json`;
  const blob = new Blob([JSON.stringify(veri)], { type: "application/json" });
  const file = new File([blob], ad, { type: "application/json" });

  // Web Share (WhatsApp, Drive, e-posta...) — desteklenmiyorsa indir
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: "Çiftlik Yedeği", text: "Çiftlik verisi yedeği" });
      return;
    } catch (e) { if (e && e.name === "AbortError") return; }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = ad;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// ---------------------------------------------------------------------------
// Yerel API yönlendirici — eski fetch('/api/...') çağrılarını karşılar
// ---------------------------------------------------------------------------
function govdeCoz(options) {
  const b = options && options.body;
  if (b == null) return null;
  if (typeof b === "string") { try { return JSON.parse(b); } catch { return null; } }
  return b; // düz nesne
}

async function localApi(url, options = {}) {
  const method = (options.method || "GET").toUpperCase();
  const yol = url.split("?")[0];
  const p = yol.split("/").filter(Boolean); // ["api","trees",...]
  const govde = govdeCoz(options);

  // /api/config
  if (yol === "/api/config") {
    if (method === "PATCH") {
      if (govde && govde.watering_threshold_days != null)
        await ayarYaz("watering_threshold_days", Math.max(0, parseInt(govde.watering_threshold_days, 10) || 0));
    }
    return { field_image_url: await gorselUrlAl(), watering_threshold_days: await sulamaEsigi() };
  }

  // /api/field-image (FormData: file)
  if (yol === "/api/field-image" && method === "POST") {
    const dosya = options.body && options.body.get && options.body.get("file");
    if (!dosya) throw new Error("Görsel yok");
    return { field_image_url: await gorselKaydet(dosya) };
  }

  // /api/species
  if (yol === "/api/species") {
    if (method === "GET") return cinsListe();
    if (method === "POST") {
      const ad = (govde.name || "").trim();
      if (!ad) throw new Error("Cins adı boş olamaz");
      return cinsEkle(ad, govde.icon, govde.color);
    }
  }
  if (p[0] === "api" && p[1] === "species" && p[2]) {
    if (method === "PATCH") { await cinsGuncelle(p[2], govde || {}); return { ok: true }; }
    if (method === "DELETE") { await cinsSil(p[2]); return { ok: true }; }
  }

  // /api/trees
  if (yol === "/api/trees") {
    if (method === "GET") return agacListe();
    if (method === "POST") return agacOlustur(govde.lat, govde.lng, govde.label);
  }
  if (p[0] === "api" && p[1] === "trees" && p[2] && !p[3]) {
    if (method === "GET") { const t = await agacDetay(p[2]); if (!t) throw new Error("Ağaç bulunamadı"); return t; }
    if (method === "PATCH") return agacGuncelle(p[2], govde || {});
    if (method === "DELETE") { await agacSil(p[2]); return { ok: true }; }
  }
  // /api/trees/:id/waterings , /harvests
  if (p[0] === "api" && p[1] === "trees" && p[2] && p[3] === "waterings" && method === "POST") {
    return sulamaEkle(p[2], govde.watered_on, govde.note);
  }
  if (p[0] === "api" && p[1] === "trees" && p[2] && p[3] === "harvests" && method === "POST") {
    return hasatEkle(p[2], govde.harvested_on, govde.amount, govde.unit, govde.note);
  }
  if (p[0] === "api" && p[1] === "waterings" && p[2] && method === "DELETE") {
    await sulamaSil(p[2]); return { ok: true };
  }
  if (p[0] === "api" && p[1] === "harvests" && p[2] && method === "DELETE") {
    await hasatSil(p[2]); return { ok: true };
  }

  // /api/shapes
  if (yol === "/api/shapes") {
    if (method === "GET") return sekilListe();
    if (method === "POST") return sekilEkle(govde.geojson);
  }
  if (p[0] === "api" && p[1] === "shapes" && p[2] && method === "DELETE") {
    await sekilSil(p[2]); return { ok: true };
  }

  throw new Error("Bilinmeyen istek: " + method + " " + yol);
}

// Dışarıya aç
window.localApi = localApi;
window.KATEGORILER = KATEGORILER;
window.ciftlikStore = { disaAktar, iceAktar, yedekPaylas, dbAc, KATEGORILER, KAT_AD };
