/* etiket.js — Ağaç tasması (kartvizit tarzı etiket) PDF üretimi.
   - Üstte DELİK yeri (kablo/cırt bağı geçsin).
   - Türün ağaç ikonu (app.js'teki SVG, PNG'ye çevrilip gömülür).
   - Numara + tür + kısa UUID + QR (ağacı açan derin bağlantı).
   - Arkalı-önlü; çift taraflı basımda "uzun kenardan çevir" ile hizalı.
   jsPDF + qrcode-generator. QR vektör olduğu için PDF küçük kalır. */

"use strict";

// Çiftlik adı — tasmanın altında yazar
const CIFTLIK_ADI = "Şerafettin Canaz Çiftliği";

// jsPDF gömülü fontları Türkçe ş/ğ/ı basmaz → ASCII'ye çevir
function trAscii(s) {
  return String(s == null ? "" : s)
    .replace(/ş/g, "s").replace(/Ş/g, "S").replace(/ı/g, "i").replace(/İ/g, "I")
    .replace(/ğ/g, "g").replace(/Ğ/g, "G").replace(/ç/g, "c").replace(/Ç/g, "C")
    .replace(/ö/g, "o").replace(/Ö/g, "O").replace(/ü/g, "u").replace(/Ü/g, "U");
}

// Dikim yılı ve yaş (planted_on'dan). planted_on yoksa boş döner.
function dikimYili(p) {
  return p ? String(p).slice(0, 4) : "";
}
function yasKisa(p) {
  if (!p) return "";
  const d = new Date(p + "T00:00:00");
  if (isNaN(d)) return "";
  const gun = (Date.now() - d.getTime()) / 86400000;
  if (gun < 0) return "";
  const yil = gun / 365.25;
  if (yil < 1) return "~" + Math.round(gun / 30) + " ay";
  return "~" + (yil < 10 ? yil.toFixed(1) : Math.round(yil)) + " yas";
}
// "~5 yas  |  2020" (planted_on yoksa boş)
function yasYilMetni(p) {
  return [yasKisa(p), dikimYili(p)].filter(Boolean).join("  |  ");
}

// Yazıyı tek satırda tut: sığmıyorsa fontu küçült (satır kayması/çakışma olmasın)
function tekSatir(doc, txt, x, y, maxW, baseSize, minSize, opt) {
  let s = baseSize;
  doc.setFontSize(s);
  while (s > minSize && doc.getTextWidth(txt) > maxW) {
    s -= 0.5;
    doc.setFontSize(s);
  }
  doc.text(txt, x, y, opt || {});
}

// --- Tür ikonunu (app.js SVG) PNG'ye çevir (bir kez, önbelleğe al) ---
const ikonPngCache = {};
function ikonPngUret(key) {
  if (ikonPngCache[key]) return Promise.resolve(ikonPngCache[key]);
  if (typeof ikonIcSvg !== "function") return Promise.resolve(null);
  return new Promise((resolve) => {
    const W = 160, H = 170; // viewBox 32x34 oranı
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 34" width="${W}" height="${H}">${ikonIcSvg(key)}</svg>`;
    const img = new Image();
    img.onload = () => {
      try {
        const cv = document.createElement("canvas");
        cv.width = W; cv.height = H;
        const g = cv.getContext("2d");
        g.fillStyle = "#ffffff"; g.fillRect(0, 0, W, H); // beyaz zemin (kart beyaz)
        g.drawImage(img, 0, 0, W, H);
        ikonPngCache[key] = cv.toDataURL("image/png");
      } catch (_) { ikonPngCache[key] = null; }
      resolve(ikonPngCache[key]);
    };
    img.onerror = () => resolve(null);
    img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  });
}

// QR'ı vektör kareler olarak çiz (dosya küçük kalır)
function qrCiz(doc, metin, x, y, boyut) {
  const qr = qrcode(0, "M");
  qr.addData(metin);
  qr.make();
  const n = qr.getModuleCount();
  const cell = boyut / n;
  doc.setFillColor(0, 0, 0);
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (qr.isDark(r, c)) doc.rect(x + c * cell, y + r * cell, cell, cell, "F");
    }
  }
}

