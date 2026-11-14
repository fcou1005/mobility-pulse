// Mobility Pulse – Sprint 7 (Markt): Deutschland-Index (S7.1), offene Daten-Pakete und Grafik der Woche (S7.5).
// Grundlage ist das Monatsarchiv archive/<JJJJ-MM>.json (je Tag und Gruppe AGS|Anbieter|Art: Flotte, Fahrten, … , stunden_voll).
// Öffentlich nur je Gemeinde und Fahrzeugart (über alle Anbieter summiert); die Anbieter-Ebene erscheint erst nach Lizenzprüfung je Quelle.
// SVG ohne Abhängigkeiten (Sammler); Farben fest (eigenständige Datei, hell), gleich den Druckfarben in web/tokens.js (PRINT, NEUTRAL).
export const IDX = Object.freeze({ version: 1, minFleet: 10, fullHours: 20, top: 15 });
export const TYPE_DE = Object.freeze({ scooter: 'E-Scooter', bike: 'Fahrräder', ebike: 'E-Bikes', cargo: 'Lastenräder', moped: 'E-Roller', car: 'Carsharing', other: 'Sonstige' });
const SVGC = { ink: '#1f2933', muted: '#5b6573', line: '#d5dbe1', bar: '#0f766e', bar2: '#a7b0b9', bg: '#ffffff', up: '#2fa36b', down: '#c2410c' };
const MON_DE = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
export const monthText = (m) => `${MON_DE[+m.slice(5, 7) - 1]} ${m.slice(0, 4)}`;
export const prevMonth = (m) => { const [y, mo] = m.split('-').map(Number); return mo === 1 ? `${y - 1}-12` : `${y}-${String(mo - 1).padStart(2, '0')}`; };
const r1 = (x) => Math.round(x * 10) / 10, r3 = (x) => Math.round(x * 1000) / 1000;
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const fmtDe = (x, d = 0) => (x == null || !Number.isFinite(x) ? '–' : x.toLocaleString('de-DE', { minimumFractionDigits: d, maximumFractionDigits: d }));

// voller Messtag: stunden_voll ≥ fullHours; ältere Zeilen (vor 11.11.2026) ohne stunden_voll: beobachtet_min ≥ fullHours × 60
export const fullDay = (r, F, fullHours = IDX.fullHours) => (r[F.stunden_voll] != null ? r[F.stunden_voll] >= fullHours : (r[F.beobachtet_min] ?? 0) >= fullHours * 60);
/** Tage eines Monats aus dem Archiv, je Gemeinde und Art über die Anbieter summiert; ein Gruppen-Tag zählt nur mit stunden_voll ≥ fullHours */
/** @param {any} archive @param {any} month @param {any} [opts] @returns {any} */
export function cityDays(archive, month, { fullHours = IDX.fullHours } = {}) {
  const F = Object.fromEntries((archive?.fields || []).map((f, i) => [f, i])), days = Object.keys(archive?.days || {}).filter(d => d.startsWith(month)).sort();
  const out = new Map();
  days.forEach((d, di) => {
    for (const [k, r] of Object.entries(archive.days[d] || {})) {
      if (!Array.isArray(r) || !fullDay(r, F, fullHours)) continue;
      const [ags, op, type] = k.split('|'); if (!/^\d{8}$/.test(ags)) continue;
      const key = `${ags}|${type}`; let e = out.get(key);
      if (!e) out.set(key, e = { ags, type, ops: new Set(), trips: new Array(days.length).fill(null), fleet: new Array(days.length).fill(null), reloc: new Array(days.length).fill(null), swap: new Array(days.length).fill(null) });
      e.ops.add(op); e.trips[di] = (e.trips[di] || 0) + (r[F.fahrten] || 0); e.fleet[di] = (e.fleet[di] || 0) + (r[F.flotte_avg] || 0); // Fahrzeuge im Feed (Tagesmittel), seit Beginn in jeder Zeile
      e.reloc[di] = (e.reloc[di] || 0) + (r[F.umsetzungen] || 0); e.swap[di] = (e.swap[di] || 0) + (r[F.akkutausch] || 0);
    }
  });
  return { days, cities: out };
}
const mean = (a) => { const v = a.filter(x => x != null && Number.isFinite(x)); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null; };

/**
 * Index eines Monats. names: { ags: name }; prev: Index des Vormonats (Veränderung); complete: Monat vorbei (sonst vorläufig).
 * Rückgabe { version, month, complete, days, firstDay, lastDay, rows: [{ ags, name, type, days, tripsDay, fleet, tvd, operators, series, change }],
 *   de: { type: { tripsDay, fleet, tvd, cities } }, operatorLevel: false }
 */
