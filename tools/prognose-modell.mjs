#!/usr/bin/env node
// Mobility Pulse – vortrainiertes Nachfragemodell zum Mitnehmen (ohne Abhängigkeiten, Node ≥ 18).
// Rechnet für die eigene Flotte die erwarteten Fahrtbeginne je Stunde: λ = exp(Niveau + Stunde + Tagtyp + Fahrzeugart + Wetter + Ereignisse)
// je verfügbarem Fahrzeug und Stunde, erwartet = verfügbare Fahrzeuge × λ. Das Modell lernt täglich aus offenen GBFS-Daten in ganz Deutschland
// (forecast/model.json im Datenzweig) – dieses Skript lädt den jeweils neuesten Stand.
//
// Beispiele:
//   node prognose-modell.mjs --art scooter --gemeinde 08111000 --flotte 300                      (morgen, Stuttgart, 300 verfügbare E-Scooter)
//   node prognose-modell.mjs --art bike --gemeinde 05315000 --flotte 800 --tage 7 --wetter      (eine Woche, mit DWD-Vorhersage)
//   node prognose-modell.mjs --art scooter --gemeinde 08416041 --flotte-csv flotte.csv --zaehlung zaehlung.csv > prognose.csv
//   node prognose-modell.mjs --familie car --art car --gemeinde 08111000 --flotte 120
// Hilfe: node prognose-modell.mjs --hilfe
import { readFile } from 'node:fs/promises';

const REPO = 'fcou1005/mobility-pulse', DATA = `https://raw.githubusercontent.com/${REPO}/data/`;
const FAMILY_DIR = { micro: 'forecast/', moped: 'forecast/moped/', car: 'forecast/car/' };
const LANDS = { '01': 'SH', '02': 'HH', '03': 'NI', '04': 'HB', '05': 'NW', '06': 'HE', '07': 'RP', '08': 'BW', '09': 'BY', '10': 'SL', '11': 'BE', '12': 'BB', '13': 'MV', '14': 'SN', '15': 'ST', '16': 'TH' };
const TZ = 'Europe/Berlin', Z80 = 1.2816;
const HELP = `Mobility Pulse – Prognose mit dem vortrainierten Modell

Pflicht:
  --art A            Fahrzeugart: scooter | bike | ebike | cargo (Familie micro), moped (--familie moped), car (--familie car)
  --flotte N         verfügbare Fahrzeuge (konstant)  oder  --flotte-csv DATEI (Spalten stunde;fahrzeuge oder datum;stunde;fahrzeuge)
Wahlweise:
  --gemeinde AGS     amtlicher Gemeindeschlüssel (8 Ziffern, z. B. 08111000 Stuttgart): Stadtzuschlag und Feiertage/Ferien des Landes
  --land XX          Bundesland (BW, BY, …), sonst aus dem Gemeindeschlüssel
  --anbieter NAME    Niveau eines im Modell bekannten Anbieters (z. B. Voi, Bolt, Dott, Lime, nextbike) statt des typischen Niveaus
  --niveau p25|p50|p75  typisches Niveau der Art: zurückhaltend, mittel (Standard), stark
  --zaehlung DATEI   eigene Zählung (datum;stunde;fahrten;fahrzeuge): kalibriert das Niveau auf die eigene Flotte (Gamma-Prior wie im Modell)
  --von JJJJ-MM-TT   erster Tag (Standard: morgen)   --tage N   Anzahl Tage (Standard 1, höchstens 10 mit --wetter)
  --wetter           DWD-Vorhersage über Bright Sky (kostenlos) für --lat/--lon oder den Ort aus --ortlat; ohne: 10 °C trocken
  --lat B --lon L    Koordinate für das Wetter
  --ereignis K=VON/BIS  Ereignis als Kennzeichen, z. B. sport=2026-11-15T14/2026-11-15T19 (Schlüssel siehe Modell ctxKeys); mehrfach möglich
  --familie F        micro (Standard) | moped | car
  --modell DATEI|URL eigenes oder gespeichertes Modell statt des neuesten
  --kalender DATEI|aus  Feiertage/Ferien (Standard: calendar.json aus dem Datenzweig; aus = nur Wochentage)
  --json             Ausgabe als JSON statt CSV
Ausgabe (CSV, Semikolon): datum;stunde;tagtyp;fahrzeuge;erwartet;band80_von;band80_bis;temperatur;niederschlag
Hinweis: Das Band enthält nur das Zählrauschen; die tatsächliche Abweichung je Anbieter und Stunde lag zuletzt bei 15–25 %.
Daten: offene GBFS-Feeds (Lizenzen und Namensnennung: DATA-LICENSE.md im Datenzweig), Wetter DWD. Keine Gewähr.`;

