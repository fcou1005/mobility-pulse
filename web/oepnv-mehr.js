// @ts-check
// Mobility Pulse — Reiter ÖPNV, weitere Tafeln: Linien nach Zuverlässigkeit und Tagesgang ÖPNV gegen Sharing (Nachtnetz-Lücke).
// Daten: oepnv/<AGS>.json (lines, profile; seit Format 1.1), Störungskorrektur aus forecast/dispo.json. Texte unter pt.* (Bereich oepnv).
import { t, dateFmt } from './i18n.js';
import { modeTxt as artTxt } from './oepnv-karte.js';
import * as TF from './pulse-oepnv-tafel.js';
import { chartSpec, tableButton } from './charttip.js';

const csvNum = (/** @type {number | null} */ x, d = 1) => (x == null ? '' : (+x).toFixed(d).replace('.', ','));
const pct = (/** @type {any} */ ctx, /** @type {number | null} */ x, d = 1) => (x == null || !Number.isFinite(x) ? '–' : `${ctx.fmt(x * 100, d)} %`);

/** Jetzt gestört: Stationen mit Ausfällen und Verspätungen in den letzten Stunden und die Sharing-Fahrzeuge im Umkreis von 300 m */
/** @param {any} ctx @param {any} doc @param {string} name @param {any[]} hints @param {any} mine @param {any} [corr] Störungskorrektur der Prognose (lib/pulse-ops-extern.js ptCorrectionOf) */
export function nowPanel(ctx, doc, name, hints, mine, corr = null) {
  const J = doc?.jetzt, f = ctx.fmt; if (!doc || !J) return '';
  const none = hints.filter(x => x.level === 'none').length, few = hints.filter(x => x.level === 'few').length, known = hints.some(x => x.vehicles != null);
  const lvl = (/** @type {any} */ x) => (x.level === 'out' ? `· ${t('pt.nowOut')}` : x.level === 'none' ? `▲ ${t('pt.nowNone')}` : x.level === 'few' ? `▲ ${t('pt.nowFew', { n: f(x.vehicles) })}` : x.level === 'ok' ? `○ ${t('pt.nowOk', { n: f(x.vehicles) })}` : '–');
  const eff = mine && (mine.verdict === 'mehr' || mine.verdict === 'weniger') ? t(mine.verdict === 'mehr' ? 'pt.nowEffMore' : 'pt.nowEffLess', { name, e: `${f(Math.abs(mine.effect) * 100, 1)} %` }) : t('pt.nowEffOpen', { name });
  // Prognose: Störungskorrektur für diese Stadt (läuft mit, wirkt nach Freigabe – Prognose › Grundlagen › Korrekturen)
  const g = corr?.gate, sgn = (/** @type {number} */ x, d = 1) => `${x >= 0 ? '+' : '−'}${f(Math.abs(x), d)}`;
  const fcTxt = corr && corr.share != null ? `<p id="pt-now-fc">${t('pt.nowFc', { name, p: `<b>${sgn(corr.share * 100)} %</b>`, h: f(corr.hours), ex: sgn(corr.extra, 0) })} ${corr.on ? t('pt.nowFcOn', { d: g?.since ? dateFmt({ day: 'numeric', month: 'numeric' }).format(new Date(g.since)) : '–' })
    : g?.why === 'learning' ? t('pt.nowFcLearn', { until: corr.learnUntil ? dateFmt({ day: 'numeric', month: 'numeric', timeZone: 'UTC' }).format(new Date(`${corr.learnUntil}T12:00:00Z`)) : '–' }) : t('pt.nowFcProbe', { n: f(g?.n ?? 0), min: f(g?.need?.minN ?? 7) })} <a href="#prognose-basis">${t('pt.nowFcMore')}</a></p>` : '';
  return `<div class="panel" id="pt-now-panel"><div class="panel-head"><div><h2>${t('pt.nowTitle')}</h2><div class="sub">${t('pt.nowSub', { h: f(J.windowH) })}</div></div>
    <div class="panel-actions"><button class="chip" type="button" id="pt-now-csv"${hints.length ? '' : ' disabled'}>${t('pt.csv')}</button></div></div>
    ${hints.length ? `<p>${t('pt.nowLead', { n: `<b>${f(hints.length)}</b>`, name, h: f(J.windowH) })} ${known ? t('pt.nowLeadVeh', { none: `<b>${f(none)}</b>`, few: f(few) }) : t('pt.nowLeadNoFleet')} ${eff}</p>${fcTxt}
    <div class="tbl" tabindex="0" role="region" aria-label="${ctx.esc(t('pt.nowTitle'))}"><table id="pt-now"><thead><tr><th>${t('pt.colStation')}</th><th class="n">${t('pt.colStops')}</th><th class="n">${t('pt.colSkip')}</th><th class="n">${t('pt.colLate')}</th><th>${t('pt.colNear')}</th></tr></thead><tbody>
    ${hints.slice(0, 15).map(x => `<tr><td><a href="https://www.openstreetmap.org/?mlat=${x.lat.toFixed(5)}&mlon=${x.lon.toFixed(5)}#map=17/${x.lat.toFixed(5)}/${x.lon.toFixed(5)}" target="_blank" rel="noopener">${ctx.esc(x.name)}</a></td><td class="n">${f(x.n)}</td><td class="n">${pct(ctx, x.skip / x.n, 0)}</td><td class="n">${pct(ctx, x.late / x.n, 0)}</td><td>${lvl(x)}</td></tr>`).join('')}</tbody></table></div>
    <p class="muted small">${t('pt.nowNote', { min: f(J.minN || 8) })}</p>` : `<p>${t('pt.nowCalm', { name, h: f(J.windowH) })}</p>`}</div>`;
}
/** Letzte Meile: Einwohner fern vom ÖPNV und ob dort tagsüber ein Sharing-Fahrzeug steht (versorgung/<AGS>.json letzteMeile, Phase geo) */
/** @param {any} ctx @param {any} ver @param {string} name */
export function lastMilePanel(ctx, ver, name) {
  const M = ver?.letzteMeile, f = ctx.fmt; if (!ver) return '';
  if (!M || !M.runs) return `<div class="panel" id="pt-lm-panel"><div class="panel-head"><div><h2>${t('pt.lmTitle')}</h2></div></div><div class="empty">${t('pt.lmEmpty', { name })}</div></div>`;
  const rows = (M.cells?.rows || []).filter((/** @type {any[]} */ r) => r[1] * (1 - (r[2] ?? 0)) >= 1).slice(0, 15);
  // Mittelpunkt der Zelle: Schlüssel = gerundete Breite ÷ 0,0025 : Länge ÷ 0,0035 (lib/pulse-track-rules.js cellCenter)
  const mid = (/** @type {string} */ c) => { const [a, b] = c.split(':').map(Number); return [a * 0.0025, b * 0.0035]; };
  return `<div class="panel" id="pt-lm-panel"><div class="panel-head"><div><h2>${t('pt.lmTitle')}</h2><div class="sub">${t('pt.lmSub', { stop: f(M.stopM), dep: f(M.minDep), veh: f(M.vehM) })}</div></div>
    <div class="panel-actions"><button class="chip" type="button" id="pt-lm-csv"${rows.length ? '' : ' disabled'}>${t('pt.csv')}</button></div></div>
    <p>${t('pt.lmLead', { name, far: `<b>${f(M.farPop)}</b>`, p: pct(ctx, M.farShare), stop: f(M.stopM), served: pct(ctx, M.servedShare, 0), veh: f(M.vehM), gap: `<b>${f(M.gapPop)}</b>` })}</p>
    ${rows.length ? `<div class="tbl" tabindex="0" role="region" aria-label="${ctx.esc(t('pt.lmTitle'))}"><table id="pt-lm"><thead><tr><th>${t('pt.colCell')}</th><th class="n">${t('pt.colFar')}</th><th class="n">${t('pt.colWithVeh')}</th><th class="n">${t('pt.colGap')}</th></tr></thead><tbody>
    ${rows.map((/** @type {any[]} */ r) => { const [la, lo] = mid(r[0]); return `<tr><td><a href="https://www.openstreetmap.org/?mlat=${la.toFixed(5)}&mlon=${lo.toFixed(5)}#map=16/${la.toFixed(5)}/${lo.toFixed(5)}" target="_blank" rel="noopener">${la.toFixed(4).replace('.', ',')} N, ${lo.toFixed(4).replace('.', ',')} O</a></td><td class="n">${f(r[1])}</td><td class="n">${pct(ctx, r[2], 0)}</td><td class="n">${f(Math.round(r[1] * (1 - (r[2] ?? 0))))}</td></tr>`; }).join('')}</tbody></table></div>` : ''}
    <p class="muted small">${t('pt.lmNote', { runs: f(M.runs) })}</p></div>`;
}
/** Linien mit dem höchsten Anteil ausgefallener oder verspäteter Halte (ab 40 Halten in der Summe) */
/** @param {any} ctx @param {any} doc @param {number} days */
export function linesPanel(ctx, doc, days) {
  const R = doc?.lines?.rows || [], f = ctx.fmt; if (!doc) return '';
  const worst = R.filter((/** @type {any[]} */ r) => r[2] >= 40).map((/** @type {any[]} */ r) => ({ r, q: (r[3] + r[4]) / r[2] })).sort((/** @type {any} */ a, /** @type {any} */ b) => b.q - a.q || b.r[2] - a.r[2]).slice(0, 15);
  return `<div class="panel" id="pt-lines-panel"><div class="panel-head"><div><h2>${t('pt.lnTitle')}</h2><div class="sub">${t('pt.lnSub', { n: f(R.length), days: f(days, 1) })}</div></div>
    <div class="panel-actions"><button class="chip" type="button" id="pt-ln-csv"${R.length ? '' : ' disabled'}>${t('pt.csv')}</button></div></div>
    ${worst.length ? `<div class="tbl" tabindex="0" role="region" aria-label="${ctx.esc(t('pt.lnTitle'))}"><table id="pt-lines"><thead><tr><th>${t('pt.colLine')}</th><th>${t('pt.colArt')}</th><th class="n">${t('pt.colPerDay')}</th><th class="n">${t('pt.colSkip')}</th><th class="n">${t('pt.colLate')}</th><th class="n">${t('pt.colDelay')}</th></tr></thead><tbody>
    ${worst.map((/** @type {any} */ { r }) => `<tr><td>${ctx.esc(r[0])}</td><td>${artTxt(r[1])}</td><td class="n">${f(r[2] / days)}</td><td class="n">${pct(ctx, r[3] / r[2])}</td><td class="n">${pct(ctx, r[4] / r[2])}</td><td class="n">${r[5] == null ? '–' : f(r[5], 1)}</td></tr>`).join('')}</tbody></table></div>
    <p class="muted small">${t('pt.lnNote')}</p>` : `<div class="empty">${R.length ? t('pt.lnFew') : t('pt.lnEmpty')}</div>`}</div>`;
}
/** Tagesgang: Stunden, in denen der ÖPNV kaum fährt und Sharing genutzt wird */
/** @param {any} ctx @param {any} doc @param {string} name */
export function profilePanel(ctx, doc, name) {
  const P = doc?.profile, f = ctx.fmt; if (!doc) return '';
  if (!P) return `<div class="panel" id="pt-profile-panel"><div class="panel-head"><div><h2>${t('pt.pfTitle')}</h2></div></div><div class="empty">${t('pt.pfEmpty', { name })}</div></div>`;
  const tot = P.sharing.reduce((/** @type {number} */ s, /** @type {number} */ x) => s + x, 0), gapSum = P.gap.reduce((/** @type {number} */ s, /** @type {number} */ h) => s + P.sharing[h], 0), peak = Math.max(...P.pt), peakS = Math.max(...P.sharing, 1);
  // zusammenhängende Stunden als Spannen (23 und 0 Uhr gehören zusammen)
  const spans = []; for (const h of P.gap) { const l = spans[spans.length - 1]; if (l && l[1] === h) l[1] = h + 1; else spans.push([h, h + 1]); }
  if (spans.length > 1 && spans[0][0] === 0 && spans[spans.length - 1][1] === 24) { spans[0][0] = spans.pop()[0]; }
  const spanTxt = spans.map(([a, b]) => t('pt.pfSpan', { a, b: b % 24 })).join(', ');
  const bar = (/** @type {number} */ x, /** @type {number} */ max, /** @type {string} */ c) => `<span class="pt-bar-cell"><i style="width:${Math.round(100 * x / (max || 1))}%;background:${c}"></i></span>`;
  return `<div class="panel" id="pt-profile-panel"><div class="panel-head"><div><h2>${t('pt.pfTitle')}</h2><div class="sub">${t('pt.pfSub', { days: f(P.days) })}</div></div></div>
    <p>${P.gap.length ? t('pt.pfGap', { name, spans: spanTxt, share: pct(ctx, P.gapShare, 0), n: `<b>${f(gapSum, 0)}</b>`, p: pct(ctx, tot ? gapSum / tot : null) }) : t('pt.pfNoGap', { name, share: pct(ctx, P.gapShare, 0), min: f(P.minSharing) })}</p>
    <div class="tbl" tabindex="0" role="region" aria-label="${ctx.esc(t('pt.pfTitle'))}"><table id="pt-profile"><thead><tr><th>${t('pt.colHour')}</th><th class="n">${t('pt.colPtStops')}</th><th aria-hidden="true"></th><th class="n">${t('pt.colShareStarts')}</th><th aria-hidden="true"></th><th>${t('pt.colState')}</th></tr></thead><tbody>
    ${P.pt.map((/** @type {number} */ n, /** @type {number} */ h) => `<tr><td>${h}–${h + 1} h</td><td class="n">${f(n)}</td><td aria-hidden="true">${bar(n, peak, 'var(--muted)')}</td><td class="n">${f(P.sharing[h], 1)}</td><td aria-hidden="true">${bar(P.sharing[h], peakS, 'var(--accent)')}</td><td>${P.gap.includes(h) ? `▲ ${t('pt.pfIsGap')}` : ''}</td></tr>`).join('')}</tbody></table></div>
    <p class="muted small">${t('pt.pfNote', { share: pct(ctx, P.gapShare, 0), min: f(P.minSharing) })}</p></div>`;
}
/** @param {HTMLElement} el @param {any} doc @param {string} ags @param {number} days @param {(name: string, text: string) => void} download @param {any[]} [hints] @param {any} [ver] */
export function bindMehr(el, doc, ags, days, download, hints = /** @type {any[]} */ ([]), ver = /** @type {any} */ (null)) {
  el.querySelector('#pt-lm-csv')?.addEventListener('click', () => download(`letzte_meile_${ags}.csv`, ['zelle;einwohner_fern_vom_oepnv;anteil_mit_fahrzeug;einwohner_ohne_beides', ...(ver?.letzteMeile?.cells?.rows || []).map((/** @type {any[]} */ r) => [r[0], r[1], csvNum(r[2], 3), Math.round(r[1] * (1 - (r[2] ?? 0)))].join(';'))].join('\n') + '\n'));
  el.querySelector('#pt-now-csv')?.addEventListener('click', () => download(`oepnv_jetzt_gestoert_${ags}.csv`, ['station;name;lat;lon;halte;ausgefallen;verspaetet;sharing_fahrzeuge_300m', ...hints.map(x => [x.id, `"${String(x.name).replace(/"/g, '""')}"`, csvNum(x.lat, 5), csvNum(x.lon, 5), x.n, x.skip, x.late, x.vehicles ?? ''].join(';'))].join('\n') + '\n'));
  el.querySelector('#pt-ln-csv')?.addEventListener('click', () => download(`oepnv_linien_${ags}.csv`, ['linie;art;halte_je_tag;ausgefallen_anteil;verspaetet_anteil;verspaetung_min', ...(doc?.lines?.rows || []).map((/** @type {any[]} */ r) => [`"${String(r[0]).replace(/"/g, '""')}"`, r[1], csvNum(r[2] / days), csvNum(r[3] / r[2], 3), csvNum(r[4] / r[2], 3), csvNum(r[5])].join(';'))].join('\n') + '\n'));
}

