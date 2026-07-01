/* Ağaç tablosu — Excel benzeri, her sütuna göre sıralanabilir liste.
   Veriler haritayla aynı kaynaktan (SQLite) gelir. */

"use strict";

const $ = (id) => document.getElementById(id);

// Offline sürüm: veriler tarayıcıdaki IndexedDB'den (store.js) gelir.
async function api(url) {
  return window.localApi(url);
}

// Sütun tanımları: key (veri alanı), ad (başlık), tur (sıralama tipi)
const KOLONLAR = [
  { key: "label", ad: "Numara", tur: "metin" },
  { key: "species_name", ad: "Tür", tur: "metin" },
  { key: "planted_on", ad: "Dikim Tarihi", tur: "tarih" },
  { key: "_yasGun", ad: "Yaş", tur: "sayi", goster: "yas" },
  { key: "last_watered_on", ad: "Son Sulama", tur: "tarih" },
  { key: "needs_water", ad: "Su", tur: "bool", goster: "su" },
  { key: "total_harvest", ad: "Toplam Ürün", tur: "sayi", goster: "urun" },
  { key: "last_harvest_on", ad: "Son Hasat", tur: "tarih" },
  { key: "notes", ad: "Notlar", tur: "metin" },
  { key: "id", ad: "UUID", tur: "metin", goster: "uuid" },
];

let agaclar = [];
let siralama = { key: "label", yon: 1 }; // varsayılan: numaraya göre artan

document.addEventListener("DOMContentLoaded", async () => {
  basliklariCiz();
  await agaclariYukle();
  $("yenile").addEventListener("click", agaclariYukle);
  $("arama").addEventListener("input", tabloCiz);
});

async function agaclariYukle() {
  agaclar = await api("/api/trees");
  // Yaş (gün) hesapla — sıralama için
  const simdi = Date.now();
  agaclar.forEach((a) => {
    if (a.planted_on) {
      const d = new Date(a.planted_on).getTime();
      a._yasGun = isNaN(d) ? null : Math.max(0, (simdi - d) / 86400000);
    } else {
      a._yasGun = null;
    }
  });
  tabloCiz();
}

// ---------------------------------------------------------------------------
function basliklariCiz() {
  const tr = document.createElement("tr");
  KOLONLAR.forEach((kol) => {
    const th = document.createElement("th");
    th.textContent = kol.ad;
    th.dataset.key = kol.key;
    th.classList.add("siralanabilir");
    th.addEventListener("click", () => {
      if (siralama.key === kol.key) siralama.yon *= -1;
      else siralama = { key: kol.key, yon: 1 };
      tabloCiz();
    });
    tr.appendChild(th);
  });
  $("tablo-baslik").innerHTML = "";
  $("tablo-baslik").appendChild(tr);
}

function okIsareti(key) {
  if (siralama.key !== key) return "";
  return siralama.yon === 1 ? " ▲" : " ▼";
}

function tabloCiz() {
  // Başlık oklarını güncelle
  $("tablo-baslik").querySelectorAll("th").forEach((th) => {
    const kol = KOLONLAR.find((k) => k.key === th.dataset.key);
    th.textContent = kol.ad + okIsareti(kol.key);
    th.classList.toggle("aktif-sira", siralama.key === kol.key);
  });

  // Filtre (arama)
  const q = $("arama").value.trim().toLocaleLowerCase("tr");
  let liste = agaclar;
  if (q) {
    liste = agaclar.filter((a) => {
      const alanlar = [a.label, a.species_name, a.notes, a.planted_on];
      return alanlar.some((v) => v && String(v).toLocaleLowerCase("tr").includes(q));
    });
  }

  // Sırala
  const kol = KOLONLAR.find((k) => k.key === siralama.key) || KOLONLAR[0];
  liste = [...liste].sort((a, b) => kiyasla(a, b, kol, siralama.yon));

  // Çiz
  const govde = $("tablo-govde");
  govde.innerHTML = "";
  liste.forEach((a) => govde.appendChild(satirYap(a)));

  $("agac-sayisi").textContent = `${liste.length} ağaç`;
  $("bos-mesaj").classList.toggle("gizli", agaclar.length > 0);
}

function satirYap(a) {
  const tr = document.createElement("tr");
  KOLONLAR.forEach((kol) => {
    const td = document.createElement("td");
    td.innerHTML = hucreIcerik(a, kol);
    tr.appendChild(td);
  });
  return tr;
}

function trTarih(iso) {
  if (!iso) return "";
  const p = String(iso).slice(0, 10).split("-");
  return p.length === 3 ? `${p[2]}.${p[1]}.${p[0]}` : iso;
}

function hucreIcerik(a, kol) {
  const v = a[kol.key];
  if (kol.tur === "tarih") return v ? trTarih(v) : "—";
  switch (kol.goster) {
    case "yas":
      return yasMetin(a.planted_on) || "—";
    case "su":
      return a.needs_water
        ? '<span class="rozet su-lazim">💧 Lazım</span>'
        : '<span class="rozet su-tamam">✔</span>';
    case "urun":
      return a.total_harvest ? `${Number(a.total_harvest).toLocaleString("tr")}` : "—";
    case "uuid":
      return `<code class="uuid-kucuk" title="${escapeHtml(v)}">${String(v).slice(0, 8)}…</code>`;
    default:
      if (kol.key === "species_name" && v) {
        return `🌳 ${escapeHtml(v)}`;
      }
      return v === null || v === undefined || v === "" ? "—" : escapeHtml(v);
  }
}

// ---------------------------------------------------------------------------
// Sıralama karşılaştırıcı — boş değerler her zaman sona
function kiyasla(a, b, kol, yon) {
  let va = a[kol.key];
  let vb = b[kol.key];
  const bosA = va === null || va === undefined || va === "";
  const bosB = vb === null || vb === undefined || vb === "";
  if (bosA && bosB) return 0;
  if (bosA) return 1;
  if (bosB) return -1;

  let c;
  if (kol.tur === "sayi") c = va - vb;
  else if (kol.tur === "bool") c = (va ? 1 : 0) - (vb ? 1 : 0);
  else if (kol.tur === "tarih") c = va < vb ? -1 : va > vb ? 1 : 0;
  else c = String(va).localeCompare(String(vb), "tr", { numeric: true });
  return c * yon;
}

// ---------------------------------------------------------------------------
function yasMetin(dikim) {
  if (!dikim) return "";
  const d = new Date(dikim);
  if (isNaN(d)) return "";
  const gun = (Date.now() - d.getTime()) / 86400000;
  if (gun < 0) return "";
  const yil = gun / 365.25;
  return yil < 1 ? `≈ ${Math.round(gun / 30)} ay` : `≈ ${yil.toFixed(1)} yıl`;
}

const RENK_PALETI = [
  "#2e7d32", "#1565c0", "#c62828", "#ef6c00", "#6a1b9a",
  "#00838f", "#9e9d24", "#4e342e", "#ad1457", "#283593",
];
function cinsRengi(id) {
  return id ? RENK_PALETI[id % RENK_PALETI.length] : "#9e9e9e";
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}
