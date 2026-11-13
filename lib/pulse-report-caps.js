// @ts-check
// Mobility Pulse — Bericht – Obergrenzen und Protokoll, CSV, Zeiträume, Preis-Log, Feed-Prüfung, Verfügbarkeit (aus pulse-report.js geschnitten; pulse-report.js bleibt die Fassade für alle Importe).
import { GAP_MS } from './pulse-track.js';
import { DEFAULTS } from './pulse-econ.js';
import { AMPEL_RED, FULL_DAY_HOURS, FULL_HOUR_MIN, MIN_FULL_DAYS, NEAR_CAP, SUSPENDED, SUSPENDED_ID, TZ, berlinMidnight, cellStats, isPlausible, keyFilter, mbRedSet, overLimit, sum, weekdayOf } from './pulse-report-base.js';
import { zoneCapCheck } from './pulse-report-city.js';

// ---------- Obergrenzen ----------
export function capStatus(value, limit) {
  if (!(limit > 0) || value == null) return { status: 'unknown', share: null };
  const share = value / limit;
  return { status: share > 1 ? 'over' : share >= NEAR_CAP ? 'near' : 'ok', share };
}
// Einträge in reference.json → obergrenzen: ags, ort, type ('scooter' | 'bike'), gesamt, jeAnbieter, ab + gesamtAb (Wechsel am Stichtag),
// zonen [{ name, gesamt?, jeAnbieter?, jeAnbieterAbgeleitet?, anteilMax?, anteilMin? (Anteil an der Flotte des Anbieters, 0–1), hinweis?,
// beobachtung? (Zonen-ID in zone-watch.json, vermutete Abgrenzung) }], anbieter [Namen laut Quelle], anbieterZahl, status, statusText,
// hinweis, art, stand, seit, quelle/url (+ quelle2, url2, url3), jeAnbieterAbgeleitet / gesamtAbgeleitet. Unbekannte Felder stören nicht.
// Regeln: Nur amtliche Einträge (status 'amtlich'; ohne status wie bisher amtlich) ergeben Kennzahlen und Verstöße; 'geplant', 'presse',
// 'ungeprüft', 'veraltet' nur zur Information, 'keine' = keine Obergrenze laut Quelle. Zonen gelten nur in einem Teilgebiet und sind ohne
// Gebietsgrenze nicht prüfbar (nie gegen den Bestand der ganzen Gemeinde); mit beobachtung gegen die vermutete Abgrenzung (zoneCapCheck). Gerechnete Grenzen (…Abgeleitet: nicht in der Quelle) liefern
// Kennzahlen, aber keinen Verstoß (Status „hint“). Ohne gesamt und ohne jeAnbieter keine Rate. Anbieter außerhalb einer vollständigen
// anbieter-Liste: „ohne Zulassung laut Quelle“ (kein Verstoß, keine Rate je Anbieter).
const DISTRICT_KEYS = [['innenstadtbezirke', 'Innenstadtbezirke'], ['zentraleInnenstadt', 'Zentrale Innenstadt']];
export const CAP_SOURCE_STATUS = { amtlich: 'amtlich', geplant: 'geplant', presse: 'nur Pressebericht', 'ungeprüft': 'ungeprüft', veraltet: 'veraltet', keine: 'keine Obergrenze laut Quelle' };
export const capOfficial = (e) => e?.status == null || e.status === 'amtlich';
const numOrNull = (x) => (x == null || x === '' || typeof x === 'boolean' || Array.isArray(x) || !Number.isFinite(+x) ? null : +x);
/** Zahl oder Spanne aus der Quelle (gesamt: [9000, 10000]) als Liste, nur zur Anzeige */
const numsOf = (x) => (Array.isArray(x) ? x : [x]).map(numOrNull).filter(v => v != null);
/** Gültige Gesamtgrenze zum Zeitpunkt asOf: „ab“ + „gesamtAb“ lösen „gesamt“ ab */
export function capLimit(entry, asOf = Date.now()) {
  const g = numOrNull(entry?.gesamt), gAb = numOrNull(entry?.gesamtAb);
  const ab = entry?.ab ? berlinMidnight(entry.ab) : null; // Stichtag 0 Uhr Ortszeit (im Sommer +02:00)
  if (ab != null && Number.isFinite(ab) && gAb != null) {
    if (asOf >= ab) return { limit: gAb, since: entry.ab, previous: g, next: null };
    return { limit: g, since: entry.seit || null, previous: null, next: { limit: gAb, from: entry.ab } };
  }
  return { limit: g, since: entry?.seit || null, previous: null, next: null };
}
const LIMIT_KEYS = ['limit', 'grenze', 'max', 'fahrzeuge', 'gesamt', 'wert', 'jeAnbieter', 'anzahl'];
const NAME_KEYS = ['anbieter', 'name', 'op', 'operator'];
const limitOf = (v) => (typeof v === 'object' && v ? LIMIT_KEYS.map(k => numOrNull(v[k])).find(x => x != null) ?? null : numOrNull(v));
// Fahrzeugart einer Grenze: 'bike' deckt Räder und E-Räder ab (Dresden: Lime-E-Räder zählen zur Rad-Grenze), außer exakteArt: true
const typesOfCap = (e) => { const t = [].concat(e?.type || 'scooter').map(String).filter(Boolean); const out = t.length ? t : ['scooter']; return e?.exakteArt === true ? out : [...new Set(out.flatMap(x => (x === 'bike' ? ['bike', 'ebike'] : [x])))]; };
// Anbieternamen vergleichbar machen: „Dott (TIER)“ → dott, tier; TIER und Dott sind seit 2024 ein Unternehmen, die Feeds heißen Dott
const OP_ALIAS = { tier: 'dott', limebike: 'lime', 'voi technology': 'voi' };
const nameKeys = (n) => String(n ?? '').toLowerCase().split(/[()\/,;+&]|\sund\s/).map(x => x.trim()).filter(Boolean).flatMap(x => [x, OP_ALIAS[x]].filter(Boolean));
/**
 * Anbieter eines Eintrags: jeAnbieter gilt für alle (jeAnbieterAbgeleitet: gerechnet); das Feld anbieter ist eine Namensliste (zugelassene
 * Anbieter laut Quelle) oder Objekte/Map mit eigener Zahl. Rückgabe { perOperator, perOperatorDerived, of(op), own(op), listed, licensed(op) }:
 * licensed → true/false nur bei vollständiger Liste (anbieterZahl fehlt oder Liste so lang), sonst null.
 */