/** @param {any} archive @param {any} [opts] @returns {any} */
export function monthIndex(archive, { month, names = {}, prev = null, complete = true, minFleet = IDX.minFleet } = {}) {
  const { days, cities } = cityDays(archive, month), prevRow = new Map((prev?.rows || []).map(r => [`${r.ags}|${r.type}`, r]));
  const rows = [];
  for (const e of cities.values()) {
    const tripsDay = mean(e.trips), fleet = mean(e.fleet); if (tripsDay == null || fleet == null || fleet < minFleet) continue;
    const p = prevRow.get(`${e.ags}|${e.type}`);
    rows.push({ ags: e.ags, name: names[e.ags] || e.ags, type: e.type, days: e.trips.filter(x => x != null).length, tripsDay: r1(tripsDay), fleet: r1(fleet), tvd: fleet > 0 ? r3(tripsDay / fleet) : null,
      operators: e.ops.size, relocDay: r1(mean(e.reloc) || 0), swapDay: r1(mean(e.swap) || 0), series: e.trips.map(x => (x == null ? null : Math.round(x))),
      change: p ? { trips: p.tripsDay > 0 ? r3(tripsDay / p.tripsDay - 1) : null, fleet: p.fleet > 0 ? r3(fleet / p.fleet - 1) : null } : null });
  }
  rows.sort((a, b) => b.tripsDay - a.tripsDay || (a.ags < b.ags ? -1 : 1));
  const de = {};
  for (const r of rows) { const d = (de[r.type] ||= { tripsDay: 0, fleet: 0, cities: 0 }); d.tripsDay += r.tripsDay; d.fleet += r.fleet; d.cities++; }
  for (const d of Object.values(de)) { d.tripsDay = r1(d.tripsDay); d.fleet = r1(d.fleet); d.tvd = d.fleet > 0 ? r3(d.tripsDay / d.fleet) : null; }
  return { version: IDX.version, month, complete, days, firstDay: days[0] || null, lastDay: days.at(-1) || null, rows, de, operatorLevel: false };
}