// Kablo bağı deliği: YATAY ELİPS (yarık) — düz/yassı kablo bağı rahat geçsin
function delikCiz(doc, cx, cy) {
  doc.setDrawColor(110);
  doc.setLineWidth(0.3);
  doc.ellipse(cx, cy, 2.9, 1.25, "S");   // ~5.8 × 2.5 mm yarık
}

function kart(doc, x, y, w, h) {
  doc.setDrawColor(46, 125, 50);
  doc.setLineWidth(0.35);
  doc.roundedRect(x + 0.6, y + 0.6, w - 1.2, h - 1.2, 1.8, 1.8, "S");
}

function onYuz(doc, agac, x, y, w, h, base) {
  const pad = 2.4;
  const band = Math.max(7, h * 0.17);
  const foot = Math.max(3.8, h * 0.1);
  const buyuk = w > 80;

  kart(doc, x, y, w, h);
  delikCiz(doc, x + w / 2, y + band * 0.62);
  doc.setDrawColor(215); doc.setLineWidth(0.15);
  doc.line(x + pad, y + band, x + w - pad, y + band);

  const bodyY = y + band;
  const bodyH = h - band - foot;

  // Tür ikonu (sol)
  const iconH = Math.min(bodyH - 1, w * 0.26);
  const iconW = iconH * 32 / 34;
  const ix = x + pad;
  const iy = bodyY + (bodyH - iconH) / 2;
  const kat = agac.category || "genel";
  if (ikonPngCache[kat]) doc.addImage(ikonPngCache[kat], "PNG", ix, iy, iconW, iconH, kat, "FAST");

  // QR (sağ)
  const qr = Math.min(bodyH - 1, w * 0.30);
  const qx = x + w - pad - qr;
  const qy = bodyY + (bodyH - qr) / 2;
  qrCiz(doc, base + "#t=" + agac.id, qx, qy, qr);

  // Orta: numara + tür + yaş/yıl (hepsi tek satır, sığmazsa küçülür)
  const tx = ix + iconW + 2.5;
  const tw = qx - tx - 2;
  let ty = bodyY + bodyH * 0.32;
  doc.setFont("helvetica", "bold");
  doc.setTextColor(25, 25, 25);
  tekSatir(doc, trAscii(agac.label || "-"), tx, ty, tw, buyuk ? 28 : 15, buyuk ? 12 : 7);
  ty += buyuk ? 9 : 6;
  doc.setFont("helvetica", "normal");
  doc.setTextColor(46, 125, 50);
  tekSatir(doc, trAscii(agac.species_name || "Genel Ağaç"), tx, ty, tw, buyuk ? 12 : 8.5, buyuk ? 8 : 6);
  const bilgi = yasYilMetni(agac.planted_on);
  if (bilgi) {
    ty += buyuk ? 6.5 : 4.2;
    doc.setTextColor(110);
    tekSatir(doc, bilgi, tx, ty, tw, buyuk ? 9 : 6.2, buyuk ? 7 : 5);
  }

  // Footer: çiftlik adı + kısa uuid
  doc.setFont("helvetica", "normal");
  doc.setTextColor(150);
  tekSatir(doc, trAscii(CIFTLIK_ADI), x + pad, y + h - foot * 0.32, w * 0.64, buyuk ? 7.5 : 5.5, 4.2);
  doc.setFontSize(buyuk ? 7 : 5.5);
  doc.text(String(agac.id).slice(0, 8), x + w - pad, y + h - foot * 0.32, { align: "right" });
}