export function capOperatorLimits(entry) {
  const perOperator = numOrNull(entry?.jeAnbieter); const by = new Map(); const names = [];
  const put = (name, v) => { if (name == null || name === '') return; names.push(String(name).trim()); const l = limitOf(v); if (l != null) for (const k of nameKeys(name)) by.set(k, l); };
  const a = entry?.anbieter;
  if (Array.isArray(a)) for (const x of a) { if (typeof x === 'string') put(x, null); else if (x && typeof x === 'object') put(NAME_KEYS.map(k => x[k]).find(n => typeof n === 'string'), x); }
  else if (a && typeof a === 'object') for (const [n, v] of Object.entries(a)) put(n, v);
  const n = numOrNull(entry?.anbieterZahl), complete = names.length > 0 && (n == null || names.length >= n);
  const keys = new Set(names.flatMap(nameKeys));
  const ownKey = (op) => nameKeys(op).find(k => by.has(k));
  return { perOperator, perOperatorDerived: !!entry?.jeAnbieterAbgeleitet, listed: names.length ? names : null, complete,
    of: (op) => { const k = ownKey(op); return k ? by.get(k) : perOperator; }, own: (op) => !!ownKey(op),
    licensed: (op) => (complete ? nameKeys(op).some(k => keys.has(k)) : null) };
}
/** Teilgebiete mit eigener Grenze (zonen, sonst die alten Felder innenstadtbezirke/zentraleInnenstadt): ohne Gebietsgrenze nicht prüfbar */
function capDistricts(e) {
  const z = e?.zonen; const out = [];
  const add = (label, v, i) => { if (!label) return; const o = v && typeof v === 'object' ? v : { gesamt: v };
    const limit = numOrNull(o.gesamt) ?? (o.jeAnbieter == null ? limitOf(o) : null), per = numOrNull(o.jeAnbieter);
    // Anteil an der Flotte des Anbieters (anteilMax/anteilMin, 0–1; Werte über 1 als Prozent gelesen)
    const frac = (x) => { const v = numOrNull(x); return v == null || v < 0 ? null : v > 1 ? v / 100 : v; };
    out.push({ key: `zone${i}`, label: String(label), limit, perOperator: per, perOperatorDerived: !!o.jeAnbieterAbgeleitet, hinweis: typeof o.hinweis === 'string' ? o.hinweis : null, status: 'unchecked',
      watch: typeof o.beobachtung === 'string' && o.beobachtung ? o.beobachtung : null, shareMax: frac(o.anteilMax), shareMin: frac(o.anteilMin) }); };
  if (Array.isArray(z)) z.forEach((x, i) => { if (x && typeof x === 'object') add(['name', 'label', 'zone', 'bezeichnung'].map(k => x[k]).find(n => typeof n === 'string'), x, i); });
  else if (z && typeof z === 'object') Object.entries(z).forEach(([n, v], i) => add(n, v, i));
  if (!out.length) for (const [k, label] of DISTRICT_KEYS) if (e?.[k] != null) out.push({ key: k, label, limit: numOrNull(e[k]), perOperator: null, perOperatorDerived: false, hinweis: null, status: 'unchecked' });
  return out;
}
// Status einer Kennzahl gegen eine Grenze; gerechnete Grenze: statt „nahe/über“ nur „hint“ (Hinweis, kein Verstoß)
export const rateStatus = (v, limit, derived) => { const s = capStatus(v, limit); return derived && (s.status === 'over' || s.status === 'near') ? { ...s, status: 'hint' } : s; };
/**
 * Bestand gegen Obergrenzen je Eintrag (Gemeinde × Art). groups: latest.json groups; Bestand = alle im Feed gemeldeten Fahrzeuge der Art
 * (verfügbar, reserviert, gesperrt), nach Abgleich der Quellen. Zonen/Bezirke: nicht prüfbar. Nicht amtliche Einträge: limit null,
 * status 'info' ('none' bei status 'keine'); die Zahlen der Quelle stehen in info. Je Anbieter zusätzlich buchbar (available) und
 * Verfügbar ÷ erlaubt: availShare = buchbar ÷ eigene Grenze; ohne eigene Grenze capShare/capShareAvail = gemeldet bzw. buchbar ÷ Gesamtgrenze.
 */
export function capsCheck(reference, groups, { ags = 'DE', asOf = Date.now(), zoneWatch = null } = {}) {
  const out = [];
  for (const e of reference?.obergrenzen || []) {
    if (!e?.ags || (ags !== 'DE' && e.ags !== ags)) continue;
    const types = typesOfCap(e), official = capOfficial(e), src = typeof e.status === 'string' ? e.status : 'amtlich';
    const byOp = new Map();
    for (const [k, st] of Object.entries(groups || {})) {
      const [a, op, t] = k.split('|'); if (a !== e.ags || !types.includes(t)) continue;
      if ((e.ausgenommeneAnbieter || []).includes(op)) continue; // laut Quelle nicht von der Grenze erfasst (z. B. Bestandsschutz)
      const o = byOp.get(op) || { op, total: 0, available: 0, disabled: 0, reserved: 0 };
      o.total += st.total || 0; o.available += st.available || 0; o.disabled += st.disabled || 0; o.reserved += st.reserved || 0; byOp.set(op, o);
    }
    const lim0 = capLimit(e, asOf); const L = capOperatorLimits(e);
    const lim = official ? lim0 : { ...lim0, limit: null, previous: null, next: null };
    const limitDerived = !!e.gesamtAbgeleitet;
    const share = (v, l) => (l > 0 && v != null ? v / l : null);
    const ops = [...byOp.values()].sort((a, b) => b.total - a.total).map(o => {
      const licensed = L.licensed(o.op);
      const limit = official && licensed !== false ? L.of(o.op) : null, derived = !L.own(o.op) && L.perOperatorDerived;
      const st = licensed === false ? { status: 'unlicensed', share: null } : rateStatus(o.total, limit, derived);
      return { ...o, licensed, limit, derived, ...st, availShare: share(o.available, limit), availStatus: licensed === false ? 'unlicensed' : rateStatus(o.available, limit, derived).status,
        capShare: share(o.total, lim.limit), capShareAvail: share(o.available, lim.limit) };
    });
    const total = sum(ops.map(o => o.total)), available = sum(ops.map(o => o.available));
    const tot = official ? (lim.limit > 0 ? rateStatus(total, lim.limit, limitDerived) : { status: 'unknown', share: null }) : { status: src === 'keine' ? 'none' : 'info', share: null };
    const links = [[e.url2, e.quelle2], [e.url3, null]].filter(([u]) => typeof u === 'string' && u).map(([url, quelle]) => ({ url, quelle: quelle || null }));
    out.push({ ags: e.ags, ort: e.ort || e.ags, type: types[0], types, official, sourceStatus: src, statusText: typeof e.statusText === 'string' ? e.statusText : CAP_SOURCE_STATUS[src] || null,
      art: typeof e.art === 'string' ? e.art : null, hinweis: typeof e.hinweis === 'string' ? e.hinweis : null, info: { gesamt: numsOf(e.gesamt), jeAnbieter: numsOf(e.jeAnbieter) },
      total, available, ...lim, limitDerived, ...tot, availShare: share(available, lim.limit), availStatus: lim.limit > 0 ? rateStatus(available, lim.limit, limitDerived).status : tot.status,
      perOperator: official ? L.perOperator : null, perOperatorDerived: L.perOperatorDerived, hasRate: official && (lim.limit > 0 || ops.some(o => o.limit > 0) || L.perOperator > 0),
      listed: L.listed, listComplete: L.complete, operators: ops, districts: capDistricts(e).map(d => { const ck = zoneWatch ? zoneCapCheck(d, zoneWatch, { types, licensed: L.licensed, fleet: new Map([...byOp].map(([op, o]) => [op, o.total])), official }) : null; return ck ? { ...d, status: ck.status, check: ck } : d; }), quelle: e.quelle || null, url: e.url || null, links, stand: typeof e.stand === 'string' ? e.stand : null, seit: e.seit || null });
  }
  return out;
}
/**
 * Verfügbar ÷ erlaubt je Gemeinde × Art × Anbieter (Leistung › Verfügbarkeit je Stadt), nur amtliche Einträge mit stadtweiter Zahl.
 * Je Anbieter mit eigener Grenze (jeAnbieter/anbieter): buchbare Fahrzeuge ÷ seine Grenze (kind 'operator'). Gibt es nur eine Gesamtgrenze:
 * buchbar ÷ Gesamtgrenze als Anteil des Anbieters an der Gesamtgrenze (kind 'share'); die Zeile op '*' (nur ohne Anbieterfilter) stellt die
 * Summe der Gesamtgrenze gegenüber (kind 'total'). Anbieter außerhalb der Zulassungsliste: kind 'unlicensed' ohne Rate. Gemeldet ÷ erlaubt
 * ebenso mit allen gemeldeten Fahrzeugen. Gezählt wird nur die Fahrzeugart der Obergrenze. Tagesmittel/-minimum: je Sammler-Punkt aus
 * history/<Tag>.json buchbar ÷ Grenze zu diesem Zeitpunkt. Rückgabe { rows, cities: Einträge mit Rate, skipped: Grenze gilt für eine andere Art,
 * info: Einträge ohne Rate (nicht amtlich, keine Grenze, nur Teilgebiete) }.
 */
