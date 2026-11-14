// Mobility Pulse — Ansicht #status (S3.2): Laufzeit des Sammlers gegen das Budget, Zeit je Phase und Verlauf der letzten 7 Tage.
// Daten: status.json v2 (lib/pulse-status.js statusDoc) und runs.json (Spalte dauer_ms). Eigenständig: renderStatus(el, ctx),
// ctx = { state, CFG, esc, fmt, getJson }. Ältere status.json ohne Phasen: nur Laufzeit und Verlauf.
import { t, dateFmt } from './i18n.js';
import { BUDGET, levelOf, runtimeTrend } from './pulse-status.js';
import { chartSpec, tableButton } from './charttip.js';

const TZ = 'Europe/Berlin';
const lvlCls = { ok: 'ok', warn: 'warn', fail: 'bad' };
const PHASE_KEYS = ['start', 'abruf', 'auswertung', 'preise-zonen', 'konsistenz', 'dubletten', 'betriebsgebiete', 'messbasis', 'obergrenzen', 'zonen-beobachtung', 'kalender-wetter', 'verkehr', 'baustellen', 'oepnv', 'verfolgung', 'abdeckung', 'ereignisse', 'sport-termine', 'streiks', 'prognose', 'training', 'kalibrierung', 'grenzen', 'gebiet', 'alarme', 'markt', 'datenvertraege', 'abschluss'];
const phaseName = (n) => (PHASE_KEYS.includes(n) ? t(`st.ph.${n}`) : n);

function tile(l, v, s, cls = '') { return `<div class="tile ${cls}"><div class="l">${l}</div><div class="v">${v}</div><div class="s">${s}</div></div>`; }

/** Zeit je Phase als liegende Balken, längste oben (Werte in Sekunden, Text in Tinte, Balken in Akzentfarbe) */
function phaseBars(ctx, phases) {
  const rows = phases.slice().sort((a, b) => b[1] - a[1]).filter(([, ms]) => ms >= 100), max = Math.max(1, ...rows.map(([, ms]) => ms));
  if (!rows.length) return `<p class="muted small">${t('st.noPhases')}</p>`;
  const W = 470, rowH = 22, lw = 150, H = rows.length * rowH + 6;
  const bars = rows.map(([n, ms], i) => { const w = Math.max(2, (W - lw - 52) * ms / max), y = i * rowH + 4;
    return `<text x="${lw - 8}" y="${y + 13}" text-anchor="end" font-size="12" fill="currentColor">${ctx.esc(phaseName(n))}</text>`
      + `<rect x="${lw}" y="${y + 3}" width="${w.toFixed(1)}" height="14" rx="3" style="fill:var(--accent)"/>`
      + `<text x="${(lw + w + 6).toFixed(1)}" y="${y + 13}" font-size="12" fill="currentColor" opacity=".8">${ctx.fmt(ms / 1000, ms < 10e3 ? 1 : 0)} s</text>`; }).join('');
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" style="display:block;max-width:${W}px" role="img" aria-label="${ctx.esc(t('st.phasesAria', { n: rows.length }))}">${bars}</svg>`;
}

/** Laufzeit je Lauf über 7 Tage als Punkte, Linien für Warn- und Fehlergrenze */
function runChart(ctx, runs) {
  if (runs.length < 2) return `<p class="muted small">${t('st.noRuns')}</p>`;
  const W = 480, H = 200, pl = 34, pr = 8, pt = 10, pb = 22, x0 = runs[0][0], x1 = runs.at(-1)[0];
  const yMax = Math.max(BUDGET.failS * 1.05, ...runs.map(r => r[1] / 1000)), X = (t0) => pl + (W - pl - pr) * (t0 - x0) / Math.max(1, x1 - x0), Y = (s) => H - pb - (H - pt - pb) * s / yMax;
  const dots = runs.map(r => { const s = r[1] / 1000, l = levelOf(r[1]); return `<circle cx="${X(r[0]).toFixed(1)}" cy="${Y(s).toFixed(1)}" r="2.2" style="fill:var(--${l === 'ok' ? 'accent' : lvlCls[l]})">/>`; }).join('');
  const line = (s, cls, label) => `<line x1="${pl}" x2="${W - pr}" y1="${Y(s).toFixed(1)}" y2="${Y(s).toFixed(1)}" style="stroke:var(--${cls})" stroke-dasharray="4 4" stroke-width="1"/><text x="${W - pr}" y="${(Y(s) - 4).toFixed(1)}" text-anchor="end" font-size="11" fill="currentColor" opacity=".75">${label}</text>`;
  const ticks = [0, 200, 400, 600].filter(v => v <= yMax).map(v => `<text x="${pl - 6}" y="${(Y(v) + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="currentColor" opacity=".6">${v}</text>`).join('');
  const days = []; for (let d = new Date(x0); d.getTime() <= x1; d.setUTCDate(d.getUTCDate() + 1)) days.push(d.getTime());
  const dl = days.map(d => `<text x="${X(d).toFixed(1)}" y="${H - 6}" text-anchor="middle" font-size="11" fill="currentColor" opacity=".6">${dateFmt({ day: '2-digit', month: '2-digit', timeZone: TZ }).format(new Date(d))}</text>`).join('');
  // S4.5: Laufzeit je Lauf im gemeinsamen Hover-Layer (web/charttip.js) statt <title> an 2-px-Punkten
  const when = dateFmt({ dateStyle: 'short', timeStyle: 'short', timeZone: TZ }), lvlColor = (r) => `var(--${levelOf(r[1]) === 'ok' ? 'accent' : lvlCls[levelOf(r[1])]})`;
  const cs = chartSpec({ n: runs.length, x: (i) => X(runs[i][0]), top: pt, bottom: H - pb, head: (i) => when.format(new Date(runs[i][0])), label: t('st.runsAria', { n: runs.length }), colHead: t('ct.timeCol'),
    cols: [t('st.runtimeCol')], cell: (i) => `${ctx.fmt(runs[i][1] / 1000)} s`, rows: (i) => [{ color: lvlColor(runs[i]), label: t('st.runtimeCol'), value: `${ctx.fmt(runs[i][1] / 1000)} s` }] });
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" style="display:block;max-width:${W}px" role="img" aria-label="${ctx.esc(t('st.runsAria', { n: runs.length }))}" ${cs.attrs}>${ticks}${dl}${line(BUDGET.warnS, 'warn', t('st.warnLine', { s: BUDGET.warnS }))}${line(BUDGET.failS, 'bad', t('st.failLine', { s: BUDGET.failS }))}${dots}</svg>${tableButton(cs.id)}`;
}