/** Sharing-Fahrzeuge direkt an Haltestellen (F30): Stationen der Gemeinde (Tabelle + Live-Datei) gegen den verfügbaren Bestand */
/** @param {any} ctx @param {any} doc @param {any} live @param {any[]|null} fleet @param {string} name */
export function atStopsPanel(ctx, doc, live, fleet, name) {
  if (!fleet) return '';
  const F = doc?.fields || [], iN = F.indexOf('name'), iA = F.indexOf('lat'), iO = F.indexOf('lon');
  const st = [...(doc?.rows || []).map((/** @type {any[]} */ r) => ({ name: r[iN], lat: r[iA], lon: r[iO] })), ...TF.searchIndex(live).stations];
  const R = TF.atStops(st, fleet), f = (/** @type {number} */ x) => ctx.fmt(x);
  const body = R.rows.length ? `<div class="tbl" tabindex="0" role="region" aria-label="${ctx.esc(t('pt.asTitle', { name }))}"><table><thead><tr><th>${t('pt.colStation')}</th><th class="n">${t('pt.asColN')}</th><th>${t('pt.asColOps')}</th><th>${t('pt.colMap')}</th></tr></thead><tbody>
    ${R.rows.map(r => `<tr><td>${ctx.esc(r.name)}</td><td class="n">${f(r.n)}</td><td>${Object.entries(r.ops).sort((a, b) => b[1] - a[1]).map(([o, n]) => `${ctx.esc(o)} ${f(n)}`).join(', ')}</td><td><a href="https://www.openstreetmap.org/?mlat=${r.lat}&amp;mlon=${r.lon}#map=19/${r.lat}/${r.lon}" target="_blank" rel="noopener">OSM ↗</a></td></tr>`).join('')}</tbody></table></div>`
    : `<div class="empty">${t('pt.asNone', { name })}</div>`;
  return `<div class="panel" id="pt-atstops"><div class="panel-head"><div><h2>${t('pt.asTitle', { name })}</h2><div class="sub">${t('pt.asSub')}</div></div></div>
    ${R.rows.length ? `<p>${t('pt.asLead', { n: `<b>${f(R.total)}</b>`, s: f(R.stations) })}</p>` : ''}${body}<p class="muted small">${t('pt.asNote')}</p></div>`;
}

