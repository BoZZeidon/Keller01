// ============================================================
//  MATERIALKELLER – Bestandsverwaltung mit QR-Etiketten
//  Node.js / Express – SQLite (node:sqlite) mit JSON-Fallback
// ============================================================

// ----------------- CONFIG -----------------
const CONFIG = {
  PORT: process.env.PORT || 3050,
  // Basis-URL, die in die QR-Codes gedruckt wird.
  // Leer lassen => wird automatisch aus dem Request übernommen.
  // Für gedruckte Etiketten UNBEDINGT fest setzen, z. B.:
  // BASE_URL: "https://lager.button-game.net"
  BASE_URL: process.env.BASE_URL || "",
  DATA_DIR: require("path").join(__dirname, "data"),
  // Etiketten-Layout (A4): 3 Spalten x 7 Reihen = 21 Etiketten/Seite
  LABEL: { COLS: 3, ROWS: 7, MARGIN_X: 20, MARGIN_Y: 30 },
};
// -------------------------------------------

const express = require("express");
const path = require("path");
const fs = require("fs");
const PDFDocument = require("pdfkit");
const QRCode = require("qrcode");
const ExcelJS = require("exceljs");

fs.mkdirSync(CONFIG.DATA_DIR, { recursive: true });

// ================= STORAGE =================
// Nutzt node:sqlite (Node >= 22.5). Falls nicht verfügbar,
// automatischer Fallback auf JSON-Datei (data/lager.json).
let store;
try {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(path.join(CONFIG.DATA_DIR, "lager.db"));
  db.exec(`CREATE TABLE IF NOT EXISTS artikel (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nummer TEXT NOT NULL DEFAULT '',
    name   TEXT NOT NULL DEFAULT '',
    kiste  TEXT NOT NULL DEFAULT '',
    menge  INTEGER NOT NULL DEFAULT 0,
    ref    TEXT NOT NULL DEFAULT '',
    notiz  TEXT NOT NULL DEFAULT '',
    geaendert TEXT NOT NULL DEFAULT ''
  )`);
  store = {
    typ: "sqlite",
    all: () => db.prepare("SELECT * FROM artikel ORDER BY name COLLATE NOCASE").all(),
    get: (id) => db.prepare("SELECT * FROM artikel WHERE id = ?").get(id),
    insert: (a) =>
      db.prepare(
        "INSERT INTO artikel (nummer,name,kiste,menge,ref,notiz,geaendert) VALUES (?,?,?,?,?,?,?)"
      ).run(a.nummer, a.name, a.kiste, a.menge, a.ref, a.notiz, a.geaendert).lastInsertRowid,
    update: (id, a) =>
      db.prepare(
        "UPDATE artikel SET nummer=?,name=?,kiste=?,menge=?,ref=?,notiz=?,geaendert=? WHERE id=?"
      ).run(a.nummer, a.name, a.kiste, a.menge, a.ref, a.notiz, a.geaendert, id),
    remove: (id) => db.prepare("DELETE FROM artikel WHERE id = ?").run(id),
  };
  console.log("[Storage] SQLite aktiv (data/lager.db)");
} catch (e) {
  // ---------- JSON-Fallback ----------
  const FILE = path.join(CONFIG.DATA_DIR, "lager.json");
  let state = { nextId: 1, artikel: [] };
  if (fs.existsSync(FILE)) state = JSON.parse(fs.readFileSync(FILE, "utf8"));
  const save = () => {
    const tmp = FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, FILE);
  };
  store = {
    typ: "json",
    all: () =>
      [...state.artikel].sort((a, b) =>
        a.name.localeCompare(b.name, "de", { sensitivity: "base" })
      ),
    get: (id) => state.artikel.find((a) => a.id === Number(id)),
    insert: (a) => {
      const id = state.nextId++;
      state.artikel.push({ id, ...a });
      save();
      return id;
    },
    update: (id, a) => {
      const i = state.artikel.findIndex((x) => x.id === Number(id));
      if (i >= 0) { state.artikel[i] = { id: Number(id), ...a }; save(); }
    },
    remove: (id) => {
      state.artikel = state.artikel.filter((x) => x.id !== Number(id));
      save();
    },
  };
  console.log("[Storage] JSON-Fallback aktiv (data/lager.json) –", e.message);
}