export function capAvailability(reference, latest, { hist = null, operator = 'all', type = 'all', asOf = Date.now() } = {}) {
  const rows = [], skipped = [], info = []; let cities = 0;
  const t = hist?.t || [];
  for (const e of reference?.obergrenzen || []) {
    if (!e?.ags) continue;
    const c = capsCheck({ obergrenzen: [e] }, latest?.groups, { ags: e.ags, asOf })[0]; if (!c) continue;
    if (!c.hasRate) { info.push({ ags: c.ags, ort: c.ort, types: c.types, sourceStatus: c.sourceStatus, statusText: c.statusText, art: c.art, info: c.info, districts: c.districts, official: c.official, quelle: c.quelle, url: c.url, stand: c.stand }); continue; }
    cities++;
    if (type !== 'all' && !c.types.includes(type)) { skipped.push({ ags: c.ags, ort: c.ort, types: c.types }); continue; }
    const L = capOperatorLimits(e); const limAt = t.map(tt => capLimit(e, tt).limit);
    // Sammler-Punkte je Anbieter: buchbar je Punkt (null = keine Angabe in diesem Lauf)
    const pts = new Map();
    for (const [k, ser] of Object.entries(hist?.series || {})) {
      const [a, op, ty] = k.split('|'); if (a !== c.ags || !c.types.includes(ty)) continue;
      const p = pts.get(op) || new Array(t.length).fill(null);
      for (let i = 0; i < t.length; i++) { const v = ser.available?.[i]; if (v != null && Number.isFinite(+v)) p[i] = (p[i] || 0) + +v; }
      pts.set(op, p);
    }
    const dayStats = (avail, limitFn) => { let s = 0, n = 0, min = null, minAt = null; for (let i = 0; i < t.length; i++) { const l = limitFn(i); if (avail[i] == null || !(l > 0)) continue; const v = avail[i] / l; s += v; n++; if (min == null || v < min) { min = v; minAt = t[i]; } } return n ? { dayMean: s / n, dayMin: min, dayMinAt: minAt, dayN: n } : { dayMean: null, dayMin: null, dayMinAt: null, dayN: 0 }; };
    const base = { ags: c.ags, ort: c.ort, types: c.types, capTotal: c.limit ?? null, since: c.since ?? null, next: c.next ?? null, previous: c.previous ?? null, quelle: c.quelle, url: c.url, links: c.links, stand: c.stand, art: c.art, listed: c.listed, listComplete: c.listComplete, districts: c.districts };
    for (const o of c.operators) {
      if ((operator !== 'all' && o.op !== operator) || !(o.total > 0 || o.available > 0)) continue; // Anbieter ohne Fahrzeuge im Feed: keine Zeile
      const own = o.limit > 0, unl = o.licensed === false;
      const kind = unl ? 'unlicensed' : own ? 'operator' : c.limit > 0 ? 'share' : 'none';
      const limit = kind === 'operator' ? o.limit : kind === 'share' ? c.limit : null, derived = kind === 'operator' ? o.derived : kind === 'share' ? c.limitDerived : false;
      const p = pts.get(o.op) || [];
      rows.push({ ...base, op: o.op, kind, limit, derived, licensed: o.licensed, total: o.total, available: o.available, disabled: o.disabled, reserved: o.reserved,
        availRate: limit > 0 ? o.available / limit : null, totalRate: limit > 0 ? o.total / limit : null, availStatus: rateStatus(o.available, limit, derived).status, totalStatus: rateStatus(o.total, limit, derived).status,
        ...(limit > 0 ? dayStats(p, (i) => (kind === 'operator' ? o.limit : limAt[i])) : dayStats([], () => null)) });
    }
    if (operator === 'all' && c.limit > 0 && c.operators.length) {
      const all = new Array(t.length).fill(null);
      for (const p of pts.values()) p.forEach((v, i) => { if (v != null) all[i] = (all[i] || 0) + v; });
      rows.push({ ...base, op: '*', kind: 'total', limit: c.limit, derived: c.limitDerived, total: c.total, available: c.available, availRate: c.available / c.limit, totalRate: c.total / c.limit,
        availStatus: rateStatus(c.available, c.limit, c.limitDerived).status, totalStatus: rateStatus(c.total, c.limit, c.limitDerived).status, ...dayStats(all, (i) => limAt[i]) });
    }
  }
  return { rows, cities, skipped, info };
}
export function capAvailabilityCsvRows(rows, { operator = 'all', type = 'all', at = null, day = null, typeLabel = (x) => x, lang = 'de' } = {}) {
  const head = ['AGS', 'Stadt', 'Anbieter', 'Fahrzeugart_Grenze', 'Anbieter_Filter', 'Fahrzeugart_Filter', 'Gemeldet', 'Buchbar', 'Erlaubt', 'Bezug', 'Grenze_gerechnet', 'Verfuegbar_je_erlaubt', 'Gemeldet_je_erlaubt', 'Tagesmittel_Verfuegbar_je_erlaubt', 'Tagesminimum_Verfuegbar_je_erlaubt', 'Sammler_Punkte', 'Tag', 'Quelle', 'Quelle_URL', 'Stand_Quelle', 'Stand'];
  const X = (v) => csvText(v, lang);
  const kind = { operator: X('Grenze je Anbieter'), share: X('Anteil an der Gesamtgrenze'), total: X('Gesamtgrenze, alle Anbieter'), unlicensed: X('ohne Zulassung laut Quelle'), none: X('keine Zahl') };
  return [head.map(X), ...rows.map(r => [r.ags, r.ort, r.op === '*' ? X('alle Anbieter') : r.op, r.types.map(typeLabel).join(', '), operator === 'all' ? X('alle') : operator, type === 'all' ? X('alle') : typeLabel(type), r.total, r.available, r.limit ?? '', kind[r.kind] || '', r.derived ? X('ja') : '',
    [r.availRate, 4], [r.totalRate, 4], [r.dayMean, 4], [r.dayMin, 4], r.dayN || '', day || '', r.quelle || '', r.url || '', r.stand || '', at ? new Date(at).toISOString() : ''])];
}