// ---------- Argumente ----------
const args = {}; const multi = { ereignis: [] };
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i]; if (!a.startsWith('--')) continue; const k = a.slice(2), nx = process.argv[i + 1];
  const val = nx != null && !nx.startsWith('--') ? (i++, nx) : true;
  if (k in multi) multi[k].push(val); else args[k] = val;
}
if (args.hilfe || args.help || !args.art || (!args.flotte && !args['flotte-csv'])) { console.log(HELP); process.exit(args.hilfe || args.help ? 0 : 1); }
const fail = (m) => { console.error(`Fehler: ${m}`); process.exit(1); };

// ---------- Laden ----------
const load = async (src, json = true) => {
  if (/^https?:\/\//.test(src)) { const r = await fetch(src, { headers: { 'user-agent': `mobility-pulse-modell (+https://github.com/${REPO})` } }); if (!r.ok) fail(`${src}: HTTP ${r.status}`); return json ? r.json() : r.text(); }
  const t = await readFile(src, 'utf8'); return json ? JSON.parse(t) : t;
};
const family = String(args.familie || (args.art === 'moped' ? 'moped' : args.art === 'car' ? 'car' : 'micro'));
if (!FAMILY_DIR[family]) fail(`unbekannte Familie ${family}`);
const M = await load(args.modell && args.modell !== true ? String(args.modell) : `${DATA}${FAMILY_DIR[family]}model.json`);
if (M?.kind !== 'mobility-pulse/portable-model') fail('keine Modelldatei von Mobility Pulse');
const art = String(args.art), T = M.types[art] || Object.values(M.types).find(x => (x.also || []).includes(art));
if (!T) fail(`Art ${art} nicht im Modell (vorhanden: ${Object.keys(M.types).join(', ')})`);
const ags = args.gemeinde ? String(args.gemeinde) : null, land = args.land ? String(args.land).toUpperCase() : ags ? LANDS[ags.slice(0, 2)] : null;
const cal = args.kalender === 'aus' ? null : await load(args.kalender && args.kalender !== true ? String(args.kalender) : `${DATA}calendar.json`).catch(() => null);

// ---------- Tage, Stunden, Tagtyp ----------
const fmtD = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }), fmtH = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', hour12: false });
const dayOf = (ms) => fmtD.format(new Date(ms)), hourOf = (ms) => +fmtH.format(new Date(ms)) % 24;
const addDays = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86400e3).toISOString().slice(0, 10);
const from = args.von && args.von !== true ? String(args.von) : addDays(dayOf(Date.now()), 1), nDays = Math.max(1, Math.min(31, +args.tage || 1));
const dayType = (d) => { const wd = new Date(`${d}T12:00:00Z`).getUTCDay(), ex = cal?.states?.[land]?.[d] ?? null; if (wd === 0 || ex === 'H') return 'H'; if (wd === 6) return 'S'; return ex === 'F' ? 'F' : 'W'; };
const hours = []; // { t (UTC ms), day, h }
for (let k = 0; k < nDays; k++) { const d = addDays(from, k), t0 = Date.parse(`${d}T00:00:00Z`); for (let t = t0 - 4 * 3600e3; t <= t0 + 28 * 3600e3; t += 3600e3) if (dayOf(t) === d) hours.push({ t, day: d, h: hourOf(t) }); }

// ---------- Flotte ----------
const csvRows = (txt) => txt.split(/\r?\n/).map(l => l.trim()).filter(Boolean).map(l => l.split(/[;,\t]/).map(x => x.trim()));
let fleetOf = () => +args.flotte;
if (args['flotte-csv']) {
  const rows = csvRows(await load(String(args['flotte-csv']), false)).filter(r => r.some(x => /^\d/.test(x))), byDH = new Map(), byH = new Map();
  for (const r of rows) { if (r.length >= 3) byDH.set(`${r[0]}|${+r[1]}`, +r[2]); else byH.set(+r[0], +r[1]); }
  fleetOf = (d, h) => byDH.get(`${d}|${h}`) ?? byH.get(h) ?? (+args.flotte || 0);
}

// ---------- Wetter (Bright Sky, DWD) ----------
const wx = new Map();
if (args.wetter) {
  const lat = +args.lat, lon = +args.lon;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) console.error('Hinweis: --wetter ohne --lat/--lon – rechne ohne Wetter (10 °C, trocken)');
  else {
    const last = addDays(from, nDays + 1), r = await fetch(`https://api.brightsky.dev/weather?lat=${lat}&lon=${lon}&date=${addDays(from, -1)}&last_date=${last}&tz=UTC&units=dwd`).then(x => (x.ok ? x.json() : null)).catch(() => null);
    for (const w of r?.weather || []) wx.set(Date.parse(w.timestamp), { t: w.temperature, p: w.precipitation });
    console.error(`Wetter: ${wx.size} Stunden von Bright Sky (DWD)`);
  }
}
// ---------- Ereignisse ----------
const events = multi.ereignis.map(s => { const [k, span] = String(s).split('='), [a, b] = String(span || '').split('/'); return { k, from: a, to: b || a }; }).filter(e => M.ctxKeys?.[e.k] || M.ctx?.[e.k] != null);
const stamp = (d, h) => `${d}T${String(h).padStart(2, '0')}`;
const ctxSum = (d, h) => events.reduce((s, e) => s + (stamp(d, h) >= e.from.slice(0, 13) && stamp(d, h) <= e.to.slice(0, 13) ? M.ctx?.[e.k] ?? 0 : 0), 0);
if (multi.ereignis.length > events.length) console.error(`Hinweis: ${multi.ereignis.length - events.length} Ereignis(se) ohne gelernte Wirkung im Modell ignoriert (gelernt: ${Object.keys(M.ctx || {}).join(', ') || 'keine'})`);