// ================= HELFER =================
const clean = (b) => ({
  nummer: String(b.nummer ?? "").trim(),
  name: String(b.name ?? "").trim(),
  kiste: String(b.kiste ?? "").trim(),
  menge: Math.max(0, parseInt(b.menge, 10) || 0),
  ref: String(b.ref ?? "").trim(),
  notiz: String(b.notiz ?? "").trim(),
  geaendert: new Date().toISOString(),
});

const baseUrl = (req) =>
  CONFIG.BASE_URL || `${req.protocol}://${req.get("host")}`;

const artikelUrl = (req, id) => `${baseUrl(req)}/#a=${id}`;

// ================= APP =================
const app = express();
app.set("trust proxy", true);
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

// ---- Artikel-Liste (+Suche über alle Felder) ----
app.get("/api/artikel", (req, res) => {
  const q = String(req.query.q ?? "").toLowerCase().trim();
  let liste = store.all();
  if (q) {
    liste = liste.filter((a) =>
      [a.nummer, a.name, a.kiste, a.ref, a.notiz, String(a.id)]
        .some((f) => String(f).toLowerCase().includes(q))
    );
  }
  res.json(liste);
});

app.get("/api/artikel/:id", (req, res) => {
  const a = store.get(req.params.id);
  if (!a) return res.status(404).json({ fehler: "Artikel nicht gefunden" });
  res.json(a);
});

app.post("/api/artikel", (req, res) => {
  const a = clean(req.body);
  if (!a.name) return res.status(400).json({ fehler: "Artikelname fehlt" });
  const id = store.insert(a);
  res.json({ id: Number(id), ...a });
});

app.put("/api/artikel/:id", (req, res) => {
  if (!store.get(req.params.id))
    return res.status(404).json({ fehler: "Artikel nicht gefunden" });
  const a = clean(req.body);
  store.update(req.params.id, a);
  res.json({ id: Number(req.params.id), ...a });
});

// Schnelles +/- der Menge
app.patch("/api/artikel/:id/menge", (req, res) => {
  const alt = store.get(req.params.id);
  if (!alt) return res.status(404).json({ fehler: "Artikel nicht gefunden" });
  const neu = clean({ ...alt, menge: (alt.menge || 0) + (parseInt(req.body.delta, 10) || 0) });
  store.update(req.params.id, neu);
  res.json({ id: Number(req.params.id), ...neu });
});

app.delete("/api/artikel/:id", (req, res) => {
  store.remove(req.params.id);
  res.json({ ok: true });
});

// ---- QR-Etiketten als PDF (A4, druckfertig) ----
// /api/labels.pdf            -> alle Artikel
// /api/labels.pdf?ids=1,4,7  -> Auswahl
app.get("/api/labels.pdf", async (req, res) => {
  let liste = store.all();
  if (req.query.ids) {
    const ids = String(req.query.ids).split(",").map(Number);
    liste = ids.map((id) => liste.find((a) => a.id === id)).filter(Boolean);
  }
  if (!liste.length) return res.status(400).json({ fehler: "Keine Artikel" });

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", 'attachment; filename="etiketten.pdf"');

  const doc = new PDFDocument({ size: "A4", margin: 0 });
  doc.pipe(res);

  const { COLS, ROWS, MARGIN_X, MARGIN_Y } = CONFIG.LABEL;
  const W = (595.28 - 2 * MARGIN_X) / COLS;   // Etikettbreite
  const H = (841.89 - 2 * MARGIN_Y) / ROWS;   // Etiketthöhe
  const PER_PAGE = COLS * ROWS;

  for (let i = 0; i < liste.length; i++) {
    const a = liste[i];
    const pos = i % PER_PAGE;
    if (i > 0 && pos === 0) doc.addPage();
    const x = MARGIN_X + (pos % COLS) * W;
    const y = MARGIN_Y + Math.floor(pos / COLS) * H;

    // Schnittrahmen
    doc.rect(x + 2, y + 2, W - 4, H - 4).lineWidth(0.5).stroke("#999999");

    // QR-Code
    const qrSize = H - 16;
    const png = await QRCode.toBuffer(artikelUrl(req, a.id), {
      margin: 0, width: 300, errorCorrectionLevel: "M",
    });
    doc.image(png, x + 8, y + 8, { width: qrSize, height: qrSize });

    // Text rechts neben dem QR
    const tx = x + 8 + qrSize + 8;
    const tw = W - qrSize - 28;
    doc.fillColor("#000000");
    doc.font("Helvetica-Bold").fontSize(9)
      .text(a.name, tx, y + 10, { width: tw, height: 22, ellipsis: true });
    doc.font("Courier").fontSize(7)
      .text(a.nummer || "-", tx, y + 36, { width: tw, height: 9, ellipsis: true })
      .text(a.ref ? `REF ${a.ref}` : "-", tx, y + 47, { width: tw, height: 9, ellipsis: true });
    doc.font("Helvetica-Bold").fontSize(11)
      .text(`KISTE ${a.kiste || "-"}`, tx, y + 62, { width: tw, height: 13, ellipsis: true });
  }
  doc.end();
});