// ---------- Obergrenzen-Protokoll (caps-log.json, schreibt der Sammler je Lauf) ----------
const dayFmt = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: TZ });
export const berlinDay = (ms) => dayFmt.format(new Date(ms));
export const CAPS_LOG_FIELDS = ['at', 'ags', 'operator', 'count', 'limit', 'dtMs'];
export const CAPS_DAILY_FIELDS = ['day', 'ags', 'operator', 'max', 'limit', 'at'];
/**
 * Protokoll fortschreiben: Läufe mit Bestand ≥ 90 % der Grenze (gesamt '*' und je Anbieter) als Prüfung, dazu je Tag × Gemeinde × Anbieter
 * das Tagesmaximum (auch unter 90 %, für den Verlauf). caps: Ergebnis von capsCheck; dt: Fenster seit dem vorigen Lauf (ms) für die Dauer.
 * Behält days Tage, höchstens maxChecks Prüfungen (älteste fallen zuerst).
 */
// Schlüssel im Protokoll: AGS (E-Scooter, wie bisher) bzw. „AGS~Art“ für weitere Arten derselben Gemeinde (Dresden: E-Scooter und Räder)
export const capLogKey = (c) => (!c?.type || c.type === 'scooter' ? c.ags : `${c.ags}~${c.type}`);
export function capsLogUpdate(prev, caps, { at = Date.now(), dt = null, days = 30, maxChecks = 6000 } = {}) {
  const cut = at - days * 86400e3, today = berlinDay(at), dayCut = berlinDay(cut);
  const checks = (Array.isArray(prev?.checks) ? prev.checks : []).filter(c => Array.isArray(c) && c[0] >= cut && c[0] < at);
  const daily = new Map((Array.isArray(prev?.daily) ? prev.daily : []).filter(d => Array.isArray(d) && d[0] >= dayCut).map(d => [`${d[0]}|${d[1]}|${d[2]}`, d]));
  const dtMs = Number.isFinite(dt) && dt > 0 ? Math.min(dt, GAP_MS) : null;
  // nur amtliche, in der Quelle genannte Grenzen: gerechnete (…Abgeleitet) und nicht amtliche Einträge erzeugen keine Prüfung
  const counted = (caps || []).filter(c => c.official !== false && c.hasRate !== false);
  for (const c of counted) {
    const lk = capLogKey(c);
    for (const [op, n, lim] of [['*', c.total, c.limitDerived ? null : c.limit], ...(c.operators || []).map(o => [o.op, o.total, o.derived || o.licensed === false ? null : o.limit])]) {
      if (!(n > 0) && op !== '*') continue;
      if (lim > 0 && n / lim >= NEAR_CAP) checks.push([at, lk, op, n, lim, dtMs]);
      const k = `${today}|${lk}|${op}`, d = daily.get(k);
      if (!d || n > d[3]) daily.set(k, [today, lk, op, n, lim ?? null, at]);
    }
  }
  const rules = counted.map(c => ({ ags: capLogKey(c), ort: c.ort, type: c.type, limit: c.limit ?? null, perOperator: c.perOperator ?? null, since: c.since ?? null, next: c.next ?? null, quelle: c.quelle ?? null, url: c.url ?? null }));
  return { updatedAt: at, days, fields: CAPS_LOG_FIELDS, dailyFields: CAPS_DAILY_FIELDS, rules, checks: checks.sort((a, b) => a[0] - b[0]).slice(-maxChecks), daily: [...daily.values()].sort((a, b) => a[0].localeCompare(b[0]) || String(a[1]).localeCompare(String(b[1])) || String(a[2]).localeCompare(String(b[2]))) };
}
/**
 * Verstöße der letzten days Tage je Gemeinde: je Anbieter (und '*' gesamt) Dauer über der Grenze, Dauer nahe (90–100 %), Spitzenwert,
 * Zahl der Läufe; Verlauf = Tagesmaximum gesamt. Läufe ohne Fenster (dtMs null) zählen mit defaultDt.
 */
export function capsViolations(log, { ags = 'DE', asOf = Date.now(), days = 30, defaultDt = 20 * 60e3 } = {}) {
  if (!log || !Array.isArray(log.checks)) return [];
  const cut = asOf - days * 86400e3, dayCut = berlinDay(cut);
  const by = new Map();
  const A = (a) => { if (!by.has(a)) { const rule = (log.rules || []).find(r => r.ags === a) || { ags: a }; by.set(a, { ags: a, ort: rule.ort || a, rule, ops: new Map(), daily: [] }); } return by.get(a); };
  const mine = (a) => ags === 'DE' || a === ags || String(a).startsWith(`${ags}~`);
  for (const r of log.rules || []) if (mine(r.ags)) A(r.ags);
  for (const c of log.checks) {
    const [at, a, op, n, lim, dt] = c; if (!(at >= cut) || !mine(a) || !(lim > 0)) continue;
    const g = A(a); const o = g.ops.get(op) || { op, overMs: 0, nearMs: 0, overRuns: 0, nearRuns: 0, peak: 0, peakAt: null, limit: lim, lastOverAt: null, firstAt: at };
    const w = Number.isFinite(dt) && dt > 0 ? dt : defaultDt;
    if (n > lim) { o.overMs += w; o.overRuns++; o.lastOverAt = at; } else { o.nearMs += w; o.nearRuns++; }
    if (n > o.peak) { o.peak = n; o.peakAt = at; o.limit = lim; }
    g.ops.set(op, o);
  }
  for (const d of log.daily || []) { const [day, a, op, max, lim] = d; if (day < dayCut || !mine(a) || op !== '*') continue; A(a).daily.push({ day, max, limit: lim }); }
  return [...by.values()].map(g => ({ ...g, ops: [...g.ops.values()].sort((x, y) => (x.op === '*' ? -1 : y.op === '*' ? 1 : y.overMs - x.overMs || y.peak - x.peak)), daily: g.daily.sort((x, y) => x.day.localeCompare(y.day)) }));
}

// ---------- CSV ----------
/** Zelle für CSV: Deutsch (Standard) mit Semikolon und Dezimalkomma, Englisch (lang 'en') mit Komma und Dezimalpunkt;
 *  Text mit = + - @ (auch Tab/CR) am Anfang bekommt ' davor (Formel-Injection) */
