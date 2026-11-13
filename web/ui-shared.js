// Mobility Pulse — Bausteine, die Start, Disposition und Bericht teilen (S3.4): Messbasis-Abzeichen (mb*), Kalibrierungs-Beschriftung.
// Lagen bis 13.11.2026 in web/report.js; ausgelagert, damit Übersicht und Disposition report.js (≈ 65 KB gzip) nicht mitladen.
import * as R from './pulse-report.js';
import { t, fmtLocale } from './i18n.js';
import { maturity as mbMaturity, measureBase as mbMeasureBase, measureDay as mbMeasureDay, dayType as mbDayType, DAY_TYPES as MB_TYPES } from './pulse-econ.js';

export const CALIB_DAYS = 14;
export const SUSPENDED_TXT = R.SUSPENDED;
// Kurzbeschreibung des Faktors für Notizen und CSV, z. B. „Berlin Q4/2025 · vorläufig“
export const calibLabel = (k) => (k?.applied ? t('rep.berlin', { quarter: k.quarter, v1: k.prelim ? ` · ${t('rep.preliminary')}` : '' }) : '');
export const mbEsc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const mbNum = (v, d = 0) => (v == null || !Number.isFinite(+v) ? '–' : new Intl.NumberFormat(fmtLocale(), { maximumFractionDigits: d, minimumFractionDigits: d }).format(v));
export const mbPct = (v) => (v == null ? '–' : `${mbNum(v * 100, 0)} %`);
export const mbTypeName = (k) => t(`mb.type${k}`);
/**
 * Messbasis für Abzeichen und Matrix (lib/pulse-econ.js measureBase): latest.json → measure.days (Sammler), bei älterem Datenstand aus den
 * schon geladenen Tagesdateien (state.usage.docs). land: Land des Gebiets (null = Deutschland), days: nur diese Tage, rule: Regelstand.
 */
export function mbBase(state, { land = null, days = null, rule = undefined } = {}) {
  let md = state?.latest?.measure?.version >= 1 ? state.latest.measure.days || {} : null;
  if (!md) { md = {}; for (const d of Object.values(state?.usage?.docs || {})) if (d?.day) md[d.day] = mbMeasureDay(d); }
  if (days) { const keep = new Set(days); md = Object.fromEntries(Object.entries(md).filter(([d]) => keep.has(d))); }
  return mbMeasureBase(md, { land, calendar: state?.calendar || null, ...(rule !== undefined ? { rule } : {}) });
}
/** Häufigster Tagtyp einer Tagesliste (Gleichstand: W vor F, S, H) */
export function mbMainType(days, land = null, calendar = null) {
  const n = {}; for (const d of days || []) { const k = mbDayType(d, land, calendar); if (k) n[k] = (n[k] || 0) + 1; }
  return MB_TYPES.reduce((a, k) => ((n[k] || 0) > (n[a] || 0) ? k : a), 'W');
}
/**
 * Abzeichen an einer Kennzahl mit Rate oder Trend: Stufe als Zeichen und Wort (nicht nur Farbe), „Basis x h · Tagtypen W/S/H · Regelstand v“;
 * der vollständige Satz steht für Screenreader im Text und als Tooltip. need: 'full3' | 'weeks2' | 'weeks4' (lib/pulse-econ.js MATURITY).
 */
export function mbBadge(base, need = 'full3', { dayType = null, curve = null } = {}) {
  if (!base) return '';
  const m = mbMaturity(base, need, { dayType });
  const stage = m.met ? t('mb.met') : t('mb.prelim');
  const types = base.types.length ? base.types.join('/') : '–', rule = base.rule || '–';
  const needTxt = m.want ? t(`mb.need.${need}`, { want: m.want, have: m.have, type: m.dayType ? mbTypeName(m.dayType) : '' }) : t('mb.need.now');
  const byType = base.types.map(k => `${mbTypeName(k)} ${mbNum(base.byType[k], 1)} h`).join(', ') || '–';
  const full = t('mb.aria', { stage, need: needTxt, h: mbNum(base.hours, 1), byType, rule }) + (curve ? ` ${curve}` : '');
  return `<span class="mb-badge ${m.met ? 'mb-ok' : 'mb-wait'}" title="${mbEsc(full)}"><span aria-hidden="true"><span class="mb-ico"></span><b>${stage}</b>${m.met ? '' : ` ${m.have}/${m.want}`}<span class="mb-meta"> · ${t('mb.base', { h: mbNum(base.hours, 1) })} · ${t('mb.types', { v: types })} · ${t('mb.rule', { v: mbEsc(rule) })}</span></span><span class="vh">${mbEsc(full)}</span></span>`;
}
/** Abzeichen in die Unterzeile einer Kachel (HTML aus tile()) bzw. aller Kacheln eines Containers setzen */
export const mbInTile = (html, badge) => (badge ? String(html).replace(/<\/div><\/div>\s*$/, `<div class="mb-line">${badge}</div></div></div>`) : html);
export function mbTiles(box, badge) { if (!box || !badge) return; for (const s of box.querySelectorAll('.tile .s')) s.insertAdjacentHTML('beforeend', `<div class="mb-line">${badge}</div>`); }
/** Regelstände eines Tags (eventChecks.dayRules, "" = ohne Angabe) als Text */
export const mbRules = (rs) => (Array.isArray(rs) && rs.length ? rs.map(r => r || t('mb.ck.noRule')).join(' + ') : t('mb.ck.noRule'));
/** Befunde der Ampel einer Gruppe als Text (latest.json → eventChecks.groups[k].checks) */
export function mbChecksText(c) {
  if (!c) return '';
  const T0 = { pickup: () => t('mb.ck.pickup', { share: mbPct(c.pickupShare), r: mbNum(c.r, 2) }), se: () => t('mb.ck.se', { v: mbNum(c.se, 2) }), swap0: () => t('mb.ck.swap0', { rides: mbNum(c.rides) }),
    hide: () => t('mb.ck.hide', { share: mbPct(c.hideShare) }), idle: () => t('mb.ck.idle', { share: mbPct(c.idleUnusable) }), batteryFloor: () => t('mb.ck.floor', { v: mbNum(c.batteryFloor) }),
    oldRule: () => t('mb.ck.oldRule', { rule: mbRules(c.oldRule) }), relHigh: () => t('mb.ck.relHigh', { f: mbNum(c.relHigh, 1), m: mbNum(c.relMedian, 2) }),
    relocTrips: () => t('mb.ck.relocTrips', { share: mbPct(c.relocShare), r: mbNum(c.relocR, 2) }), modeFlip: () => t('mb.ck.modeFlip', { n: mbNum(c.modeChanges) }),
    cityDev: () => t('mb.ck.cityDev', { f: mbNum(c.cityDev, 2), m: mbNum(c.cityMedian, 2) }) }; // rot nach älterem bzw. gemischtem Regelstand (lib/pulse-econ.js eventChecks ruleNow)
  return (c.flags || []).map(f => (T0[f] ? T0[f]() : f)).join(' · ');
}
export const mbLevel = (lv) => (lv === 'bad' ? `<span class="rp-status over"><i aria-hidden="true">✕</i>${t('mb.red')}</span>` : lv === 'warn' ? `<span class="rp-status near"><i aria-hidden="true">!</i>${t('mb.yellow')}</span>` : `<span class="rp-status ok"><i aria-hidden="true">✓</i>${t('mb.green')}</span>`);
