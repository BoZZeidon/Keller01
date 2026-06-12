// ============================================================
//  KELLER 01 – Cloudflare Worker (Backend)
//  Einfügen unter: Cloudflare Dashboard -> Workers -> Edit code
//  Benötigt: KV-Namespace, gebunden unter dem Namen  KELLER
// ============================================================

// Nach der Einrichtung aller Konten auf false setzen und neu deployen:
const REGISTRIERUNG_OFFEN = true;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,Authorization",
};

const DEFAULT_LABELS = {
  name: "Artikelname", nummer: "Artikelnummer", kiste: "Kiste",
  menge: "Menge", soll: "Sollwert", ref: "REF-Nr", notiz: "Notiz",
  sortid: "SortID", aliase: "Andere Namen",
};

// ---------- Helfer ----------
const antwort = (daten, status = 200) =>
  new Response(JSON.stringify(daten), {
    status, headers: { "Content-Type": "application/json", ...CORS },
  });

const fehler = (text, status = 400) => antwort({ fehler: text }, status);

const randHex = (n) =>
  [...crypto.getRandomValues(new Uint8Array(n))]
    .map((b) => b.toString(16).padStart(2, "0")).join("");

async function hashPw(passwort, salzHex) {
  const salz = new Uint8Array(salzHex.match(/../g).map((h) => parseInt(h, 16)));
  const schluessel = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(passwort), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: salz, iterations: 100000 },
    schluessel, 256);
  return [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function kvJson(env, schluessel, standard) {
  const wert = await env.KELLER.get(schluessel);
  return wert ? JSON.parse(wert) : standard;
}

const datenLaden = async (env) => {
  const d = await kvJson(env, "daten", { naechsteId: 1, artikel: [], papierkorb: [] });
  if (!Array.isArray(d.papierkorb)) d.papierkorb = [];
  // Papierkorb: älter als 30 Tage endgültig löschen
  const limit = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const alt = d.papierkorb.filter((a) => new Date(a.geloescht).getTime() < limit);
  if (alt.length) {
    d.papierkorb = d.papierkorb.filter((a) => new Date(a.geloescht).getTime() >= limit);
    for (const a of alt) await env.KELLER.delete("foto:" + a.id).catch?.(() => {});
    await datenSpeichern(env, d);
  }
  return d;
};
const datenSpeichern = (env, d) => env.KELLER.put("daten", JSON.stringify(d));
const nutzerLaden = (env) => kvJson(env, "nutzer", []);
const configLaden = (env) =>
  kvJson(env, "config", { labels: { ...DEFAULT_LABELS }, felder: [], kistenFarben: {} });

function clean(b, felder) {
  const ganz = (w, std) => Number.isFinite(parseInt(w, 10)) ? parseInt(w, 10) : std;
  const extra = {};
  for (const f of felder || []) {
    const w = String(b.extra?.[f.key] ?? "").trim();
    if (w) extra[f.key] = w;
  }
  return {
    nummer: String(b.nummer ?? "").trim(),
    name: String(b.name ?? "").trim(),
    kiste: String(b.kiste ?? "").trim(),
    menge: Math.max(0, ganz(b.menge, 0)),
    soll: Math.max(0, ganz(b.soll, 0)),
    ref: String(b.ref ?? "").trim(),
    notiz: String(b.notiz ?? "").trim(),
    aliase: String(b.aliase ?? "").split(",").map((s) => s.trim()).filter(Boolean).join(", "),
    sortid: ganz(b.sortid, 100),
    thumb: typeof b.thumb === "string" && b.thumb.startsWith("data:image/") && b.thumb.length < 30000
      ? b.thumb : "",
    extra,
    geaendert: new Date().toISOString(),
  };
}

async function protokolliere(env, id, nutzer, delta, mengeNeu) {
  const log = await kvJson(env, "log:" + id, []);
  log.push({ zeit: new Date().toISOString(), nutzer, delta, menge: mengeNeu });
  await env.KELLER.put("log:" + id, JSON.stringify(log.slice(-50)));
}

async function angemeldeterNutzer(req, env) {
  const kopf = req.headers.get("Authorization") || "";
  const token = kopf.startsWith("Bearer ") ? kopf.slice(7) : "";
  if (!/^[a-f0-9]{64}$/.test(token)) return null;
  const name = await env.KELLER.get("sitzung:" + token);
  return name ? { benutzername: name, token } : null;
}

async function fotoSpeichern(env, id, fotoData) {
  // fotoData: null = unverändert, "" = löschen, "data:image/..." = ersetzen
  if (fotoData === null || fotoData === undefined) return null;
  if (fotoData === "") { await env.KELLER.delete("foto:" + id); return ""; }
  if (typeof fotoData === "string" && fotoData.startsWith("data:image/")
      && fotoData.length < 2_000_000) {
    await env.KELLER.put("foto:" + id, fotoData);
    return "1";
  }
  return null;
}

// ---------- Router ----------
export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS")
      return new Response(null, { status: 204, headers: CORS });

    const url = new URL(req.url);
    const pfad = url.pathname.replace(/\/+$/, "") || "/";
    const koerper = async () => { try { return await req.json(); } catch { return {}; } };

    // ===== AUTH (offen) =====
    if (pfad === "/auth/registrieren" && req.method === "POST") {
      const b = await koerper();
      const benutzername = String(b.benutzername ?? "").trim();
      const passwort = String(b.passwort ?? "");
      const nutzer = await nutzerLaden(env);
      if (!REGISTRIERUNG_OFFEN && nutzer.length > 0)
        return fehler("Registrierung ist deaktiviert", 403);
      if (benutzername.length < 3) return fehler("Benutzername: mindestens 3 Zeichen");
      if (passwort.length < 6) return fehler("Passwort: mindestens 6 Zeichen");
      if (nutzer.some((u) => u.benutzername === benutzername))
        return fehler("Benutzername ist schon vergeben", 409);
      const salz = randHex(16);
      nutzer.push({ benutzername, salz, hash: await hashPw(passwort, salz) });
      await env.KELLER.put("nutzer", JSON.stringify(nutzer));
      const token = randHex(32);
      await env.KELLER.put("sitzung:" + token, benutzername,
        { expirationTtl: 60 * 60 * 24 * 365 });
      return antwort({ ok: true, token, benutzername });
    }

    if (pfad === "/auth/login" && req.method === "POST") {
      const b = await koerper();
      const nutzer = (await nutzerLaden(env))
        .find((u) => u.benutzername === String(b.benutzername ?? "").trim());
      if (!nutzer || nutzer.hash !== await hashPw(String(b.passwort ?? ""), nutzer.salz))
        return fehler("Benutzername oder Passwort falsch", 401);
      const token = randHex(32);
      await env.KELLER.put("sitzung:" + token, nutzer.benutzername,
        { expirationTtl: 60 * 60 * 24 * 365 });
      return antwort({ ok: true, token, benutzername: nutzer.benutzername });
    }

    // ===== Ab hier: Anmeldung erforderlich =====
    const ich = await angemeldeterNutzer(req, env);
    if (!ich) return fehler("Nicht angemeldet", 401);

    if (pfad === "/auth/logout" && req.method === "POST") {
      await env.KELLER.delete("sitzung:" + ich.token);
      return antwort({ ok: true });
    }
    if (pfad === "/me") return antwort({ benutzername: ich.benutzername });

    // ===== CONFIG =====
    if (pfad === "/config" && req.method === "GET")
      return antwort(await configLaden(env));

    if (pfad === "/config" && req.method === "PUT") {
      const b = await koerper();
      const alt = await configLaden(env);
      const neu = { labels: { ...alt.labels }, felder: [], kistenFarben: {} };
      if (b.kistenFarben && typeof b.kistenFarben === "object") {
        for (const [kiste, farbe] of Object.entries(b.kistenFarben).slice(0, 100)) {
          if (/^#[0-9a-fA-F]{6}$/.test(String(farbe)))
            neu.kistenFarben[String(kiste).slice(0, 30)] = String(farbe);
        }
      }
      for (const k of Object.keys(DEFAULT_LABELS)) {
        const w = String(b.labels?.[k] ?? "").trim();
        neu.labels[k] = w || DEFAULT_LABELS[k];
      }
      for (const f of (Array.isArray(b.felder) ? b.felder : []).slice(0, 20)) {
        const label = String(f.label ?? "").trim().slice(0, 40);
        if (!label) continue;
        const key = /^f[a-z0-9]{6,}$/.test(String(f.key)) ? String(f.key) : "f" + randHex(5);
        neu.felder.push({ key, label });
      }
      await env.KELLER.put("config", JSON.stringify(neu));
      return antwort(neu);
    }

    // ===== ARTIKEL =====
    if (pfad === "/artikel" && req.method === "GET") {
      const d = await datenLaden(env);
      d.artikel.sort((a, b) => (a.sortid - b.sortid) ||
        a.name.localeCompare(b.name, "de", { sensitivity: "base" }));
      return antwort(d.artikel);
    }

    if (pfad === "/artikel" && req.method === "POST") {
      const b = await koerper();
      const cfg = await configLaden(env);
      const a = clean(b, cfg.felder);
      if (!a.name) return fehler("Artikelname fehlt");
      const d = await datenLaden(env);
      a.id = d.naechsteId++;
      a.entnommen = 0;
      a.foto = (await fotoSpeichern(env, a.id, b.fotoData ?? null)) || "";
      d.artikel.push(a);
      await datenSpeichern(env, d);
      return antwort(a);
    }

    const mArtikel = pfad.match(/^\/artikel\/(\d+)$/);
    const mMenge = pfad.match(/^\/artikel\/(\d+)\/menge$/);
    const mFoto = pfad.match(/^\/foto\/(\d+)$/);

    if (mArtikel && req.method === "GET") {
      const d = await datenLaden(env);
      const a = d.artikel.find((x) => x.id === Number(mArtikel[1]));
      return a ? antwort(a) : fehler("Artikel nicht gefunden", 404);
    }

    if (mArtikel && req.method === "PUT") {
      const b = await koerper();
      const cfg = await configLaden(env);
      const d = await datenLaden(env);
      const i = d.artikel.findIndex((x) => x.id === Number(mArtikel[1]));
      if (i < 0) return fehler("Artikel nicht gefunden", 404);
      const alt = d.artikel[i];
      const a = clean(b, cfg.felder);
      a.id = alt.id;
      a.entnommen = alt.entnommen || 0;
      if (a.menge !== alt.menge) {
        const diff = a.menge - alt.menge;
        if (diff < 0) a.entnommen += -diff;
        await protokolliere(env, a.id, ich.benutzername, diff, a.menge);
      }
      const fotoNeu = await fotoSpeichern(env, a.id, b.fotoData ?? null);
      a.foto = fotoNeu === null ? alt.foto : fotoNeu;
      if (fotoNeu === null) a.thumb = a.thumb || alt.thumb;
      if (fotoNeu === "") a.thumb = "";
      d.artikel[i] = a;
      await datenSpeichern(env, d);
      return antwort(a);
    }

    if (mMenge && req.method === "PATCH") {
      const b = await koerper();
      const d = await datenLaden(env);
      const a = d.artikel.find((x) => x.id === Number(mMenge[1]));
      if (!a) return fehler("Artikel nicht gefunden", 404);
      const delta = parseInt(b.delta, 10) || 0;
      const vorher = a.menge || 0;
      a.menge = Math.max(0, vorher + delta);
      const effektiv = a.menge - vorher;
      if (effektiv < 0) a.entnommen = (a.entnommen || 0) + -effektiv;
      a.geaendert = new Date().toISOString();
      await datenSpeichern(env, d);
      if (effektiv !== 0)
        await protokolliere(env, a.id, ich.benutzername, effektiv, a.menge);
      return antwort(a);
    }

    if (mArtikel && req.method === "DELETE") {
      const d = await datenLaden(env);
      const a = d.artikel.find((x) => x.id === Number(mArtikel[1]));
      if (a) {
        d.artikel = d.artikel.filter((x) => x.id !== a.id);
        a.geloescht = new Date().toISOString();
        a.geloeschtVon = ich.benutzername;
        d.papierkorb.push(a);
        await datenSpeichern(env, d);
      }
      return antwort({ ok: true });
    }

    // ===== PAPIERKORB =====
    if (pfad === "/papierkorb" && req.method === "GET") {
      const d = await datenLaden(env);
      d.papierkorb.sort((a, b) => b.geloescht.localeCompare(a.geloescht));
      return antwort(d.papierkorb);
    }
    const mWieder = pfad.match(/^\/papierkorb\/(\d+)\/wiederherstellen$/);
    if (mWieder && req.method === "POST") {
      const d = await datenLaden(env);
      const i = d.papierkorb.findIndex((x) => x.id === Number(mWieder[1]));
      if (i < 0) return fehler("Nicht im Papierkorb", 404);
      const a = d.papierkorb.splice(i, 1)[0];
      delete a.geloescht; delete a.geloeschtVon;
      a.geaendert = new Date().toISOString();
      d.artikel.push(a);
      await datenSpeichern(env, d);
      return antwort(a);
    }
    const mEndg = pfad.match(/^\/papierkorb\/(\d+)$/);
    if (mEndg && req.method === "DELETE") {
      const d = await datenLaden(env);
      d.papierkorb = d.papierkorb.filter((x) => x.id !== Number(mEndg[1]));
      await env.KELLER.delete("foto:" + mEndg[1]);
      await datenSpeichern(env, d);
      return antwort({ ok: true });
    }

    // ===== PROTOKOLL =====
    const mLog = pfad.match(/^\/log\/(\d+)$/);
    if (mLog && req.method === "GET")
      return antwort(await kvJson(env, "log:" + mLog[1], []));

    // ===== FOTO (Vollbild) =====
    if (mFoto && req.method === "GET") {
      const data = await env.KELLER.get("foto:" + mFoto[1]);
      return data ? antwort({ data }) : fehler("Kein Foto", 404);
    }

    return fehler("Unbekannter Pfad: " + pfad, 404);
  },
};