export const csvSep = (lang = 'de') => (lang === 'en' ? ',' : ';');
export function csvCell(v, digits = null, lang = 'de') {
  if (v == null || (typeof v === 'number' && !Number.isFinite(v))) return '';
  let s;
  if (typeof v === 'number') s = (digits == null ? String(+v.toFixed(4)) : v.toFixed(digits)).replace('.', lang === 'en' ? '.' : ',');
  else { s = String(v); if (/^[\s\u00a0]*[=+\-@\t\r]/.test(s)) s = `'${s}`; } // Formel-Schutz, auch hinter führenden Leerzeichen
  return s.includes(csvSep(lang)) || /["\r\n]/.test(s) || s !== s.trim() ? `"${s.replace(/"/g, '""')}"` : s;
}
export const toCsv = (rows, lang = 'de') => rows.map(r => r.map(c => (Array.isArray(c) ? csvCell(c[0], c[1], lang) : csvCell(c, null, lang))).join(csvSep(lang))).join('\r\n');
// Spaltenköpfe und feste Zellwerte der CSV-Exporte je Sprache (Deutsch bleibt das Archivformat; Englisch für die englische Oberfläche)
const CSV_EN = {
  AGS: 'AGS', Stadt: 'City', Land: 'State', Anbieter: 'Operator', Gemeinde: 'Municipality', Tag: 'Day', Fahrzeugart: 'Vehicle_type', Fahrzeugart_Grenze: 'Vehicle_type_cap', Anbieter_Filter: 'Operator_filter',
  Fahrzeugart_Filter: 'Vehicle_type_filter', Gemeldet: 'Reported', Buchbar: 'Bookable', Erlaubt: 'Allowed', Bezug: 'Basis', Grenze_gerechnet: 'Cap_calculated', Verfuegbar_je_erlaubt: 'Available_per_allowed',
  Gemeldet_je_erlaubt: 'Reported_per_allowed', Tagesmittel_Verfuegbar_je_erlaubt: 'Daily_mean_available_per_allowed', Tagesminimum_Verfuegbar_je_erlaubt: 'Daily_min_available_per_allowed',
  Sammler_Punkte: 'Collector_points', Quelle: 'Source', Quelle_URL: 'Source_URL', Stand_Quelle: 'Source_as_of', Stand: 'As_of', Zeitraum_von: 'Period_from', Zeitraum_bis: 'Period_to',
  Flotte_Mittel: 'Fleet_mean', Flotte_Quelle: 'Fleet_source', Fahrten_gemessen: 'Trips_measured', Fahrten_je_Tag_hochgerechnet: 'Trips_per_day_extrapolated', Fahrten_je_Fahrzeug_Tag: 'Trips_per_vehicle_day',
  Sperrquote: 'Disabled_rate', Dauer_Mittel_min: 'Duration_mean_min', Distanz_Mittel_km_Luftlinie: 'Distance_mean_km_straight_line', Fahrzeuge_je_1000_EW: 'Vehicles_per_1000_residents',
  Fahrten_je_1000_EW_Tag: 'Trips_per_1000_residents_day', Beobachtet_h: 'Observed_h', Luecken_Laeufe: 'Gap_runs', vorlaeufig: 'preliminary', Hinweis: 'Note', Fahrten_je_Tag_kalibriert: 'Trips_per_day_calibrated',
  Fahrten_je_Tag_kalibriert_von: 'Trips_per_day_calibrated_from', Fahrten_je_Tag_kalibriert_bis: 'Trips_per_day_calibrated_to', Fahrten_je_Fahrzeug_Tag_kalibriert: 'Trips_per_vehicle_day_calibrated',
  Kalibrierfaktor: 'Calibration_factor', Kalibrierung: 'Calibration', Zeitraum_Art: 'Period_type', Zeitraum_Name: 'Period_name', Quartal: 'Quarter', Verfuegbarkeit: 'Availability', Einsatzbereit: 'Ready_to_ride',
  Energieangabe_Fahrzeuge: 'Vehicles_with_energy_data', Gesperrt_Anteil: 'Disabled_share', Reserviert: 'Reserved', Anbieter_Anzahl: 'Operator_count', Tagesmittel_Verfuegbarkeit: 'Daily_mean_availability',
  Tagesminimum_Verfuegbarkeit: 'Daily_min_availability', Zelle: 'Cell', Breite: 'Latitude', Laenge: 'Longitude', Fahrtbeginne: 'Trip_starts', Fahrtenden: 'Trip_ends', Verfuegbar_je_Lauf: 'Available_per_run',
  Umsetzungen: 'Rebalancing',
  // Werte
  alle: 'all', 'alle Anbieter': 'all operators', ja: 'yes', nein: 'no', Alle: 'All', Zeitraum: 'Period', Monat: 'Month', Tage: 'Days', 'Grenze je Anbieter': 'Cap per operator',
  'Anteil an der Gesamtgrenze': 'Share of the total cap', 'Gesamtgrenze, alle Anbieter': 'Total cap, all operators', 'ohne Zulassung laut Quelle': 'not licensed according to source', 'keine Zahl': 'no figure',
  'ohne {x} (unplausibel)': 'without {x} (implausible)', [SUSPENDED_ID()]: 'Calibration suspended – measurement implausible (overcount likely)',
  'unplausibel hoch – Kennungen wechseln vermutlich ohne Fahrt': 'implausibly high – IDs probably rotate without a trip',
  'deutlich mehr Fahrtenden als -beginne (Neuaufstellungen oder Kennungswechsel)': 'clearly more trip ends than starts (redeployments or ID rotation)',
  'weniger als ein Viertel des Tagesgangs beobachtet': 'less than a quarter of the daily profile observed',
};
/** Kopf oder fester Wert in der Sprache der CSV (unbekannte Texte bleiben) */
export const csvText = (s, lang = 'de', vars = null) => { if (lang !== 'en' || s == null) return s; const v = CSV_EN[s] ?? s; return vars ? v.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m)) : v; };
/** Bericht als Tabelle in Langform: je Tag × Anbieter × Art eine Zeile, dazu je Anbieter × Art die Zeitraumwerte (Tag = „Zeitraum“) */
// cal: Ergebnis von pulse-calib calibrateReport (optional) und calLabel (z. B. „Berlin Q4/2025, vorläufig“); period: { kind: 'Quartal'|'Monat'|'Tage', label }
export function reportCsvRows(rep, { name = '', typeLabel = (t) => t, cal = null, calLabel = '', period = null, lang = 'de' } = {}) {
  const X = (v, vars) => csvText(v, lang, vars);
  const head = ['Gemeinde', 'AGS', 'Zeitraum_von', 'Zeitraum_bis', 'Tag', 'Anbieter', 'Fahrzeugart', 'Flotte_Mittel', 'Flotte_Quelle', 'Fahrten_gemessen', 'Fahrten_je_Tag_hochgerechnet', 'Fahrten_je_Fahrzeug_Tag', 'Sperrquote', 'Dauer_Mittel_min', 'Distanz_Mittel_km_Luftlinie', 'Fahrzeuge_je_1000_EW', 'Fahrten_je_1000_EW_Tag', 'Beobachtet_h', 'Luecken_Laeufe', 'vorlaeufig', 'Hinweis',
    'Fahrten_je_Tag_kalibriert', 'Fahrten_je_Tag_kalibriert_von', 'Fahrten_je_Tag_kalibriert_bis', 'Fahrten_je_Fahrzeug_Tag_kalibriert', 'Kalibrierfaktor', 'Kalibrierung', 'Zeitraum_Art', 'Zeitraum_Name', 'Quartal'];
  const rows = [head.map(X)];
  const base = [name, rep.ags, rep.from, rep.to];
  const prelim = X(rep.quality.prelim ? 'ja' : 'nein');
  const pk = X(period?.kind || 'Tage'), pl = period?.label || '';
  const qOf = (d) => (d && /^\d{4}-\d{2}/.test(d) ? `${d.slice(0, 4)}-Q${Math.floor((+d.slice(5, 7) - 1) / 3) + 1}` : '');
  const qSpan = qOf(rep.from) === qOf(rep.to) ? qOf(rep.from) : `${qOf(rep.from)}–${qOf(rep.to)}`;
  const noCal = ['', '', '', '', '', ''];
  for (const d of rep.daily) {
    for (const [k, v] of Object.entries(d.byGroup)) {
      const [op, ty] = k.split('|');
      rows.push([...base, d.day, op, typeLabel(ty), [v.fleet, 1], '', v.rides, '', '', '', '', '', '', '', [d.obsHours, 1], d.gapRuns ?? '', prelim, '', ...noCal, pk, pl, qOf(d.day)]);
    }
  }
  const calCols = (c) => (c?.calibrated ? [[c.ridesDay, 1], [c.lo, 1], [c.hi, 1], [c.rvd, 2], [c.factor, 3], calLabel] : noCal);
  for (const g of rep.groups) {
    rows.push([...base, X('Zeitraum'), g.op, typeLabel(g.ty), [g.fleet, 1], g.fleetSource || '', g.rides, [g.ridesDay, 1], [g.rvd, 2], [g.disabledShare, 3], [g.avgMin, 1], [g.avgKm, 2], [g.per1000Fleet, 2], [g.per1000Rides, 2], [rep.quality.obsMin / 60, 1], rep.quality.gapRuns ?? '', prelim, g.flags.map(f => X(f)).join(' | '), ...calCols(cal?.groups?.get(g.key)), pk, pl, qSpan]);
  }
  const t = rep.totals, ct = cal?.applied ? cal.totals : null;
  rows.push([...base, X('Zeitraum'), X('Alle'), X('Alle'), [t.fleet, 1], '', t.rides, [t.ridesDay, 1], [t.rvd, 2], [t.disabledShare, 3], '', '', [t.per1000Fleet, 2], [t.per1000Rides, 2], [rep.quality.obsMin / 60, 1], rep.quality.gapRuns ?? '', prelim, t.excluded.length ? X('ohne {x} (unplausibel)', { x: t.excluded.join(', ') }).replace('{x}', t.excluded.join(', ')) : '',
    ...(ct ? [[ct.ridesDay, 1], [ct.lo, 1], [ct.hi, 1], [ct.rvd, 2], '', calLabel] : noCal), pk, pl, qSpan]);
  return rows;
}

// ---------- Zeiträume: Monat und Quartal (Tagesdateien 30 Tage, darüber das Langzeit-Archiv) ----------
export const ARCHIVE_FIELDS = ['flotte_avg', 'fahrten', 'fahrtenden', 'kennungswechsel', 'umsetzungen', 'akkutausch', 'abholungen', 'sperren', 'beobachtet_min', 'flotte_verf', 'stunden_voll'];
const MONTHS = { de: ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'],
  en: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'] };
const pad = (n) => String(n).padStart(2, '0');
const lastDayOfMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate(); // m = 1…12
/** Zeitraum 'm:YYYY-MM' oder 'q:YYYY-Qn' → { kind, key, from, to, label }; kind ist eine Kennung ('Monat' | 'Quartal'), label in der Sprache lang */
export function periodRange(period, lang = 'de') {
  let m = /^m:(\d{4})-(\d{2})$/.exec(String(period || ''));
  if (m) { const y = +m[1], mo = +m[2]; return { kind: 'Monat', key: `${m[1]}-${m[2]}`, from: `${m[1]}-${m[2]}-01`, to: `${m[1]}-${m[2]}-${pad(lastDayOfMonth(y, mo))}`, label: `${(MONTHS[lang] || MONTHS.de)[mo - 1]} ${y}` }; }
  m = /^q:(\d{4})-Q([1-4])$/.exec(String(period || ''));
  if (m) { const y = +m[1], q = +m[2], m0 = (q - 1) * 3 + 1, m1 = m0 + 2; return { kind: 'Quartal', key: `${y}-Q${q}`, from: `${y}-${pad(m0)}-01`, to: `${y}-${pad(m1)}-${pad(lastDayOfMonth(y, m1))}`, label: `Q${q}/${y}` }; }
  return null;
}
/** Monate mit Daten: { key 'YYYY-MM', period 'm:…', label, days, complete } (vollständig = Daten reichen vom 1. bis zum Monatsende) */
export function monthsOf(days, lang = 'de') {
  const list = [...new Set(days || [])].filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort(); if (!list.length) return [];
  const by = new Map(); for (const d of list) by.set(d.slice(0, 7), (by.get(d.slice(0, 7)) || 0) + 1);
  return [...by].map(([k, n]) => { const r = periodRange(`m:${k}`, lang); return { key: k, period: `m:${k}`, label: r.label, days: n, complete: list[0] <= r.from && list[list.length - 1] >= r.to }; });
}
/** Quartale, über die die Daten ganz reichen (erster Tag ≤ Quartalsbeginn, letzter Tag ≥ Quartalsende): ['YYYY-Qn', …] */
export function completeQuarters(days) {
  const list = [...new Set(days || [])].filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort(); if (!list.length) return [];
  const out = []; const y0 = +list[0].slice(0, 4), y1 = +list[list.length - 1].slice(0, 4);
  for (let y = y0; y <= y1; y++) for (let q = 1; q <= 4; q++) { const r = periodRange(`q:${y}-Q${q}`); if (list[0] <= r.from && list[list.length - 1] >= r.to) out.push(r.key); }
  return out;
}
export const daysIn = (period, days) => { const r = periodRange(period); return r ? (days || []).filter(d => d >= r.from && d <= r.to).sort() : []; };
/**
 * Bericht aus dem Langzeit-Archiv (archive/<Monat>.json: je Tag und Gemeinde|Anbieter|Art Tageswerte), wenn der Zeitraum über die
 * 30 Tage der Tagesdateien hinausreicht. Gleiche Form wie municipalReport; Hochrechnung linear über die beobachtete Zeit
 * (Tagesgang je Stunde ist im Archiv nicht enthalten), ohne Orte, Dauer, Distanz und Sperrquote.
 */
// breaks/eventChecks wie municipalReport: Tage vor dem Bruch zählen für die Reihe nicht (der Bruchtag zählt ganz – das Archiv hat keine Stundenwerte;
// Marken reichen so weit wie history/daily.json, 30 Tage); rote Gruppen (Ampel) nicht plausibel (AMPEL_RED)
export function archiveReport({ archive = {}, fields = ARCHIVE_FIELDS, ags = undefined, pop = null, operator = 'all', type = 'all', days = null, rvdLimit = null, breaks = null, eventChecks = null } = {}) {
  const keep = keyFilter({ ags, operator, type }), ampelRed = mbRedSet(eventChecks);
  const F = (n) => fields.indexOf(n); const iF = F('flotte_avg'), iR = F('fahrten'), iE = F('fahrtenden'), iRl = F('umsetzungen'), iO = F('beobachtet_min');
  const list = (days || Object.keys(archive)).filter(d => archive[d]).sort();
  const G = new Map(); const acc = (op, ty) => { const k = `${op}|${ty}`; if (!G.has(k)) G.set(k, { op, ty, key: k, fleetDays: [], rides: 0, ends: 0, reloc: 0, cov: 0, breakDay: null, breakDays: new Set() }); return G.get(k); };
  const daily = []; let obsT = 0, full = 0;
  for (const day of list) {
    const rows = archive[day] || {}; let obs = 0; for (const v of Object.values(rows)) obs = Math.max(obs, +v?.[iO] || 0);
    const cov = Math.min(1, obs / 1440); obsT += obs; const isFull = obs >= FULL_DAY_HOURS * FULL_HOUR_MIN; if (isFull) full++;
    const row = { day, weekday: weekdayOf(day), obsHours: obs / 60, runs: null, gapRuns: null, coverage: cov, full: isFull, fleet: 0, fleetKnown: false, rides: 0, byGroup: {} };
    for (const [k, v] of Object.entries(rows)) {
      if (!keep(k) || !Array.isArray(v)) continue; const [, op, ty] = k.split('|'); const a = acc(op, ty);
      const bd = breaks?.[k] ?? null; if (bd) { a.breakDay = bd; if (day < bd) { a.breakDays.add(day); continue; } }
      const fleet = v[iF] == null ? null : +v[iF], rides = +v[iR] || 0;
      if (fleet != null) { a.fleetDays.push({ day, fleet }); row.fleet += fleet; row.fleetKnown = true; }
      a.rides += rides; a.ends += +v[iE] || 0; a.reloc += +v[iRl] || 0; if ((fleet || 0) > 0 || rides > 0) a.cov += cov;
      row.rides += rides; row.byGroup[`${op}|${ty}`] = { fleet, rides };
    }
    row.ridesDay = cov > 0 ? row.rides / cov : null; if (!row.fleetKnown) row.fleet = null; daily.push(row);
  }
  const per1000 = (v) => (pop > 0 && v != null ? (v / pop) * 1000 : null);
  const groups = [...G.values()].map(a => {
    const fl = a.fleetDays.map(x => x.fleet); const fleet = fl.length ? sum(fl) / fl.length : null;
    const ridesDay = a.cov > 0 ? a.rides / a.cov : null; const rvd = ridesDay != null && fleet > 0 ? ridesDay / fleet : null;
    const flags = []; if (rvd != null && rvd > DEFAULTS.maxRvd) flags.push('unplausibel hoch – Kennungen wechseln vermutlich ohne Fahrt'); else if (overLimit(rvd, a.ty, rvdLimit)) flags.push(SUSPENDED);
    if (ampelRed.has(`${ags}|${a.key}`)) flags.push(AMPEL_RED);
    return { key: a.key, op: a.op, ty: a.ty, fleet, fleetMin: fl.length ? Math.min(...fl) : null, fleetMax: fl.length ? Math.max(...fl) : null, fleetDays: a.fleetDays, fleetSource: 'Archiv', rides: a.rides, ends: a.ends, reloc: a.reloc,
      coverageDays: a.cov, ridesDay, rvd, disabledShare: null, disabledSource: null, avgMin: null, avgKm: null, durN: 0, distN: 0, per1000Fleet: per1000(fleet), per1000Rides: per1000(ridesDay), plausible: isPlausible(flags), flags,
      breakDay: a.breakDays.size || list.includes(a.breakDay) ? a.breakDay : null, breakSkipped: [...a.breakDays].sort() };
  }).filter(g => (g.fleet || 0) > 0 || g.rides > 0).sort((x, y) => (y.fleet || 0) - (x.fleet || 0) || y.rides - x.rides);
  const good = groups.filter(g => g.plausible); const fleetT = sum(groups.map(g => g.fleet)); const ridesDayT = good.some(g => g.ridesDay != null) ? sum(good.map(g => g.ridesDay)) : null; const fleetGood = sum(good.map(g => g.fleet));
  const totals = { fleet: groups.length ? fleetT : null, rides: sum(groups.map(g => g.rides)), ridesDay: ridesDayT, rvd: ridesDayT != null && fleetGood > 0 ? ridesDayT / fleetGood : null, disabledShare: null,
    per1000Fleet: per1000(groups.length ? fleetT : null), per1000Rides: per1000(ridesDayT), excluded: groups.filter(g => !g.plausible).map(g => g.key) };
  const quality = { source: 'archiv', days: list.length, runs: null, counted: null, gapRuns: null, gaps: [], obsMin: obsT, fullDays: full, excludedHours: 0, taintedDays: [], fleetFromHistory: [], possibleMin: list.length * 1440,
    prelim: full < MIN_FULL_DAYS, profileSource: 'linear über die beobachtete Zeit (Archiv ohne Stundenwerte)', profileDays: 0, longestGapMs: 0,
    breaks: groups.filter(g => g.breakDay).map(g => ({ key: g.key, day: g.breakDay, skipped: g.breakSkipped })) };
  return { ags, pop, from: list[0] || null, to: list[list.length - 1] || null, days: list, quality, groups, totals, daily, cells: cellStats({}, {}) };
}
/** Rangliste aus dem Archiv (je Gemeinde × Art): Ø Flotte, Fahrten/Tag linear hochgerechnet, Fahrten je Fahrzeug und Tag */
// breaks/eventChecks wie archiveReport (Tage vor dem Bruch nicht; rote Gruppen nur bei der Flotte)
export function cityRankingArchive(archive, latest, { fields = ARCHIVE_FIELDS, type = 'all', operator = 'all', days = null, rvdLimit = null, breaks = null, eventChecks = null } = {}) {
  const iF = fields.indexOf('flotte_avg'), iR = fields.indexOf('fahrten'), iO = fields.indexOf('beobachtet_min'), ampelRed = mbRedSet(eventChecks);
  const keep = keyFilter({ ags: 'DE', operator, type }); const list = (days || Object.keys(archive || {})).filter(d => archive?.[d]).sort();
  const G = new Map();
  for (const day of list) {
    const rows = archive[day]; let obs = 0; for (const v of Object.values(rows)) obs = Math.max(obs, +v?.[iO] || 0); const cov = Math.min(1, obs / 1440);
    for (const [k, v] of Object.entries(rows)) { if (!keep(k) || !Array.isArray(v) || (breaks?.[k] && day < breaks[k])) continue; const a = G.get(k) || { fl: [], rides: 0, cov: 0 }; if (v[iF] != null) a.fl.push(+v[iF]); a.rides += +v[iR] || 0; if ((+v[iF] || 0) > 0 || (+v[iR] || 0) > 0) a.cov += cov; G.set(k, a); }
  }
  const by = new Map();
  for (const [k, a] of G) {
    const [ags, , ty] = k.split('|'); const fleet = a.fl.length ? sum(a.fl) / a.fl.length : 0; const rd = a.cov > 0 ? a.rides / a.cov : null; const ok = !(rd != null && fleet > 0 && (rd / fleet > DEFAULTS.maxRvd || overLimit(rd / fleet, ty, rvdLimit))) && !ampelRed.has(k);
    const r = by.get(`${ags}|${ty}`) || { ags, ty, fleet: 0, fleetGood: 0, ridesDay: 0, has: false }; r.fleet += fleet; if (ok) { r.fleetGood += fleet; if (rd != null) { r.ridesDay += rd; r.has = true; } } by.set(`${ags}|${ty}`, r);
  }
  return { days: list, rows: [...by.values()].map(r => ({ key: `${r.ags}|${r.ty}`, ags: r.ags, ty: r.ty, name: latest?.municipalities?.[r.ags]?.name || r.ags, fleet: r.fleet, fleetGood: r.fleetGood, ridesDay: r.has ? r.ridesDay : null, rvd: r.has && r.fleetGood > 0 ? r.ridesDay / r.fleetGood : null })) };
}
/** Vorquartal für die Rangliste: die zwei jüngsten vollständigen Quartale, wenn sie aufeinanderfolgen; sonst null */
export function rankingQuarters(days) {
  const qs = completeQuarters(days); if (qs.length < 2) return null;
  const cur = qs[qs.length - 1], prev = qs[qs.length - 2];
  const n = (q) => +q.slice(0, 4) * 4 + +q.slice(6) - 1;
  return n(cur) - n(prev) === 1 ? { cur, prev, curDays: daysIn(`q:${cur}`, days), prevDays: daysIn(`q:${prev}`, days) } : null;
}

// ---------- Preisänderungs-Log ----------
const firstArr = (...xs) => xs.find(Array.isArray) || [];
/**
 * Einträge aus pricing-log.json in eine Form bringen: { at, day, operator, munis, plan, field, from, to, kind, sourceId }.
 * Format des Sammlers: { fields: ['at','sourceId','operator','planId','field','old','new'], changes: [[…], …] }; ältere/andere Formen als Rückfall.
 * sources (latest.json): Gebiet über sourceId → municipalities; pricing (pricing.json): Tarifname über sourceId + planId.
 */
export function priceLogEntries(log, { sources = null, pricing = null } = {}) {
  const srcMunis = new Map((sources || []).map(r => [r.id, r.municipalities || []]));
  const planName = new Map(); for (const p of pricing?.plans || []) for (const pl of p.plans || []) planName.set(`${p.sourceId}|${pl.id}`, pl.name);
  const raw = Array.isArray(log) ? log : firstArr(log?.changes, log?.entries, log?.events, log?.log);
  const fields = Array.isArray(log?.fields) ? log.fields : null;
  return raw.map(e => {
    const o = Array.isArray(e) && fields ? Object.fromEntries(fields.map((f, i) => [f, e[i]])) : (e && typeof e === 'object' ? e : {});
    const at = Number.isFinite(+o.at) ? +o.at : Date.parse(o.at || o.date || o.day || '') || null;
    const sourceId = o.sourceId ?? o.source ?? null;
    const munis = Array.isArray(o.municipalities) ? o.municipalities : o.ags ? [o.ags].flat() : (sourceId != null && srcMunis.get(sourceId)) || [];
    const planId = o.planId ?? o.plan_id ?? null;
    const plan = o.plan ?? o.planName ?? o.plan_name ?? (planId != null ? planName.get(`${sourceId}|${planId}`) ?? planId : null) ?? o.name ?? null;
    return { at, day: o.day || (at ? new Date(at).toISOString().slice(0, 10) : null), operator: o.operator ?? o.op ?? null, munis, plan: plan && typeof plan === 'object' ? (plan.name || plan.id || null) : plan,
      field: o.field ?? o.feld ?? null, from: o.old ?? o.from ?? o.before ?? o.alt ?? null, to: o.new ?? o.to ?? o.after ?? o.neu ?? null, kind: o.kind ?? o.type ?? o.change ?? o.art ?? null, sourceId, planId, note: o.note ?? o.desc ?? null };
  }).filter(e => e.operator || e.plan);
}
export function filterPriceLog(entries, { ags = 'DE', operator = 'all' } = {}) {
  return entries.filter(e => (ags === 'DE' || !e.munis.length || e.munis.includes(ags)) && (operator === 'all' || e.operator === operator)).sort((a, b) => (b.at || 0) - (a.at || 0));
}

// ---------- Feed-Prüfung ----------
// Befund als Text: „Datei: Meldung (Anzahl)“ – checkGbfs liefert { level, feed, msg, n? }
const textOf = (x) => {
  if (x == null) return '';
  if (typeof x === 'string') return x;
  const msg = x.msg || x.message || x.text || [x.field || x.path, x.rule || x.code].filter(Boolean).join(' · ');
  const where = x.feed || x.file;
  return msg ? `${where ? `${where}: ` : ''}${msg}${Number.isFinite(+x.n) && x.n != null ? ` (${x.n})` : ''}` : JSON.stringify(x);
};
/** sources[].checks lesen: Listen oder Zählungen von Fehlern und Warnungen, dazu die ersten Befunde */
export function normalizeChecks(checks) {
  if (!checks || typeof checks !== 'object') return null;
  let errors = [], warnings = [], nE = null, nW = null;
  if (Array.isArray(checks)) {
    for (const c of checks) { const lv = String(c?.level || c?.severity || c?.sev || '').toLowerCase(); (/err|fehler|fail|crit/.test(lv) ? errors : warnings).push(textOf(c)); }
  } else {
    const ce = checks.errors ?? checks.fehler, cw = checks.warnings ?? checks.warnungen;
    if (Array.isArray(ce)) errors = ce.map(textOf); else if (Number.isFinite(+ce)) nE = +ce;
    if (Array.isArray(cw)) warnings = cw.map(textOf); else if (Number.isFinite(+cw)) nW = +cw;
    const f = firstArr(checks.findings, checks.befunde, checks.issues, checks.items, checks.first);
    for (const c of f) { const lv = String(c?.level || c?.severity || '').toLowerCase(); (/err|fehler|fail|crit/.test(lv) ? errors : warnings).push(textOf(c)); }
  }
  const findings = [...errors.map(t => ({ level: 'error', text: t })), ...warnings.map(t => ({ level: 'warn', text: t }))].filter(x => x.text);
  return { errors: nE ?? errors.length, warnings: nW ?? warnings.length, findings, label: Array.isArray(checks) ? null : checks.label ?? null, at: checks.at ?? checks.checkedAt ?? null, version: checks.version ?? null };
}

// ---------- Verfügbarkeit je Stadt ----------
// Verfügbarkeit = buchbar ÷ gemeldet (latest.json groups: available ÷ total; buchbar = nicht gesperrt, nicht reserviert,
// bei Stationsfeeds ohne Fahrzeugliste die buchbaren Fahrzeuge an Stationen). Einsatzbereit = buchbar und Energie ausreichend,
// bezogen auf die Fahrzeuge mit Energieangabe (je Fahrzeug aus ops/<Land>.json desselben Sammler-Laufs).
export const MIN_FLEET = 50;
export const RANGE_ONLY_OPS = ['Lime']; // wie app.js: Feeds nur mit Reichweite – der Ladestand im Datenstand ist abgeleitet und zählt nicht
/** Anbieter, die nur Reichweite melden: RANGE_ONLY_OPS und Anbieter, von denen keine Quelle mit Fahrzeugen (live/verzögert) einen Ladestand aus dem
 *  Feed liefert (counts.batteryNative === 0 bei allen). Eine einzelne Quelle ohne Ladestand (z. B. Räder ohne Akku, voi_de) macht den Anbieter nicht
 *  dazu – dort fehlt der Ladestand ohnehin je Fahrzeug bzw. ist abgeleitet (batteryDerived) und zählt je Fahrzeug nur über die Reichweite. */
export function rangeOnlyOperators(sources) {
  const has = new Map();
  for (const r of sources || []) {
    if (!r?.operator || !(r.counts?.vehicles > 0) || !['live', 'delayed'].includes(r.feedStatus || r.status)) continue;
    has.set(r.operator, !!has.get(r.operator) || r.counts.batteryNative !== 0);
  }
  return new Set([...RANGE_ONLY_OPS, ...[...has].filter(([, b]) => !b).map(([op]) => op)]);
}