function arkaYuz(doc, agac, x, y, w, h) {
  const pad = 2.4;
  const band = Math.max(7, h * 0.17);
  const foot = Math.max(3.8, h * 0.1);
  const buyuk = w > 80;

  kart(doc, x, y, w, h);
  delikCiz(doc, x + w / 2, y + band * 0.62);

  const bodyY = y + band;
  const bodyH = h - band - foot;
  const kat = agac.category || "genel";

  // İkon (üstte, ortada)
  const iconH = Math.min(bodyH * 0.5, w * 0.22);
  const iconW = iconH * 32 / 34;
  if (ikonPngCache[kat]) doc.addImage(ikonPngCache[kat], "PNG", x + w / 2 - iconW / 2, bodyY + 1, iconW, iconH, kat, "FAST");

  const orta = { align: "center" };
  let ty = bodyY + bodyH * 0.68;
  doc.setFont("helvetica", "bold");
  doc.setTextColor(25, 25, 25);
  tekSatir(doc, trAscii(agac.label || "-"), x + w / 2, ty, w - 2 * pad, buyuk ? 30 : 16, buyuk ? 12 : 8, orta);
  ty += buyuk ? 8 : 5.5;
  doc.setFont("helvetica", "normal");
  doc.setTextColor(46, 125, 50);
  tekSatir(doc, trAscii(agac.species_name || "Genel Ağaç"), x + w / 2, ty, w - 2 * pad, buyuk ? 12 : 8.5, buyuk ? 8 : 6, orta);

  doc.setTextColor(150);
  tekSatir(doc, trAscii(CIFTLIK_ADI), x + w / 2, y + h - foot * 0.32, w - 2 * pad, buyuk ? 7.5 : 5.5, 4.2, orta);
}

async function etiketPdfOlustur(opt) {
  const btn = document.getElementById("etiket-pdf");
  const eski = btn ? btn.textContent : "";
  try {
    if (btn) { btn.disabled = true; btn.textContent = "Oluşturuluyor…"; }
    const agaclar = await window.localApi("/api/trees");
    if (!agaclar.length) { alert("Etiket için önce ağaç ekle."); return; }
    if (!window.jspdf || !window.jspdf.jsPDF) throw new Error("PDF kütüphanesi yüklenemedi");
    if (typeof qrcode !== "function") throw new Error("QR kütüphanesi yüklenemedi");

    // Tür ikonlarını önceden PNG'ye çevir (her kategori bir kez)
    const kategoriler = [...new Set(agaclar.map((a) => a.category || "genel"))];
    await Promise.all(kategoriler.map(ikonPngUret));

    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: "mm", format: "a4" });
    const M = 8;
    const P = opt.boyut === "buyuk" ? { cols: 2, rows: 4 } : { cols: 3, rows: 8 };
    const gw = (210 - 2 * M) / P.cols;
    const gh = (297 - 2 * M) / P.rows;
    const perPage = P.cols * P.rows;
    const base = location.origin + location.pathname.replace(/[^/]*$/, "");

    let ilk = true;
    for (let s = 0; s < agaclar.length; s += perPage) {
      const dilim = agaclar.slice(s, s + perPage);
      if (!ilk) doc.addPage();
      ilk = false;
      dilim.forEach((agac, i) => {
        const c = i % P.cols, r = Math.floor(i / P.cols);
        onYuz(doc, agac, M + c * gw, M + r * gh, gw, gh, base);
      });
      if (opt.arkali) {
        doc.addPage();
        dilim.forEach((agac, i) => {
          const c = i % P.cols, r = Math.floor(i / P.cols);
          const cm = P.cols - 1 - c; // "uzun kenardan çevir" hizası
          arkaYuz(doc, agac, M + cm * gw, M + r * gh, gw, gh);
        });
      }
    }
    doc.save(`ciftlik-etiketler-${new Date().toISOString().slice(0, 10)}.pdf`);
  } catch (e) {
    alert("PDF oluşturulamadı: " + (e && e.message ? e.message : e));
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = eski; }
  }
}

document.addEventListener("DOMContentLoaded", () => {
  const btn = document.getElementById("etiket-pdf");
  if (!btn) return;
  btn.addEventListener("click", () =>
    etiketPdfOlustur({
      boyut: (document.getElementById("etiket-boyut") || {}).value || "kucuk",
      arkali: (document.getElementById("etiket-arkali") || {}).checked !== false,
    })
  );
});