// ---- Excel-Export (immer aktueller Bestand) ----
app.get("/api/export.xlsx", async (req, res) => {
  const wb = new ExcelJS.Workbook();
  wb.created = new Date();
  const ws = wb.addWorksheet("Bestand", {
    views: [{ state: "frozen", ySplit: 1 }],
  });
  ws.columns = [
    { header: "ID", key: "id", width: 8 },
    { header: "Artikelnummer", key: "nummer", width: 20 },
    { header: "Artikelname", key: "name", width: 36 },
    { header: "Kiste", key: "kiste", width: 12 },
    { header: "Menge", key: "menge", width: 10 },
    { header: "REF-Nr", key: "ref", width: 18 },
    { header: "Notiz", key: "notiz", width: 30 },
    { header: "Geändert", key: "geaendert", width: 22 },
  ];
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).fill = {
    type: "pattern", pattern: "solid", fgColor: { argb: "FF2C342C" },
  };
  ws.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  ws.autoFilter = "A1:H1";
  store.all().forEach((a) => ws.addRow(a));

  const datum = new Date().toISOString().slice(0, 10);
  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  );
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="Materialkeller_${datum}.xlsx"`
  );
  await wb.xlsx.write(res);
  res.end();
});

// ---- Excel-Import (erstmaliges Befüllen / Massenanlage) ----
// Erwartete Spalten (Reihenfolge egal, erkennt Kopfzeile):
// Artikelnummer | Artikelname | Kiste | Menge | REF-Nr | Notiz
app.post(
  "/api/import",
  express.raw({ type: ["application/*", "application/octet-stream"], limit: "20mb" }),
  async (req, res) => {
    try {
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(req.body);
      const ws = wb.worksheets[0];
      if (!ws) return res.status(400).json({ fehler: "Kein Tabellenblatt gefunden" });

      // Kopfzeile -> Spaltenindex
      const map = {};
      ws.getRow(1).eachCell((cell, col) => {
        const h = String(cell.value ?? "").toLowerCase();
        if (h.includes("nummer") && !h.includes("ref")) map.nummer = col;
        else if (h.includes("name")) map.name = col;
        else if (h.includes("kiste")) map.kiste = col;
        else if (h.includes("menge") || h.includes("anzahl")) map.menge = col;
        else if (h.includes("ref")) map.ref = col;
        else if (h.includes("notiz")) map.notiz = col;
      });
      if (!map.name)
        return res.status(400).json({ fehler: "Spalte 'Artikelname' nicht gefunden" });

      let anzahl = 0;
      ws.eachRow((row, nr) => {
        if (nr === 1) return;
        const wert = (c) => (c ? String(row.getCell(c).value ?? "").trim() : "");
        const a = clean({
          nummer: wert(map.nummer),
          name: wert(map.name),
          kiste: wert(map.kiste),
          menge: wert(map.menge),
          ref: wert(map.ref),
          notiz: wert(map.notiz),
        });
        if (a.name) { store.insert(a); anzahl++; }
      });
      res.json({ ok: true, importiert: anzahl });
    } catch (e) {
      res.status(400).json({ fehler: "Datei konnte nicht gelesen werden: " + e.message });
    }
  }
);

app.listen(CONFIG.PORT, () =>
  console.log(`Materialkeller läuft auf http://localhost:${CONFIG.PORT}`)
);
