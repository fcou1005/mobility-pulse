// Dashboard: Gebiet: Auswahl, Gemeinden, Kennzahlen je Gebiet (S3.9: aus web/app.js geschnitten, Einstieg bleibt web/app.js).
import * as C from './pulse-core.js';
import { t } from './i18n.js';
import { DEMO, state } from './app-core.js';
import { gapFitsType } from './app.js';

// ---------- Scope ----------
export const muniName = (ags) => state.latest?.municipalities?.[ags]?.name || state.boundaries?.features.find(f => f.properties.ags === ags)?.properties.name || ags;
export const muniInfo = (ags) => state.latest?.municipalities?.[ags] || null;
export function scopeLabel() { return state.scope === 'DE' ? t('app.allOfGermany') : `${muniName(state.scope)} (${muniInfo(state.scope)?.state || ''})`; }
export function keyMatches(key) {
  const [ags, op, ty] = key.split('|');
  if (state.scope === 'DE' ? ags === 'DE' : ags !== state.scope) return false;
  if (state.operator !== 'all' && op !== state.operator) return false;
  if (state.type !== 'all' && ty !== state.type) return false;
  return true;
}
// Gruppen der aktuellen Datenbasis (Sammler oder Live) auf den Scope gefiltert
export function scopeGroups() {
  const src = state.mode === 'live' && state.live ? state.live.groups : new Map(Object.entries(state.latest?.groups || {}));
  const out = new Map();
  for (const [k, st] of src) {
    const [ags, op, ty] = k.split('|');
    if (ags === 'DE') continue;
    if (state.scope !== 'DE' && ags !== state.scope) continue;
    if (state.operator !== 'all' && op !== state.operator) continue;
    if (state.type !== 'all' && ty !== state.type) continue;
    out.set(k, st);
  }
  return out;
}
export function sourcesForScope() {
  const recs = state.latest?.sources || [];
  if (state.scope === 'DE') return recs;
  return recs.filter(r => (r.municipalities || []).includes(state.scope));
}
export function liveRec(id) { return state.live?.recs.get(id) || null; }
// Eine Frische-Definition für Kachel, Tabelle und Ampel der Übersicht: Datenalter jetzt = Feedalter bei der Messung + Zeit seit der Messung.
// aktuell ≤ Sammler-Takt (20 Min.) + 10 Min., verzögert ≤ 60 Min., sonst veraltet. Im Demo-Stand zählt der Zeitpunkt des Laufs als „jetzt“.
export const FRESH_MS = 30 * 60e3, DELAY_MS = 60 * 60e3;
export const nowRef = () => DEMO && state.latest?.at ? state.latest.at : Date.now();
export function effStatus(r) {
  if (!['live', 'delayed', 'stale', 'collector'].includes(r.status)) return { status: r.status, age: r.feedAgeMs ?? null };
  if (r.feedAgeMs == null) return { status: 'unknown', age: null };
  const age = Math.max(0, r.feedAgeMs) + Math.max(0, nowRef() - (r.checkedAt || state.latest?.at || nowRef()));
  return { status: age <= FRESH_MS ? 'live' : age <= DELAY_MS ? 'delayed' : 'stale', age };
}
export const USABLE = new Set(['live', 'delayed']);
// Statistik-Summe inkl. der neuen Stationsfelder (Vertrag 3), auch wenn die Kernbibliothek sie noch nicht kennt
export const STAT_EXTRA = ['stationsVirtual', 'stationsEmptyVirtual', 'stationsEmptyDock'];
export function sumStats(list) {
  const out = C.sumStats(list);
  for (const f of STAT_EXTRA) { let n = 0, any = false; for (const st of list) if (st[f] != null) { any = true; n += st[f]; } if (any) out[f] = n; else delete out[f]; }
  return out;
}
// Anbieter-Übersicht für den Scope
export function operatorRows() {
  const groups = scopeGroups();
  const byOp = new Map();
  for (const [k, st] of groups) { const op = k.split('|')[1]; if (!byOp.has(op)) byOp.set(op, []); byOp.get(op).push(st); }
  const recs = sourcesForScope();
  const rows = [];
  for (const [op, list] of byOp) {
    const st = sumStats(list);
    const ops = recs.filter(r => r.operator === op);
    const effective = ops.map(r => liveRec(r.id) || r);
    const eff = effective.map(effStatus);
    const usable = eff.filter(e => USABLE.has(e.status));
    const age = usable.length ? Math.max(...usable.map(e => e.age ?? 0)) : (eff[0]?.age ?? null);
    const status = usable.some(e => e.status === 'live') ? 'live' : usable.length ? 'delayed' : (eff[0]?.status || 'unknown');
    const dirs = [...new Set(effective.flatMap(r => r.directories || []))];
    const license = effective.map(r => r.license).find(Boolean) || null;
    const quality = usable.length ? Math.round(effective.filter((r, i) => USABLE.has(eff[i].status)).reduce((a, r) => a + (r.quality || 0), 0) / usable.length) : null;
    const changed = effective.some(r => r.sourceChanged);
    rows.push({ op, st, sources: effective, status, age, dirs, license, quality, changed, delta: deltaVsCollector(op) });
  }
  // Bekannte Lücken im Scope
  for (const g of state.latest?.gaps || []) {
    const ags = state.scope === 'DE' ? null : state.scope;
    if (ags && muniName(ags) !== g.city) continue;
    if (state.operator !== 'all' && g.operator !== state.operator) continue;
    if (!gapFitsType(g)) continue; // gewählte Fahrzeugart: Lücke nur bei Anbietern dieser Art
    if (byOp.has(g.operator) && ags) continue;
    rows.push({ op: g.operator, st: C.emptyStats(), sources: [], status: 'gap', age: null, dirs: [], license: null, quality: null, gap: g, delta: null });
  }
  rows.sort((a, b) => b.st.available - a.st.available || a.op.localeCompare(b.op));
  return rows;
}
// Δ gegenüber letztem Sammler-Punkt (nur sinnvoll im Live-Modus, gleicher Fingerabdruck)
export function deltaVsCollector(op) {
  if (state.mode !== 'live' || !state.live || !state.latest) return null;
  const recs = sourcesForScope().filter(r => r.operator === op);
  if (!recs.length || recs.some(r => { const l = liveRec(r.id); return l && r.fingerprint && l.fingerprint && l.fingerprint !== r.fingerprint; })) return null;
  let a = 0, b = 0;
  for (const [k, st] of state.live.groups) if (keyMatchesOp(k, op)) a += st.available;
  for (const [k, st] of Object.entries(state.latest.groups)) if (keyMatchesOp(k, op)) b += st.available;
  return { diff: a - b, sinceMs: Date.now() - state.latest.at };
}
export function keyMatchesOp(k, op) { const [ags, o, ty] = k.split('|'); if (ags === 'DE') return false; if (state.scope !== 'DE' && ags !== state.scope) return false; if (o !== op) return false; if (state.type !== 'all' && ty !== state.type) return false; return true; }
