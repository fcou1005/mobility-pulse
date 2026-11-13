// @ts-check
// Mobility Pulse — Alarme und Feeds (S5.2, F3): Ereignisse je Gemeinde und Thema aus dem Vergleich mit dem vorigen Lauf, als Atom-Feed
// (feeds/<AGS>.xml alle Themen, feeds/<AGS>-<Thema>.xml je Thema). Themen: Obergrenze überschritten, Quelle aus, Zonen geändert,
// Preise geändert, Flottensprung. Ein Ereignis steht spätestens einen Lauf später im Feed (der Vergleich läuft in jedem Lauf).

export const KINDS = ['cap', 'source', 'zone', 'price', 'fleet'];
export const KIND_DE = { cap: 'Obergrenze', source: 'Quelle aus', zone: 'Zonen geändert', price: 'Preise geändert', fleet: 'Flottensprung' };
export const KEEP_DAYS = 60, MAX_ITEMS = 3000;
const DOWN = new Set(['error', 'gone', 'auth']); // „aus“: nicht erreichbar, verschwunden, Zugang verweigert (veraltet flattert, zählt nicht)
const FLEET_REL = 0.3, FLEET_ABS = 30; // Flottensprung: ±30 % und mindestens 30 Fahrzeuge gegenüber dem vorigen Lauf
const ZONE_REL = 0.05, ZONE_ABS = 5; // Zonen: ±5 % und mindestens 5 Flächen

/** Preise einer Quelle als Kurzform (Entsperren, Minuten- und Kilometerpreis je Tarif), damit nur echte Änderungen zählen */
export function priceSig(/** @type {any[]} */ plans) {
  return (plans || []).map(p => `${p.name || p.id}:${p.unlock ?? ''}:${(p.perMin || []).map((/** @type {any} */ r) => `${r.start}-${r.rate}`).join('/')}:${(p.perKm || []).map((/** @type {any} */ r) => `${r.start}-${r.rate}`).join('/')}`).sort().join('|');
}

/**
 * Zustand eines Laufs für den Vergleich. latest: { sources, groups }; caps: R.capsCheck(...); pricing: pricing.json.
 * @param {{ latest: any, caps?: any[]|null, pricing?: any }} o
 */
export function snapshot({ latest, caps = null, pricing = null }) {
  /** @type {{ caps: Record<string, any>, src: Record<string, any>, zones: Record<string, number>, prices: Record<string, string>, fleet: Record<string, number> }} */
  const s = { caps: {}, src: {}, zones: {}, prices: {}, fleet: {} };
  for (const c of caps || []) for (const x of [c, ...(c.operators || [])]) s.caps[`${c.ags}|${x.op || ''}`] = { status: x.status, total: x.total, limit: x.limit, ort: c.ort };
  for (const r of latest?.sources || []) {
    if (r.candidate || ['duplicate', 'retired'].includes(r.status)) continue;
    s.src[r.id] = { status: r.status, op: r.operator || r.name || r.id, munis: (r.municipalities || []).slice(0, 40) };
    if (Number.isFinite(r.zones?.count)) s.zones[r.id] = r.zones.count;
  }
  for (const p of pricing?.plans || []) if (p.sourceId) s.prices[p.sourceId] = priceSig(p.plans);
  for (const [k, g] of Object.entries(latest?.groups || {})) { const [ags, op] = k.split('|'); const key = `${ags}|${op}`; s.fleet[key] = (s.fleet[key] || 0) + (g.total || 0); }
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
  for (const [id, sig] of Object.entries(cur.prices)) {
    const p = prev.prices[id]; if (p == null || p === sig) continue;
    const r = cur.src[id]; if (!r) continue;
    for (const ags of r.munis) add('price', ags, r.op, `${r.op}: Preise geändert`, `Die Tarife im Feed (system_pricing_plans) haben sich geändert (Quelle ${id}); Einzelheiten unter Auswerten › Leistung › Preise.`, 'info');
  }
  for (const [k, n] of Object.entries(cur.fleet)) {
    const p = prev.fleet[k]; if (p == null) continue;
    const d = n - p; if (Math.abs(d) < FLEET_ABS || Math.abs(d) < FLEET_REL * Math.max(p, 1)) continue;
    const [ags, op] = k.split('|');
    add('fleet', ags, op, `${op}: Flotte ${d > 0 ? 'gewachsen' : 'geschrumpft'} in ${muniName(ags)}`, `${fmt(n)} statt ${fmt(p)} Fahrzeuge im Feed seit dem vorigen Lauf (${d > 0 ? '+' : '−'}${fmt(Math.abs(d))}).`, d < 0 ? 'warn' : 'info');
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
