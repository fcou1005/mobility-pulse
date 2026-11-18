// @ts-check
// Mobility Pulse — Alarme und Feeds (S5.2, F3): Ereignisse je Gemeinde und Thema aus dem Vergleich mit dem vorigen Lauf, als Atom-Feed
// (feeds/<AGS>.xml alle Themen, feeds/<AGS>-<Thema>.xml je Thema). Themen: Obergrenze überschritten, Quelle aus, Zonen geändert,
// Preise geändert, Flottensprung. Ein Ereignis steht spätestens einen Lauf später im Feed (der Vergleich läuft in jedem Lauf).

export const KINDS = ['cap', 'source', 'zone', 'price', 'fleet', 'oepnv'];
export const KIND_DE = { cap: 'Obergrenze', source: 'Quelle aus', zone: 'Zonen geändert', price: 'Preise geändert', fleet: 'Flottensprung', oepnv: 'ÖPNV gestört', briefing: 'Tagesbriefing' };
/** ÖPNV-Alarm: nur Gemeinden ab so vielen Fahrzeugen und so vielen Halten mit Echtzeit in der Stunde, höchstens einer je Gemeinde in so vielen Stunden.
 * Mit 20 Fahrzeugen und ohne Halte-Grenze kamen am 16.11.2026 in drei Stunden 42 Alarme, 34 davon aus Kleinstädten. */
export const PT_MIN_FLEET = 100, PT_MIN_STOPS = 150, PT_QUIET_H = 6;
/** Schwelle des Alarms, strenger als das Kennzeichen „gestört“ (15 % Ausfall oder 30 % verspätet): im Feierabendverkehr des 16.11.2026 lagen
 * 13 Großstädte in einem Lauf bei 30 bis 44 % verspätet und ohne Ausfälle – Alltag, kein Anlass für eine Meldung. */
export const PT_ALARM = Object.freeze({ skipShare: 0.15, lateShare: 0.5 });
const ptStrong = (/** @type {any} */ c) => !!c && c.n > 0 && (c.skip >= PT_ALARM.skipShare * c.n || c.late >= PT_ALARM.lateShare * c.n);
export const KEEP_DAYS = 60, MAX_ITEMS = 3000;
const DOWN = new Set(['error', 'gone', 'auth']); // „aus“: nicht erreichbar, verschwunden, Zugang verweigert (veraltet flattert, zählt nicht)
const FLEET_REL = 0.3, FLEET_ABS = 30; // Flottensprung: ±30 % und mindestens 30 Fahrzeuge gegenüber dem vorigen Lauf
const ZONE_REL = 0.05, ZONE_ABS = 5; // Zonen: ±5 % und mindestens 5 Flächen