// ---------- Rate ----------
const wxPart = (w) => (!M.weather || !w || w.t == null || w.p == null ? 0 : M.weather.cold * Math.min(w.t - 10, 0) / 10 + M.weather.warm * Math.max(w.t - 10, 0) / 10 + M.weather.rain * (w.p >= 0.1 ? 1 : 0));
const eta0 = (d, h, t) => M.hour[h] + M.dayType[dayType(d)][h] + T.hour[h] + wxPart(wx.get(t)) + ctxSum(d, h);
// Niveau: Anbieter (gelernt) > typisch (p25/p50/p75) + Stadtzuschlag; danach optional eigene Zählung
const typeKey = Object.entries(M.types).find(([, x]) => x === T)[0], q = ['p25', 'p50', 'p75'].includes(args.niveau) ? args.niveau : 'p50';
const opKey = args.anbieter ? Object.keys(M.operators).find(k => k.toLowerCase() === `${String(args.anbieter)}|${typeKey}`.toLowerCase() || k.toLowerCase() === `${String(args.anbieter)}|${art}`.toLowerCase()) : null;
if (args.anbieter && !opKey) console.error(`Hinweis: Anbieter ${args.anbieter} mit Art ${art} nicht im Modell – typisches Niveau (${q})`);
let level = opKey ? M.operators[opKey] : T.level[q] + (ags ? M.city?.[ags] ?? 0 : 0), levelSrc = opKey ? `Anbieter ${opKey}` : `typisch ${q}${ags && M.city?.[ags] != null ? ` + Stadtzuschlag ${M.city[ags]}` : ''}`;
if (args.zaehlung) {
  const rows = csvRows(await load(String(args.zaehlung), false)).filter(r => r.length >= 4 && /^\d{4}-\d{2}-\d{2}$/.test(r[0]));
  let sy = 0, sm = 0; for (const [d, h, y, v] of rows) { if (!(+v > 0)) continue; sy += +y; sm += +v * Math.exp(M.hour[+h] + M.dayType[dayType(d)][+h] + T.hour[+h]); }
  if (sm > 0) { const a = Math.log((sy + M.alpha * Math.exp(level)) / (sm + M.alpha)); levelSrc += ` → kalibriert mit ${rows.length} gezählten Stunden (${Math.round(sy)} Fahrten): ${level.toFixed(3)} → ${a.toFixed(3)}`; level = a; }
}

// ---------- Ausgabe ----------
const out = hours.map(({ t, day, h }) => { const v = fleetOf(day, h), mu = v * Math.exp(level + eta0(day, h, t)), half = Z80 * Math.sqrt((M.phi || 1) * mu) + 0.5, w = wx.get(t);
  return { datum: day, stunde: h, tagtyp: dayType(day), fahrzeuge: v, erwartet: +mu.toFixed(1), band80_von: +Math.max(0, mu - half).toFixed(1), band80_bis: +(mu + half).toFixed(1), temperatur: w?.t ?? null, niederschlag: w?.p ?? null }; });
const tot = out.reduce((s, r) => s + r.erwartet, 0), pk = out.reduce((b, r) => (r.erwartet > (b?.erwartet ?? -1) ? r : b), null);
console.error(`Modell ${family} vom ${M.trainedAt?.slice(0, 16).replace('T', ' ')} UTC (${M.trainDays} Trainingstage) · Art ${art} · ${ags || 'ohne Gemeinde'}${land ? ` (${land})` : ''} · Niveau: ${levelSrc}`);
console.error(`Summe ${tot.toFixed(0)} Fahrtbeginne in ${out.length} Stunden · Spitze ${pk?.datum} ${String(pk?.stunde).padStart(2, '0')}–${String(((pk?.stunde ?? 0) + 1) % 24).padStart(2, '0')} Uhr mit ${pk?.erwartet}`);
if (args.json) console.log(JSON.stringify({ model: { family, trainedAt: M.trainedAt, trainDays: M.trainDays }, art, gemeinde: ags, land, level, levelSource: levelSrc, total: +tot.toFixed(1), rows: out }, null, 1));
else { const cols = Object.keys(out[0] || { datum: 0 }); console.log(cols.join(';')); for (const r of out) console.log(cols.map(c => (r[c] == null ? '' : String(r[c]).replace('.', ','))).join(';')); }