/** Verspätungsprognose (F28): wie gut sie war (letzte Tage, gegen „wie gestern“), was sie erwartet (nächste 24 Stunden), Linien, Einfluss auf die Sharing-Prognose */
/** @param {any} ctx @param {any} doc @param {string} name @param {any} [fcDoc] forecast/dispo.json (Einfluss ptRisk) */
export function progPanel(ctx, doc, name, fcDoc = null) {
  const P = doc?.prognose; if (!P?.next?.length) return '';
  const pc = (/** @type {number} */ x, d = 1) => `${ctx.fmt(Math.round(x * 100 * 10 ** d) / 10 ** d, d)} %`, pp = (/** @type {number} */ x) => ctx.fmt(Math.round(x * 1000) / 10, 1), f = (/** @type {number} */ x) => ctx.fmt(x);
  const a3 = P.next.slice(0, 3), mL = a3.reduce((/** @type {number} */ s, /** @type {any[]} */ x) => s + x[2], 0) / a3.length, mS = a3.reduce((/** @type {number} */ s, /** @type {any[]} */ x) => s + x[3], 0) / a3.length, max = Math.max(0.01, ...P.next.map((/** @type {any[]} */ x) => x[2] + x[3]));
  const E = P.eval, gain = E && E.maeNaive > 0 ? 1 - E.mae / E.maeNaive : null;
  const verdict = E ? t(E.better ? 'pt.pgVerdict' : 'pt.pgVerdictWorse', { m: pp(E.mae), n: pp(E.maeNaive), g: ctx.fmt(Math.round(Math.abs(gain ?? 0) * 100)), d: f(E.days), s: E.maeSkip != null ? pp(E.maeSkip) : '–', sn: E.maeSkipNaive != null ? pp(E.maeSkipNaive) : '–' }) : t('pt.pgEvalNone');
  const hours = P.next.slice(0, 12).map((/** @type {any[]} */ x) => `<tr><td>${x[1]}–${x[1] + 1} h</td><td class="n bars"><span class="t">${pc(x[2])}</span><span class="fv-bar" style="width:${Math.round(x[2] / max * 110)}px"></span></td><td class="n">${pc(x[3])}</td><td class="n">${f(x[4])}</td></tr>`).join('');
  const lines = (P.lines || []).map((/** @type {any[]} */ l) => `<tr><td>${ctx.esc(l[0])}</td><td>${artTxt(l[1])}</td><td class="n">${pc(l[2], 0)}</td><td class="n">${pc(l[3], 0)}</td></tr>`).join('');
  const days = (E?.byDay || []).map((/** @type {any[]} */ r) => { const mx = Math.max(0.001, ...(E.byDay || []).map((/** @type {any[]} */ x) => Math.max(x[1], x[2]))); return `<tr><td>${dateFmt({ weekday: 'short', day: 'numeric', month: 'numeric', timeZone: 'UTC' }).format(new Date(`${r[0]}T12:00:00Z`))}</td><td class="n bars"><span class="t">${pp(r[1])}</span><span class="fv-bar" style="width:${Math.round(r[1] / mx * 90)}px"></span></td><td class="n bars"><span class="t">${pp(r[2])}</span><span class="fv-bar" style="width:${Math.round(r[2] / mx * 90)}px;opacity:.45"></span></td></tr>`; }).join('');
  // Einfluss auf die Sharing-Prognose (Merkmal ptRisk): Stand und gelernte Wirkung aus forecast/latest.json
  // Stand wie in der Einflüsse-Tabelle der Prognose, aus forecast/dispo.json ptRisk (seit Format 1.9; vorher fehlte er dort und der Absatz blieb auf „neu“)
  const R = fcDoc?.ptRisk, inflKey = !R ? 'pt.pgInflNew' : R.state === 'on' ? 'pt.pgInflOn' : 'pt.pgInflOff';
  const infl = t(inflKey, { f: R?.b != null ? ctx.fmt(Math.round(Math.exp(R.b) * 100) / 100, 2) : '–', n: R?.n != null ? f(R.n) : '–' });
  return `<div class="panel" id="pt-prog"><div class="panel-head"><div><h2>${t('pt.pgTitle', { name })}</h2><div class="sub">${t('pt.pgSub')}</div></div></div>
    <p><b>${verdict}</b></p>${progChart(ctx, P, doc.hours)}
    <p>${t('pt.pgLead', { l: `<b>${pc(mL)}</b>`, s: `<b>${pc(mS)}</b>`, ml: pc(P.mean?.late || 0), ms: pc(P.mean?.skip || 0) })}</p>
    <p class="pt-infl">${infl}${document.body.classList.contains('mode-client') ? '' : ` <a href="#prognose-basis">${t('pt.pgInflLink')}</a>`}</p>
    ${days ? `<details><summary>${t('pt.pgDaysToggle')}</summary><div class="tbl" tabindex="0" role="region" aria-label="${ctx.esc(t('pt.pgDaysToggle'))}"><table><thead><tr><th>${t('pt.colDay')}</th><th class="n">${t('pt.pgColModel')}</th><th class="n">${t('pt.pgColNaive')}</th></tr></thead><tbody>${days}</tbody></table></div></details>` : ''}
    <details><summary>${t('pt.pgHoursToggle')}</summary><div class="tbl" tabindex="0" role="region" aria-label="${ctx.esc(t('pt.pgTitle', { name }))}"><table><thead><tr><th>${t('pt.colHour')}</th><th class="n">${t('pt.pgColLate')}</th><th class="n">${t('pt.pgColSkip')}</th><th class="n">${t('pt.pgColN')}</th></tr></thead><tbody>${hours}</tbody></table></div></details>
    ${lines ? `<h3>${t('pt.pgLines')}</h3><div class="tbl" tabindex="0" role="region" aria-label="${ctx.esc(t('pt.pgLines'))}"><table><thead><tr><th>${t('pt.colLine')}</th><th>${t('pt.pgColArt')}</th><th class="n">${t('pt.pgColLate')}</th><th class="n">${t('pt.pgColSkip')}</th></tr></thead><tbody>${lines}</tbody></table></div>` : ''}
    <p class="muted small">${t('pt.pgNote')}</p></div>`;
}
/** Diagramm: verspätete Halte der letzten geprüften Tage (Ist, Prognose, „wie gestern“) und die Prognose der nächsten 24 Stunden */
// Stunden mit weniger Halten zählen nicht (wie PTP.minN in lib/pulse-oepnv-prog.js)
const PG_MIN_N = 100;
/** @param {any} ctx @param {any} P doc.prognose @param {any} [Hrs] doc.hours (heute bisher: tatsächlicher Anteil) */
function progChart(ctx, P, Hrs) {
  const tOf = (/** @type {string} */ d, /** @type {number} */ h) => Date.parse(`${d}T00:00:00Z`) / 3600e3 + h;
  const past = (P.eval?.series || []).map((/** @type {any[]} */ r) => ({ t: tOf(r[0], r[1]), d: r[0], h: r[1], p: r[2], a: r[3], n: r[4], fut: false }));
  const fut = P.next.map((/** @type {any[]} */ r) => ({ t: tOf(r[0], r[1]), d: r[0], h: r[1], p: r[2], a: null, n: null, fut: true }));
  // heute bis zur letzten vollen Stunde: tatsächlicher Anteil aus doc.hours (noch ohne Prüfung, daher ohne Prognose und „wie gestern“)
  const seen = new Set(past.map((/** @type {any} */ q) => q.t)), tNow = fut[0] ? fut[0].t - 1 : Infinity, today = [];
  (Hrs?.days || []).forEach((/** @type {string} */ d, /** @type {number} */ i) => { for (let h = 0; h < 24; h++) { const tt = tOf(d, h), n = Hrs.n?.[i]?.[h]; if (tt < tNow && !seen.has(tt) && (past.length ? tt > past[past.length - 1].t : true) && n >= PG_MIN_N) today.push({ t: tt, d, h, p: null, a: Math.round(Hrs.late[i][h] / n * 1e4) / 1e4, n: null, fut: false }); } });
  const pts = [...past, ...today, ...fut].sort((a, b) => a.t - b.t); if (pts.length < 6) return '';
  // Breite wie der Platz auf dem Bildschirm (wie web/forecast-parts.js), damit die Schrift nicht mitschrumpft
  const W = Math.max(300, Math.min(980, Math.round((document.getElementById('view-oepnv')?.clientWidth || window.innerWidth || 800) - 40))), H = 230, Pd = { l: 40, r: 10, t: 12, b: 28 }, t0 = pts[0].t, t1 = pts[pts.length - 1].t, ymax = Math.max(0.05, ...pts.map(x => Math.max(x.p ?? 0, x.a ?? 0, x.n ?? 0))) * 1.1;
  const x = (/** @type {number} */ tt) => Pd.l + (tt - t0) / Math.max(1, t1 - t0) * (W - Pd.l - Pd.r), y = (/** @type {number} */ v) => H - Pd.b - v / ymax * (H - Pd.t - Pd.b);
  const path = (/** @type {(p: any) => number | null} */ val, /** @type {string} */ attrs) => { let d = '', prev = null; for (const q of pts) { const v = val(q); if (v == null) { prev = null; continue; } d += `${prev != null && q.t - prev === 1 ? 'L' : 'M'}${x(q.t).toFixed(1)},${y(v).toFixed(1)}`; prev = q.t; } return d ? `<path d="${d}" fill="none" ${attrs}/>` : ''; };
  const step = ymax > 0.4 ? 0.1 : ymax > 0.2 ? 0.05 : 0.02; let g = '';
  for (let v = 0; v <= ymax + 1e-9; v += step) g += `<line class="grid" x1="${Pd.l}" x2="${W - Pd.r}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/><text x="${Pd.l - 4}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end">${ctx.fmt(Math.round(v * 100))} %</text>`;
  for (let m = Math.ceil(t0 / 24) * 24 - 24; m <= t1; m += 24) { const d = new Date(m * 3600e3).toISOString().slice(0, 10), mt = tOf(d, 0), xx = Math.max(Pd.l, x(mt)); if (mt + 6 > t1 || mt + 18 < t0 || !pts.some(q => q.d === d)) continue; g += `${mt >= t0 ? `<line class="grid" x1="${xx.toFixed(1)}" x2="${xx.toFixed(1)}" y1="${Pd.t}" y2="${H - Pd.b}"/>` : ''}<text x="${(xx + 3).toFixed(1)}" y="${H - 8}">${dateFmt(W < 560 ? { day: 'numeric', month: 'numeric', timeZone: 'UTC' } : { weekday: 'short', day: 'numeric', month: 'numeric', timeZone: 'UTC' }).format(new Date(`${d}T12:00:00Z`))}</text>`; }
  const f0 = fut[0], now = f0 ? `<rect x="${x(f0.t).toFixed(1)}" y="${Pd.t}" width="${(W - Pd.r - x(f0.t)).toFixed(1)}" height="${H - Pd.t - Pd.b}" fill="color-mix(in srgb,var(--accent) 7%,transparent)"/><text x="${(x(f0.t) + 4).toFixed(1)}" y="${Pd.t + 11}">${t('pt.pgAhead')}</text>` : '';
  const sp = chartSpec({ n: pts.length, x: (i) => x(pts[i].t), top: Pd.t, bottom: H - Pd.b, head: (i) => `${dateFmt({ weekday: 'short', day: 'numeric', month: 'numeric', timeZone: 'UTC' }).format(new Date(`${pts[i].d}T12:00:00Z`))}, ${pts[i].h}–${pts[i].h + 1} h`,
    label: t('pt.pgChartAria'), colHead: t('pt.colHour'), cols: [t('pt.pgIst'), t('pt.pgFc'), t('pt.pgNaive')],
    cell: (i, k) => { const v = [pts[i].a, pts[i].p, pts[i].n][k]; return v == null ? '–' : `${ctx.fmt(Math.round(v * 1000) / 10, 1)} %`; },
    rows: (i) => [[pts[i].a, 'var(--fg)', 'pt.pgIst'], [pts[i].p, 'var(--accent)', 'pt.pgFc'], [pts[i].n, 'var(--muted)', 'pt.pgNaive']].filter(([v]) => v != null).map(([v, c, k]) => ({ color: c, label: t(k), value: `${ctx.fmt(Math.round(v * 1000) / 10, 1)} %`, sort: v })) });
  const svg = `<svg class="chart" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" ${sp.attrs} aria-label="${ctx.esc(t('pt.pgChartAria'))}" style="width:100%;height:auto">${g}${now}${path(q => q.n, 'stroke="var(--muted)" stroke-width="1.5" stroke-dasharray="2 3"')}${path(q => q.a, 'stroke="var(--fg)" stroke-width="2"')}${path(q => q.p, 'stroke="var(--accent)" stroke-width="2" stroke-dasharray="6 4"')}</svg>`;
  const key = `<div class="fv-keys"><span><i style="background:var(--fg)"></i>${t('pt.pgIst')}</span><span><i style="background:var(--accent)"></i>${t('pt.pgFc')}</span><span><i style="background:var(--muted)"></i>${t('pt.pgNaive')}</span></div>`;
  return `<div class="pt-prog-chart">${svg}${tableButton(sp.id)}${key}</div>`;
}