/** Preise einer Quelle als Kurzform (Entsperren, Minuten- und Kilometerpreis je Tarif), damit nur echte Änderungen zählen */
export function priceSig(/** @type {any[]} */ plans) {
  return planSigs(plans).sort().join('|');
}
/** Kurzform je Tarif (Bestandteile von priceSig) */
const planSigs = (/** @type {any[]} */ plans) => (plans || []).map(p => `${p.name || p.id}:${p.unlock ?? ''}:${(p.perMin || []).map((/** @type {any} */ r) => `${r.start}-${r.rate}`).join('/')}:${(p.perKm || []).map((/** @type {any} */ r) => `${r.start}-${r.rate}`).join('/')}`);
/** 32-Bit-Kennung (FNV-1a, hex) einer Tarif-Kurzform, damit der Zustand klein bleibt */
export const sigHash = (/** @type {string} */ x) => { let h = 0x811c9dc5; for (let i = 0; i < x.length; i++) { h ^= x.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h.toString(16).padStart(8, '0'); };
/**
 * Bekannte Tarife je Quelle mit letztem Auftreten (ms); Tarife, die länger als keepDays fehlen, fallen heraus. Wochenend- und Aktionstarife
 * kehren wieder (Lime 7./9. und 14./16.11.2026, Aktionstarif fast täglich): sie lösen keinen Alarm mehr aus, nur ein nie gesehener Tarif.
 * @param {any} prev @param {any} cur @param {number} now
 */
export function carryPriceSeen(prev, cur, now, keepDays = PRICE_KEEP_DAYS) {
  /** @type {Record<string, Record<string, number>>} */ const out = {};
  const seen = seenOf(prev);
  for (const [id, m] of Object.entries(seen)) for (const [h, at] of Object.entries(m)) if (now - at <= keepDays * 86400e3) (out[id] ||= {})[h] = at;
  for (const [id, hs] of Object.entries(cur?.plans || {})) for (const h of /** @type {string[]} */ (hs)) (out[id] ||= {})[h] = now;
  cur.priceSeen = out; return out;
}
export const PRICE_KEEP_DAYS = 35;
/** Bekannte Tarife aus dem vorigen Zustand; ältere Zustände ohne priceSeen: Tarife aus prices (Kurzform je Quelle) */
const seenOf = (/** @type {any} */ prev) => {
  if (prev?.priceSeen) return prev.priceSeen;
  /** @type {Record<string, Record<string, number>>} */ const o = {};
  for (const [id, sig] of Object.entries(prev?.prices || {})) for (const part of String(sig).split('|').filter(Boolean)) (o[id] ||= {})[sigHash(part)] = Date.now();
  return o;
};

/**
 * Zustand eines Laufs für den Vergleich. latest: { sources, groups }; caps: R.capsCheck(...); pricing: pricing.json.
 * @param {{ latest: any, caps?: any[]|null, pricing?: any, pt?: Record<string, any>|null }} o
 */
export function snapshot({ latest, caps = null, pricing = null, pt = null }) {
  /** @type {{ caps: Record<string, any>, src: Record<string, any>, zones: Record<string, number>, prices: Record<string, string>, fleet: Record<string, number>, pt?: Record<string, any>, plans?: Record<string, string[]>, priceSeen?: Record<string, Record<string, number>> }} */
  const s = { caps: {}, src: {}, zones: {}, prices: {}, fleet: {} };
  for (const c of caps || []) for (const x of [c, ...(c.operators || [])]) s.caps[`${c.ags}|${x.op || ''}`] = { status: x.status, total: x.total, limit: x.limit, ort: c.ort };
  for (const r of latest?.sources || []) {
    if (r.candidate || ['duplicate', 'retired'].includes(r.status)) continue;
    s.src[r.id] = { status: r.status, op: r.operator || r.name || r.id, munis: (r.municipalities || []).slice(0, 40) };
    if (Number.isFinite(r.zones?.count)) s.zones[r.id] = r.zones.count;
  }
  for (const p of pricing?.plans || []) if (p.sourceId) { s.prices[p.sourceId] = priceSig(p.plans); (s.plans ||= {})[p.sourceId] = [...new Set(planSigs(p.plans).map(sigHash))]; }
  for (const [k, g] of Object.entries(latest?.groups || {})) { const [ags, op] = k.split('|'); const key = `${ags}|${op}`; s.fleet[key] = (s.fleet[key] || 0) + (g.total || 0); }
  // ÖPNV (Phase oepnv, ctx.ptNow): letzte volle Ortsstunde je Gemeinde mit Flotte, dazu die verfügbaren Sharing-Fahrzeuge
  if (pt) { const tot = {}, av = {}; for (const [k, g] of Object.entries(latest?.groups || {})) { const a = k.split('|')[0]; tot[a] = (tot[a] || 0) + (g.total || 0); av[a] = (av[a] || 0) + (g.available ?? g.total ?? 0); }
    /** @type {any} */ (s).pt = {}; for (const [a, x] of Object.entries(pt)) if ((tot[a] || 0) >= PT_MIN_FLEET && x.n >= PT_MIN_STOPS) /** @type {any} */ (s).pt[a] = { ...x, veh: av[a] || 0 }; }
  return s;
}

/**
 * Neue Ereignisse aus dem Vergleich zweier Zustände (ohne vorigen Zustand: keine – der erste Lauf meldet nichts nach).
 * @param {ReturnType<typeof snapshot>|null} prev @param {ReturnType<typeof snapshot>} cur @param {{ now: number, fmt?: (n: number) => string, muniName?: (ags: string) => string }} o
 */
export function detect(prev, cur, { now, fmt = (n) => new Intl.NumberFormat('de-DE').format(n), muniName = (a) => a }) {
  if (!prev) return [];
  /** @type {Array<{ id: string, at: number, ags: string, kind: string, op: string|null, title: string, text: string, level: string }>} */
  const out = [];
  const add = (kind, ags, op, title, text, level) => out.push({ id: `${kind}:${ags}:${encodeURIComponent(op || '-')}:${now}`, at: now, ags, kind, op: op || null, title, text, level });
  for (const [k, c] of Object.entries(cur.caps)) {
    const p = prev.caps[k]; if (c.status !== 'over' || p?.status === 'over') continue;
    const [ags, op] = k.split('|');
    add('cap', ags, op || null, `${op ? `${op}: ` : ''}Obergrenze in ${c.ort || muniName(ags)} überschritten`, `${fmt(c.total)} E-Scooter bei erlaubten ${fmt(c.limit)} (amtliche Grenze, data/reference.json).`, 'bad');
  }
  for (const [id, r] of Object.entries(cur.src)) {
    const p = prev.src[id]; if (!p || !DOWN.has(r.status) || DOWN.has(p.status)) continue;
    for (const ags of r.munis) add('source', ags, r.op, `${r.op}: offener Feed nicht erreichbar`, `Quelle ${id} meldet „${r.status}“ (vorher „${p.status}“). Bis sie wieder läuft, fehlen die Fahrzeuge dieses Feeds in allen Zahlen.`, 'warn');
  }
  for (const [id, n] of Object.entries(cur.zones)) {
    const p = prev.zones[id]; if (p == null || Math.abs(n - p) < ZONE_ABS || Math.abs(n - p) < ZONE_REL * Math.max(p, 1)) continue;
    const r = cur.src[id]; if (!r) continue;
    for (const ags of r.munis) add('zone', ags, r.op, `${r.op}: Zonen geändert`, `Der Feed meldet ${fmt(n)} statt ${fmt(p)} Zonenflächen (Quelle ${id}).`, 'info');
  }
  const seen = seenOf(prev);
  for (const [id, sig] of Object.entries(cur.prices)) {
    const p = prev.prices[id]; if (p == null || p === sig) continue;
    if (seen[id] && (cur.plans?.[id] || []).every((/** @type {string} */ h) => seen[id][h] != null)) continue; // nur bekannte Tarife (wiederkehrend)
    const r = cur.src[id]; if (!r) continue;
    for (const ags of r.munis) add('price', ags, r.op, `${r.op}: Preise geändert`, `Die Tarife im Feed (system_pricing_plans) haben sich geändert (Quelle ${id}); Einzelheiten unter Auswerten › Leistung › Preise.`, 'info');
  }
  for (const [k, n] of Object.entries(cur.fleet)) {
    const p = prev.fleet[k]; if (p == null) continue;
    const d = n - p; if (Math.abs(d) < FLEET_ABS || Math.abs(d) < FLEET_REL * Math.max(p, 1)) continue;
    const [ags, op] = k.split('|');
    add('fleet', ags, op, `${op}: Flotte ${d > 0 ? 'gewachsen' : 'geschrumpft'} in ${muniName(ags)}`, `${fmt(n)} statt ${fmt(p)} Fahrzeuge im Feed seit dem vorigen Lauf (${d > 0 ? '+' : '−'}${fmt(Math.abs(d))}).`, d < 0 ? 'warn' : 'info');
  }
  // ÖPNV gestört: Wechsel auf stark gestört (PT_ALARM) in der letzten vollen Stunde; der erste Lauf mit ÖPNV-Zahlen meldet nichts
  const cp = /** @type {any} */ (cur).pt, pp = /** @type {any} */ (prev).pt;
  if (cp) for (const [ags, c] of Object.entries(/** @type {Record<string, any>} */ (cp))) {
    const p = pp?.[ags]; c.alarmAt = p?.alarmAt || 0;
    if (!pp || !ptStrong(c) || ptStrong(p) || now - c.alarmAt < PT_QUIET_H * 3600e3) continue;
    const pc = (/** @type {number} */ x) => fmt(Math.round(x / c.n * 100));
    add('oepnv', ags, null, `ÖPNV in ${muniName(ags)} gestört`, `Zwischen ${c.hour} und ${c.hour + 1} Uhr fielen ${pc(c.skip)} % der ${fmt(c.n)} Halte mit Echtzeit aus, ${pc(c.late)} % waren mindestens 5 Minuten verspätet (gtfs.de). Im Stadtgebiet stehen ${fmt(c.veh)} Sharing-Fahrzeuge bereit.`, 'warn'); c.alarmAt = now;
  }
  return out;
}

/** Protokoll fortschreiben: neue zuerst, 60 Tage, höchstens 3000 Einträge */
export function updateLog(/** @type {any} */ prev, /** @type {any[]} */ fresh, /** @type {{ now: number, state: any }} */ { now, state }) {
  const seen = new Set(fresh.map(x => x.id));
  const items = [...fresh, ...((prev?.items || []).filter((/** @type {any} */ x) => !seen.has(x.id) && now - x.at <= KEEP_DAYS * 864e5))].slice(0, MAX_ITEMS);
  return { at: now, items, state };
}

const xml = (s) => String(s ?? '').replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c] || c));
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
/**
 * Atom-Feed (RFC 4287) für eine Gemeinde, optional ein Thema. base: öffentliche Adresse der Seite (…/mobility-pulse/),
 * dataBase: Adresse des Datenzweigs (für rel="self"). Ohne Einträge gilt als updated der Stand der Feed-Liste (fester Wert, keine Unruhe im Zweig).
 * @param {{ ags: string, name: string, kind?: string|null, items: any[], base: string, dataBase: string, since: number }} o
 */