export async function renderStatus(el, ctx) {
  if (!el) return;
  const { esc, fmt } = ctx, st = ctx.state.status;
  const rr = await ctx.getJson(`${ctx.CFG.DATA}runs.json`, { timeout: 25000 }), runs = (rr?.ok && Array.isArray(rr.json?.runs) ? rr.json.runs : []).filter(r => Number.isFinite(r?.[0]) && Number.isFinite(r?.[1]));
  if (!st) { el.innerHTML = `<div class="panel"><p class="muted">${t('st.none')}</p></div>`; return; }
  const v2 = st.schemaVersion?.startsWith?.('2.'), runMs = st.runMs, lvl = st.level || levelOf(runMs), tr = st.trend || runtimeTrend(runs);
  const ageMin = Number.isFinite(st.at) ? (Date.now() - st.at) / 60e3 : null, stale = ageMin != null && ageMin > BUDGET.staleMin;
  const hhmm = Number.isFinite(st.at) ? dateFmt({ hour: '2-digit', minute: '2-digit', timeZone: TZ }).format(new Date(st.at)) : '–', day = Number.isFinite(st.at) ? dateFmt({ dateStyle: 'medium', timeZone: TZ }).format(new Date(st.at)) : '';
  const tiles = [
    tile(t('st.lastRun'), esc(hhmm), `${esc(day)}${ageMin != null ? `, ${t('st.ago', { min: fmt(ageMin) })}` : ''}${stale ? `, ${t('st.stale', { m: BUDGET.staleMin })}` : ''}`, stale ? 'bad' : ''),
    tile(t('st.runtime'), `${fmt(runMs / 1000)} s`, t(`st.lvl.${lvl || 'ok'}`, { w: BUDGET.warnS, f: BUDGET.failS }), lvlCls[lvl] || ''),
    tile(t('st.trend'), tr?.ratio != null ? `${fmt(tr.ratio, 2)}×` : '–', tr?.ratio != null ? t('st.trendSub', { r: fmt(tr.recentS), b: fmt(tr.baseS), n: BUDGET.recentRuns, d: BUDGET.baseDays }) : t('st.trendNone'), tr?.alarm ? 'warn' : ''),
    tile(t('st.sources'), fmt(st.byStatus?.live ?? 0), t('st.sourcesSub', { n: fmt(st.counts?.sources ?? 0) })),
  ].join('');
  const phases = v2 && Array.isArray(st.phases) ? st.phases : [];
  el.innerHTML = `<div class="tiles">${tiles}</div>
    ${tr?.alarm ? `<div class="note warn">${t('st.alarm', { r: fmt(tr.ratio, 2), f: fmt(BUDGET.factor, 1) })}</div>` : ''}
    <div class="grid" style="margin-top:var(--s4)">
      <div class="panel c6"><div class="panel-head"><div><h2>${t('st.phasesTitle')}</h2><div class="sub">${v2 ? t('st.phasesSub', { s: fmt(runMs / 1000) }) : t('st.oldStatus')}</div></div></div>${phaseBars(ctx, phases)}</div>
      <div class="panel c6"><div class="panel-head"><div><h2>${t('st.runsTitle')}</h2><div class="sub">${t('st.runsSub', { n: fmt(runs.length), w: BUDGET.warnS, f: BUDGET.failS })}</div></div></div>${runChart(ctx, runs)}</div>
    </div>
    <p class="muted small">${t('st.how', { w: BUDGET.warnS, f: BUDGET.failS, n: BUDGET.recentRuns, d: BUDGET.baseDays, x: fmt(BUDGET.factor, 1), m: BUDGET.staleMin })}</p>`;
}