// ---------- SVG ----------
const svgHead = (w, h, title) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="${esc(title)}" font-family="IBM Plex Sans, system-ui, sans-serif"><rect width="${w}" height="${h}" fill="${SVGC.bg}"/>`;
const svgFoot = (w, h, note) => `<text x="16" y="${h - 12}" font-size="11" fill="${SVGC.muted}">${esc(note)}</text></svg>`;
/** Balken: rows [{ label, value, sub? }] waagerecht, beschriftet */
/** @param {any} rows @param {any} [opts] @returns {any} */
export function barsSvg(rows, { title, subtitle = '', note = 'Mobility Pulse · offene GBFS-Feeds der Anbieter · fcou1005.github.io/mobility-pulse', unit = '', w = 720, digits = 0 } = {}) {
  const top = 64, rowH = 24, h = top + rows.length * rowH + 40, lw = 170, max = Math.max(1, ...rows.map(r => r.value || 0)), bw = w - lw - 110;
  let s = svgHead(w, h, title) + `<text x="16" y="28" font-size="18" font-weight="600" fill="${SVGC.ink}">${esc(title)}</text><text x="16" y="48" font-size="12" fill="${SVGC.muted}">${esc(subtitle)}</text>`;
  rows.forEach((r, i) => { const y = top + i * rowH, bl = Math.max(1, (r.value || 0) / max * bw);
    s += `<text x="${lw - 8}" y="${y + 16}" font-size="12" text-anchor="end" fill="${SVGC.ink}">${esc(r.label)}</text><rect x="${lw}" y="${y + 4}" width="${bl.toFixed(1)}" height="${rowH - 8}" rx="3" fill="${SVGC.bar}"/>`
      + `<text x="${(lw + bl + 6).toFixed(1)}" y="${y + 16}" font-size="12" fill="${SVGC.ink}">${esc(`${fmtDe(r.value, digits)}${unit}`)}${r.sub ? `<tspan fill="${r.sub.startsWith('−') ? SVGC.down : SVGC.up}"> ${esc(r.sub)}</tspan>` : ''}</text>`; });
  return s + svgFoot(w, h, note);
}
/** Säulen je Tag (Tagesreihe), Lücken ohne Messung leer */
/** @param {any} values @param {any} labels @param {any} [opts] @returns {any} */
export function seriesSvg(values, labels, { title, subtitle = '', note = 'Mobility Pulse · offene GBFS-Feeds der Anbieter', w = 720, h = 300 } = {}) {
  const top = 64, bottom = h - 48, left = 56, right = w - 16, n = Math.max(1, values.length), max = Math.max(1, ...values.filter(Number.isFinite)), bw = (right - left) / n;
  let s = svgHead(w, h, title) + `<text x="16" y="28" font-size="18" font-weight="600" fill="${SVGC.ink}">${esc(title)}</text><text x="16" y="48" font-size="12" fill="${SVGC.muted}">${esc(subtitle)}</text>`;
  for (const f of [0, 0.5, 1]) { const y = bottom - f * (bottom - top); s += `<line x1="${left}" x2="${right}" y1="${y}" y2="${y}" stroke="${SVGC.line}"/><text x="${left - 6}" y="${y + 4}" font-size="11" text-anchor="end" fill="${SVGC.muted}">${fmtDe(max * f)}</text>`; }
  values.forEach((v, i) => { if (!Number.isFinite(v)) return; const bh = v / max * (bottom - top); s += `<rect x="${(left + i * bw + 1).toFixed(1)}" y="${(bottom - bh).toFixed(1)}" width="${Math.max(1, bw - 2).toFixed(1)}" height="${bh.toFixed(1)}" rx="2" fill="${SVGC.bar}"><title>${esc(`${labels[i]}: ${fmtDe(v)}`)}</title></rect>`; });
  const step = Math.ceil(n / 8); labels.forEach((l, i) => { if (i % step) return; s += `<text x="${(left + (i + 0.5) * bw).toFixed(1)}" y="${bottom + 16}" font-size="11" text-anchor="middle" fill="${SVGC.muted}">${esc(l)}</text>`; });
  return s + svgFoot(w, h, note);
}
/** Grafik des Monats: Fahrten je Tag der größten Städte einer Art, mit Veränderung zum Vormonat */
/** @param {any} index @param {any} [opts] @returns {any} */
export function indexSvg(index, { type = 'scooter', top = IDX.top } = {}) {
  const rows = index.rows.filter(r => r.type === type).slice(0, top).map(r => ({ label: r.name, value: r.tripsDay, sub: r.change?.trips != null ? `${r.change.trips >= 0 ? '+' : '−'}${fmtDe(Math.abs(r.change.trips) * 100)} %` : '' }));
  return barsSvg(rows, { title: `Fahrten je Tag – ${TYPE_DE[type] || type}, ${monthText(index.month)}${index.complete ? '' : ' (vorläufig)'}`, subtitle: `Mittel über volle Messtage, alle Anbieter je Stadt; dahinter die Veränderung zum Vormonat. ${index.days.length} Tage.` });
}
/** Grafik einer Stadt und Art: Fahrten je Tag im Monat */
/** @param {any} index @param {any} row @returns {any} */
export function citySvg(index, row) {
  return seriesSvg(row.series, index.days.map(d => `${+d.slice(8)}.`), { title: `${row.name}: Fahrten je Tag – ${TYPE_DE[row.type] || row.type}`, subtitle: `${monthText(index.month)}${index.complete ? '' : ' (vorläufig)'} · Mittel ${fmtDe(row.tripsDay)} Fahrten je Tag, ${fmtDe(row.fleet)} Fahrzeuge im Feed, ${fmtDe(row.tvd, 2)} Fahrten je Fahrzeug und Tag` });
}

// ---------- Grafik der Woche (S7.5) ----------
/** ISO-Kalenderwoche eines Tags (JJJJ-MM-TT) als JJJJ-Www */
export function isoWeek(day) { const d = new Date(`${day}T12:00:00Z`), wd = (d.getUTCDay() + 6) % 7; d.setUTCDate(d.getUTCDate() - wd + 3); const y = d.getUTCFullYear(), w1 = new Date(Date.UTC(y, 0, 4)); return `${y}-W${String(1 + Math.round(((d.getTime() - w1.getTime()) / 864e5 - 3 + ((w1.getUTCDay() + 6) % 7)) / 7)).padStart(2, '0')}`; }
export const weekDays = (week) => { const [y, w] = week.split('-W').map(Number), j4 = new Date(Date.UTC(y, 0, 4)), mon = new Date(j4.getTime() - ((j4.getUTCDay() + 6) % 7) * 864e5 + (w - 1) * 7 * 864e5); return [...Array(7)].map((_, i) => new Date(mon.getTime() + i * 864e5).toISOString().slice(0, 10)); };
/**
 * Grafik der Woche aus dem Archiv (alle Monate zusammengeführt: { fields, days }). Thema wechselt mit der Woche: gerade Wochen die zehn Städte
 * mit den meisten Fahrten je Tag (Veränderung zur Vorwoche), ungerade Fahrten je Tag in Deutschland je Fahrzeugart. Rückgabe { week, theme, title, svg }
 */
/** @param {any} archive @param {any} week @param {any} [opts] @returns {any} */
export function weekGraphic(archive, week, { names = {} } = {}) {
  const days = weekDays(week), prevDays = weekDays(isoWeek(new Date(Date.parse(`${days[0]}T12:00:00Z`) - 7 * 864e5).toISOString().slice(0, 10)));
  const F = Object.fromEntries((archive?.fields || []).map((f, i) => [f, i])), sumBy = (ds, keyOf) => { const m = new Map(); for (const d of ds) for (const [k, r] of Object.entries(archive.days?.[d] || {})) { if (!fullDay(r, F)) continue; const key = keyOf(k); if (key == null) continue; const e = m.get(key) || { trips: 0, days: new Set() }; e.trips += r[F.fahrten] || 0; e.days.add(d); m.set(key, e); } return m; };
  const nr = +week.slice(-2);
  if (nr % 2 === 0) {
    const cur = sumBy(days, k => k.split('|')[0]), prv = sumBy(prevDays, k => k.split('|')[0]);
    const rows = [...cur].map(([ags, e]) => ({ ags, v: e.trips / e.days.size, p: prv.get(ags) ? prv.get(ags).trips / prv.get(ags).days.size : null })).sort((a, b) => b.v - a.v).slice(0, 10)
      .map(r => ({ label: names[r.ags] || r.ags, value: r.v, sub: r.p ? `${r.v >= r.p ? '+' : '−'}${fmtDe(Math.abs(r.v / r.p - 1) * 100)} %` : '' }));
    const title = `Die zehn Städte mit den meisten Fahrten, KW ${nr}`;
    return { week, theme: 'staedte', title, days, svg: barsSvg(rows, { title, subtitle: `Fahrten je Tag (alle Anbieter und Fahrzeugarten), ${days[0]} bis ${days[6]}; Veränderung zur Vorwoche` }) };
  }
  const by = sumBy(days, k => k.split('|')[2]);
  const rows = [...by].map(([type, e]) => ({ label: TYPE_DE[type] || type, value: e.trips / e.days.size })).sort((a, b) => b.value - a.value);
  const title = `Fahrten je Tag in Deutschland nach Fahrzeugart, KW ${nr}`;
  return { week, theme: 'arten', title, days, svg: barsSvg(rows, { title, subtitle: `Mittel über volle Messtage, ${days[0]} bis ${days[6]}; erfasst sind Anbieter mit offenem GBFS-Feed` }) };
}

// ---------- Offene Daten-Pakete (S7.5) ----------
const csvEsc = (v) => { const x = v == null ? '' : String(v); return /[;"\n]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x; };
const csv = (rows) => rows.map(r => r.map(csvEsc).join(';')).join('\n') + '\n';
export const PACKAGE_FIELDS = Object.freeze({
  tage: [['tag', 'date', 'Ortstag (Europe/Berlin)'], ['ags', 'string', 'Amtlicher Gemeindeschlüssel'], ['gemeinde', 'string', 'Name der Gemeinde'], ['art', 'string', 'Fahrzeugart (scooter, bike, ebike, cargo, moped, car, other)'],
    ['fahrten', 'integer', 'Fahrtbeginne am Tag, alle Anbieter'], ['fahrzeuge', 'number', 'Fahrzeuge im Feed im Tagesmittel (verfügbar und gesperrt), alle Anbieter'], ['umsetzungen', 'integer', 'Umsetzungen durch den Betrieb'], ['akkutausch', 'integer', 'erkannte Akkutausche'], ['anbieter', 'integer', 'Zahl der Anbieter mit vollem Messtag']],
  monat: [['monat', 'string', 'Monat (JJJJ-MM)'], ['ags', 'string', 'Amtlicher Gemeindeschlüssel'], ['gemeinde', 'string', 'Name der Gemeinde'], ['art', 'string', 'Fahrzeugart'], ['tage', 'integer', 'volle Messtage'], ['fahrten_je_tag', 'number', 'Mittel der Fahrtbeginne je vollem Messtag'],
    ['fahrzeuge', 'number', 'Mittel der Fahrzeuge im Feed'], ['fahrten_je_fahrzeug_tag', 'number', 'Fahrten je Fahrzeug und Tag'], ['anbieter', 'integer', 'Zahl der Anbieter'], ['veraenderung_fahrten', 'number', 'Veränderung der Fahrten je Tag zum Vormonat (Anteil)']],
});
/** Monatspaket: { files: { 'tage.csv', 'monat.csv', 'datapackage.json', 'README.md' } } – je Gemeinde und Art, ohne Anbieter-Ebene */
/** @param {any} archive @param {any} index @param {any} [opts] @returns {any} */
export function openPackage(archive, index, { names = {}, at = Date.now() } = {}) {
  const { days, cities } = cityDays(archive, index.month), tage = [PACKAGE_FIELDS.tage.map(f => f[0])];
  for (const e of [...cities.values()].sort((a, b) => (a.ags < b.ags ? -1 : a.ags > b.ags ? 1 : a.type < b.type ? -1 : 1))) days.forEach((d, i) => { if (e.trips[i] == null) return; tage.push([d, e.ags, names[e.ags] || '', e.type, Math.round(e.trips[i]), r1(e.fleet[i]), Math.round(e.reloc[i] || 0), Math.round(e.swap[i] || 0), e.ops.size]); });
  const monat = [PACKAGE_FIELDS.monat.map(f => f[0]), ...index.rows.map(r => [index.month, r.ags, r.name, r.type, r.days, r.tripsDay, r.fleet, r.tvd, r.operators, r.change?.trips ?? ''])];
  const res = (name, f, desc) => ({ name, path: `${name}.csv`, format: 'csv', mediatype: 'text/csv', encoding: 'utf-8', dialect: { delimiter: ';' }, description: desc, schema: { fields: f.map(([n, ty, d]) => ({ name: n, type: ty, description: d })) } });
  const dp = { name: `mobility-pulse-${index.month}`, title: `Mobility Pulse – Sharing in Deutschland, ${monthText(index.month)}`, version: '1.0', created: new Date(at).toISOString(),
    description: 'Fahrten und Bestand der Sharing-Anbieter mit offenem GBFS-Feed, je Gemeinde und Fahrzeugart über alle Anbieter summiert; nur volle Messtage (mindestens 20 Stunden gemessen).',
    licenses: [{ name: 'ODbL-1.0 / Bedingungen der Quellen', path: 'https://github.com/fcou1005/mobility-pulse/blob/data/DATA-LICENSE.md', title: 'Abgeleitet aus offenen Feeds; maßgeblich sind die Lizenzen der Quellen (DATA-LICENSE.md)' }],
    sources: [{ title: 'GBFS-Feeds der Anbieter über MobiData BW, MOBIDROM NRW, CityBikes und Direktfeeds', path: 'https://fcou1005.github.io/mobility-pulse/' }, { title: 'Gemeindegrenzen © GeoBasis-DE / BKG, VG250, dl-de/by-2-0' }],
    resources: [res('tage', PACKAGE_FIELDS.tage, 'Tageswerte je Gemeinde und Fahrzeugart'), res('monat', PACKAGE_FIELDS.monat, 'Monatswerte (Deutschland-Index) je Gemeinde und Fahrzeugart')] };
  const readme = [`# ${dp.title}`, '', dp.description, '', `Zeitraum: ${days[0] || '–'} bis ${days.at(-1) || '–'} (${days.length} Tage)${index.complete ? '' : ', Monat noch nicht abgeschlossen'}. Erstellt: ${dp.created}.`, '',
    '## Dateien', '', ...dp.resources.flatMap(r => [`### ${r.path}`, '', r.description, '', '| Spalte | Typ | Bedeutung |', '|---|---|---|', ...r.schema.fields.map(f => `| ${f.name} | ${f.type} | ${f.description} |`), '']),
    '## Methode', '', 'Fahrten sind gezählte Fahrtbeginne aus aufeinanderfolgenden Abrufen der Feeds (etwa alle 18 Minuten); bei Anbietern mit wechselnden Kennungen sind sie geschätzt. Ein Tag zählt je Anbieter nur mit mindestens 20 gemessenen Stunden (ältere Tage: 1.200 beobachtete Minuten). Methodik: https://github.com/fcou1005/mobility-pulse/blob/main/handbuch/kennzahlen.md', '',
    '## Lizenz', '', 'Abgeleitet aus den offenen Feeds der Anbieter und Verzeichnisse; maßgeblich sind die Bedingungen der jeweiligen Quelle (siehe DATA-LICENSE.md im Datenzweig). Gemeindenamen: © GeoBasis-DE / BKG, dl-de/by-2-0.', ''].join('\n');
  return { files: { 'tage.csv': csv(tage), 'monat.csv': csv(monat), 'datapackage.json': `${JSON.stringify(dp, null, 1)}\n`, 'README.md': readme }, rows: { tage: tage.length - 1, monat: monat.length - 1 } };
}