export function atomFeed({ ags, name, kind = null, items, base, dataBase, since }) {
  const list = items.filter(x => x.ags === ags && (!kind || x.kind === kind)).slice(0, 100);
  const file = `feeds/${ags}${kind ? `-${kind}` : ''}.xml`;
  const updated = list.length ? list[0].at : since;
  const title = `Mobility Pulse – ${name}${kind ? `: ${KIND_DE[kind]}` : ''}`;
  const page = `${base}?scope=${ags}#stadt`;
  const entries = list.map(x => `  <entry>
    <id>tag:fcou1005.github.io,2026:${xml(x.id)}</id>
    <title>${xml(x.title)}</title>
    <updated>${iso(x.at)}</updated>
    <link rel="alternate" type="text/html" href="${xml(page)}"/>
    <category term="${xml(x.kind)}" label="${xml(KIND_DE[x.kind] || x.kind)}"/>
    <summary type="text">${xml(x.text)}</summary>
  </entry>`).join('\n');
  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="de">
  <id>tag:fcou1005.github.io,2026:${xml(file)}</id>
  <title>${xml(title)}</title>
  <subtitle>${xml(kind ? `Alarme zum Thema ${KIND_DE[kind]} aus offenen Sharing-Daten` : 'Alarme aus offenen Sharing-Daten: Obergrenze, Quelle aus, Zonen, Preise, Flottensprung')}</subtitle>
  <updated>${iso(updated)}</updated>
  <author><name>Mobility Pulse</name><uri>${xml(base)}</uri></author>
  <link rel="self" type="application/atom+xml" href="${xml(`${dataBase}${file}`)}"/>
  <link rel="alternate" type="text/html" href="${xml(page)}"/>
  <generator uri="https://github.com/fcou1005/mobility-pulse">Mobility Pulse</generator>
${entries}
</feed>
`;
}
