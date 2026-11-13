// Mobility Pulse — Stadt-Paket (Sprint 5): Stadt-Startseite (S5.7), Datenauflagen-Check (S5.1), Ausschreibungs-Radar (S5.3), Einbetten (S5.4).
// Eigenständig: renderStadt / renderAuflagen / renderTenders(el, ctx), ctx = rpCtx() (state, CFG, getJson, esc, fmt, muniName, setScope).
// Daten: latest.json (Bestand je Gemeinde), reference.json (amtliche Obergrenzen, main), auflagen/verfuegbarkeit-<Jahr>.json (Jahresbuch),
// auflagen/alarme.json (Alarme), idle.json (Standzeiten), pricing.json (Tarife), data/ausschreibungen.json (main, von Hand gepflegt).
import * as R from './pulse-report.js';
import * as AU from './pulse-auflagen.js';
import { KIND_DE, KINDS } from './pulse-alarme.js';
import { t, dateFmt } from './i18n.js';
import { clearAnswer, putAnswer } from './answer.js';

const TZ = 'Europe/Berlin', DAY = new Intl.DateTimeFormat('en-CA', { timeZone: TZ });
const cache = new Map();
const load = (ctx, url) => { if (!cache.has(url)) cache.set(url, ctx.getJson(url, { timeout: 30000 }).then(r => (r?.ok ? r.json : null)).catch(() => null)); return cache.get(url); };
const stamp = (ms) => (ms ? dateFmt({ dateStyle: 'medium', timeStyle: 'short', timeZone: TZ }).format(new Date(ms)) : '–');
const dayTxt = (d) => (d ? dateFmt({ dateStyle: 'medium', timeZone: TZ }).format(new Date(`${d}T12:00:00Z`)) : '–');
const pct = (ctx, x, d = 0) => (x == null || !Number.isFinite(x) ? '–' : `${ctx.fmt(x * 100, d)} %`);
const LVL = { ok: ['✓', 'ok'], near: ['!', 'warn'], bad: ['✕', 'bad'], over: ['✕', 'bad'], unknown: ['?', ''] };
const lvlChip = (lvl, label) => `<span class="sd-lvl ${LVL[lvl]?.[1] || ''}"><i aria-hidden="true">${LVL[lvl]?.[0] || '–'}</i>${label}</span>`;
const yearNow = () => +DAY.format(new Date()).slice(0, 4);
const ledgerOf = async (ctx) => (await load(ctx, `${ctx.CFG.DATA}auflagen/verfuegbarkeit-${yearNow()}.json`)) || (await load(ctx, `${ctx.CFG.DATA}auflagen/verfuegbarkeit-${yearNow() - 1}.json`));
let cssDone = false;
function css() {
  if (cssDone || typeof document === 'undefined') return; cssDone = true;
  const s = document.createElement('style'); s.textContent = `
.sd-lvl{display:inline-flex;gap:6px;align-items:center;font-weight:600}.sd-lvl i{display:inline-grid;place-items:center;width:1.3em;height:1.3em;border-radius:50%;font-style:normal;font-size:.75rem;color:var(--panel);background:var(--muted)}
.sd-lvl.ok i{background:var(--ok)}.sd-lvl.warn i{background:var(--warn)}.sd-lvl.bad i{background:var(--bad)}
.sd-links{display:flex;flex-wrap:wrap;gap:var(--s2);margin:var(--s3) 0 0}.sd-alarms{list-style:none;margin:0;padding:0;display:grid;gap:var(--s2)}
.sd-alarms li{display:grid;grid-template-columns:auto 1fr;gap:2px var(--s3);padding:var(--s2) 0;border-bottom:1px solid var(--line)}.sd-alarms .k{grid-row:span 2}.sd-alarms small{color:var(--muted)}
.sd-feeds{display:flex;flex-wrap:wrap;gap:var(--s2)}.sd-code{width:100%;font:.75rem/1.4 var(--mono);padding:var(--s2);border:1px solid var(--line-2);border-radius:var(--r-sm);background:var(--panel-2);color:var(--fg)}
.sd-cal{display:grid;gap:var(--s4)}.sd-cal h3{margin:0 0 var(--s2);font-size:.875rem}
@media print{body.sd-printing .app>:not(main),body.sd-printing .topbar,body.sd-printing .filters,body.sd-printing #notice,body.sd-printing .view:not(.active),body.sd-printing .sd-noprint,body.sd-printing .toc{display:none!important}}`;
  document.head.appendChild(s);
}
const pickCity = (el, ctx, key) => {
  const munis = Object.entries(ctx.state.latest?.municipalities || {}).filter(([, m]) => m.available).sort((a, b) => b[1].available - a[1].available).slice(0, 12);
  el.innerHTML = `<div class="empty"><b>${t(key)}</b>${munis.map(([ags, m]) => `<button type="button" class="chip" data-ags="${ctx.esc(ags)}">${ctx.esc(m.name || ags)}</button>`).join(' ')}</div>`;
  el.querySelectorAll('button[data-ags]').forEach(b => b.addEventListener('click', () => ctx.setScope?.(b.dataset.ags)));
};

// ---------- S5.7 Stadt-Startseite: Antwort zuerst – Bestand gegen Obergrenze, Feed-Verfügbarkeit, Standzeiten über 72 h, offene Alarme ----------
export async function renderStadt(el, ctx) {
  if (!el) return; css();
  const ags = ctx.state.scope && ctx.state.scope !== 'DE' ? ctx.state.scope : null;
  if (!ags) { clearAnswer(el); pickCity(el, ctx, 'sd.pick'); return; }
  const name = ctx.muniName?.(ags) || ags, latest = ctx.state.latest;
  el.innerHTML = `<div class="muted small">${t('sd.loading')}</div>`;
  const [ref, ledger, alarms, idle, pricing] = await Promise.all([load(ctx, `${ctx.CFG.MAIN}reference.json`), ledgerOf(ctx), load(ctx, `${ctx.CFG.DATA}auflagen/alarme.json`), load(ctx, `${ctx.CFG.DATA}idle.json`), load(ctx, `${ctx.CFG.DATA}pricing.json`)]);
  if (ctx.state.scope !== ags) return;
  // Bestand gegen amtliche Obergrenze (E-Scooter, wie der Bericht)
  const cap = ref ? (R.capsCheck(ref, latest?.groups || {}, { ags }) || []).find(c => c.ags === ags) : null;
  const scooters = Object.entries(latest?.groups || {}).filter(([k]) => k.startsWith(`${ags}|`) && k.endsWith('|scooter')).reduce((a, [, g]) => a + (g.total || 0), 0);
  // Feed-Verfügbarkeit im Kalenderjahr: schwächster Anbieter
  const rows = AU.obligations(latest, ledger, { ags, pricing }), withAvail = rows.filter(r => r.avail != null).sort((a, b) => a.avail - b.avail), worst = withAvail[0] || null;
  // Standzeiten über 72 h (idle.json, Klasse „> 72 h“)
  let idleN = 0, idleAll = 0; for (const [k, v] of Object.entries(idle?.groups || {})) if (k.startsWith(`${ags}|`)) { idleN += v[5] || 0; idleAll += v[v.length - 1] || 0; }
  const week = Date.now() - 7 * 864e5, open = (alarms?.items || []).filter(x => x.ags === ags && x.at >= week);
  const capLvl = cap ? (cap.status === 'over' ? 'bad' : cap.status === 'near' ? 'warn' : 'ok') : '';
  putAnswer(el, { id: 'stadt',
    sentence: t(cap ? 'ans.stadt' : 'ans.stadtNoCap', { name: ctx.esc(name), n: `<strong>${ctx.fmt(cap?.total ?? scooters)}</strong>`, limit: cap ? ctx.fmt(cap.limit) : '', alarms: ctx.fmt(open.length) }),
    kpis: [
      { label: t('sd.kCap'), value: cap ? pct(ctx, cap.total / cap.limit) : ctx.fmt(scooters), n: cap ? cap.total : scooters, cmp: cap ? t('sd.kCapCmp', { n: ctx.fmt(cap.total), limit: ctx.fmt(cap.limit) }) : t('sd.noCap'), tone: capLvl },
      { label: t('sd.kAvail'), value: worst ? pct(ctx, worst.avail, 1) : '–', cmp: worst ? t('sd.kAvailCmp', { op: worst.op, target: pct(ctx, AU.AVAIL_TARGET) }) : t('sd.noLedger'), tone: worst ? (worst.level === 'ok' ? 'ok' : worst.level === 'near' ? 'warn' : 'bad') : '' },
      { label: t('sd.kIdle'), value: idleAll ? pct(ctx, idleN / idleAll) : '–', cmp: t('sd.kIdleCmp', { n: ctx.fmt(idleN), all: ctx.fmt(idleAll) }), tone: idleAll && idleN / idleAll > 0.2 ? 'warn' : '' },
    ],
    how: t('sd.how', { target: pct(ctx, AU.AVAIL_TARGET) }), asOf: stamp(latest?.at) });
  const feed = (k) => `${ctx.CFG.DATA}feeds/${ags}${k ? `-${k}` : ''}.xml`;
  const alarmList = open.length ? `<ul class="sd-alarms">${open.slice(0, 10).map(x => `<li><span class="k">${lvlChip(x.level === 'bad' ? 'bad' : x.level === 'warn' ? 'near' : 'ok', ctx.esc(KIND_DE[x.kind] || x.kind))}</span><b>${ctx.esc(x.title)}</b><small>${stamp(x.at)}: ${ctx.esc(x.text)}</small></li>`).join('')}</ul>`
    : `<div class="empty"><b>${t('sd.noAlarms')}</b>${t('sd.noAlarmsHint')}</div>`;
  const embed = `<iframe src="${ctx.esc(new URL('.', location.href).href)}?embed=1&amp;scope=${ags}#stadt" title="Mobility Pulse – ${ctx.esc(name)}" width="100%" height="560" loading="lazy" style="border:0"></iframe>`;
  el.innerHTML = `<div class="grid">
    <div class="panel c8"><div class="panel-head"><div><h2>${t('sd.alarmsTitle')}</h2><div class="sub">${t('sd.alarmsSub')}</div></div></div>${alarmList}
      <div class="sd-links"><a class="chip" href="#bericht">${t('sd.toReport')}</a><a class="chip" href="#auflagen">${t('sd.toAuflagen')}</a><a class="chip" href="#ausschreibungen">${t('sd.toTenders')}</a></div></div>
    <div class="panel c4 sd-noprint"><div class="panel-head"><div><h2>${t('sd.feedsTitle')}</h2><div class="sub">${t('sd.feedsSub')}</div></div></div>
      <div class="sd-feeds"><a class="chip" href="${ctx.esc(feed(null))}" type="application/atom+xml">${t('sd.feedAll')}</a>${KINDS.map(k => `<a class="chip" href="${ctx.esc(feed(k))}" type="application/atom+xml">${ctx.esc(KIND_DE[k])}</a>`).join('')}</div>
      <h3 style="margin:var(--s4) 0 var(--s2);font-size:.875rem">${t('sd.embedTitle')}</h3><textarea class="sd-code" rows="4" readonly aria-label="${t('sd.embedTitle')}">${ctx.esc(embed)}</textarea></div>
  </div>`;
}

// ---------- S5.1 Datenauflagen-Check: je Anbieter Feed, Datenalter, Verfügbarkeit im Kalenderjahr (Ampel gegen 96 %), Zonen, Preise, Lizenz, GBFS ----------
export async function renderAuflagen(el, ctx) {
  if (!el) return; css();
  const ags = ctx.state.scope && ctx.state.scope !== 'DE' ? ctx.state.scope : null;
  if (!ags) { clearAnswer(el); pickCity(el, ctx, 'aufl.pick'); return; }
  const name = ctx.muniName?.(ags) || ags;
  const [ledger, pricing] = await Promise.all([ledgerOf(ctx), load(ctx, `${ctx.CFG.DATA}pricing.json`)]);
  if (ctx.state.scope !== ags) return;
  const rows = AU.obligations(ctx.state.latest, ledger, { ags, pricing }), month = DAY.format(new Date()).slice(0, 7);
  const ok = rows.filter(r => r.level === 'ok').length, judged = rows.filter(r => r.level !== 'unknown').length, worst = rows.filter(r => r.avail != null).sort((a, b) => a.avail - b.avail)[0];
  const from = rows.map(r => r.from).filter(Boolean).sort()[0] || null;
  putAnswer(el, { id: 'auflagen',
    sentence: t('ans.auflagen', { name: `<b>${ctx.esc(name)}</b>`, ok: `<strong>${ctx.fmt(ok)}</strong>`, n: ctx.fmt(judged), target: pct(ctx, AU.AVAIL_TARGET), year: ledger?.year ?? yearNow() }),
    kpis: [
      { label: t('aufl.kOk'), value: t('ans.ofN', { a: ctx.fmt(ok), b: ctx.fmt(judged) }), n: ok, cmp: t('aufl.kOkCmp', { target: pct(ctx, AU.AVAIL_TARGET) }), tone: judged && ok === judged ? 'ok' : judged ? 'warn' : '' },
      { label: t('aufl.kWorst'), value: worst ? pct(ctx, worst.avail, 1) : '–', cmp: worst ? worst.op : t('sd.noLedger'), tone: worst ? (worst.level === 'ok' ? 'ok' : worst.level === 'near' ? 'warn' : 'bad') : '' },
      { label: t('aufl.kFeeds'), value: t('ans.ofN', { a: ctx.fmt(rows.filter(r => r.feed).length), b: ctx.fmt(rows.length) }), n: rows.filter(r => r.feed).length, cmp: t('aufl.kFeedsCmp') },
    ],
    how: t('aufl.how', { target: pct(ctx, AU.AVAIL_TARGET), from: dayTxt(from) }), asOf: stamp(ledger?.at || ctx.state.latest?.at) });
  const yes = (b) => (b ? `<span class="sd-lvl ok"><i aria-hidden="true">✓</i>${t('aufl.yes')}</span>` : `<span class="sd-lvl bad"><i aria-hidden="true">✕</i>${t('aufl.no')}</span>`);
  const age = (ms) => (ms == null ? '–' : ms < 3600e3 ? t('aufl.min', { n: ctx.fmt(Math.round(ms / 60e3)) }) : t('aufl.h', { n: ctx.fmt(ms / 3600e3, 1) }));
  const body = rows.map(r => { const m = r.sources.map(id => AU.monthAvailability(ledger, id, month)).filter(Boolean).reduce((a, x) => ({ runs: a.runs + x.runs, ok: a.ok + x.ok }), { runs: 0, ok: 0 });
    return `<tr><td><b>${ctx.esc(r.op)}</b><div class="sub-line mono">${r.sources.map(ctx.esc).join(', ')}</div></td><td>${yes(r.feed)}</td><td class="n">${age(r.ageMs)}</td>
      <td class="n">${r.avail == null ? '–' : lvlChip(r.level, pct(ctx, r.avail, 1))}<div class="sub-line">${t('aufl.runs', { n: ctx.fmt(r.runs) })}</div></td><td class="n">${m.runs ? pct(ctx, m.ok / m.runs, 1) : '–'}</td>
      <td>${yes(r.zones)}</td><td>${yes(r.prices)}</td><td>${ctx.esc(r.license || '–')}</td><td>${ctx.esc(r.version ? `${(r.api || 'gbfs').toUpperCase()} ${r.version}` : (r.api || '–').toUpperCase())}</td></tr>`; }).join('');
  el.innerHTML = `<div class="panel-head"><div><h2>${t('aufl.title', { name: ctx.esc(name) })}</h2><div class="sub">${t('aufl.sub', { year: ledger?.year ?? yearNow(), from: dayTxt(from) })}</div></div>
    <div class="sd-noprint"><button type="button" data-sd-print>${t('aufl.print', { month: dateFmt({ month: 'long', year: 'numeric', timeZone: TZ }).format(new Date()) })}</button></div></div>
    ${rows.length ? `<div class="tbl sd-auf" tabindex="0" role="region" aria-label="${t('aufl.title', { name: ctx.esc(name) })}"><table><thead><tr><th>${t('aufl.colOp')}</th><th>${t('aufl.colFeed')}</th><th class="n">${t('aufl.colAge')}</th><th class="n">${t('aufl.colYear', { year: ledger?.year ?? yearNow() })}</th><th class="n">${t('aufl.colMonth')}</th><th>${t('aufl.colZones')}</th><th>${t('aufl.colPrices')}</th><th>${t('aufl.colLicense')}</th><th>${t('aufl.colVersion')}</th></tr></thead><tbody>${body}</tbody></table></div>`
      : `<div class="empty"><b>${t('aufl.none')}</b><a href="#coverage">${t('aufl.toCoverage')}</a></div>`}
    <p class="note small" style="margin-top:var(--s3)">${t('aufl.note', { target: pct(ctx, AU.AVAIL_TARGET) })}</p>`;
  el.querySelector('[data-sd-print]')?.addEventListener('click', () => { document.body.classList.add('sd-printing'); const end = () => { document.body.classList.remove('sd-printing'); window.removeEventListener('afterprint', end); }; window.addEventListener('afterprint', end); window.print(); setTimeout(end, 60e3); });
}

// ---------- S5.3 Ausschreibungs-Radar: Verfahren, Fristen, Obergrenzen, Gebühren je Stadt mit Quelle (data/ausschreibungen.json) ----------
export async function renderTenders(el, ctx) {
  if (!el) return; css();
  const doc = await load(ctx, `${ctx.CFG.MAIN}ausschreibungen.json`);
  const list = (doc?.verfahren || []).slice().sort((a, b) => String(a.frist || '9999').localeCompare(String(b.frist || '9999')));
  const today = DAY.format(new Date()), next = list.filter(x => x.frist && x.frist >= today), past = list.filter(x => !x.frist || x.frist < today);
  putAnswer(el, { id: 'ausschreibungen',
    sentence: next.length ? t('ans.tenders', { n: `<strong>${ctx.fmt(next.length)}</strong>`, first: `<b>${ctx.esc(next[0].stadt)}</b>`, date: dayTxt(next[0].frist) }) : t('ans.tendersNone', { n: ctx.fmt(list.length) }),
    kpis: [
      { label: t('aus.kOpen'), value: ctx.fmt(next.length), n: next.length, cmp: t('aus.kOpenCmp', { n: ctx.fmt(list.length) }) },
      { label: t('aus.kNext'), value: next.length ? dayTxt(next[0].frist) : '–', cmp: next.length ? next[0].stadt : t('aus.noNext') },
      { label: t('aus.kChecked'), value: doc?.stand ? dayTxt(doc.stand) : '–', cmp: t('aus.kCheckedCmp', { n: ctx.fmt(list.length) }) },
    ],
    how: t('aus.how'), asOf: doc?.stand ? dayTxt(doc.stand) : '' });
  const row = (x, open) => `<tr class="${open ? 'open' : ''}"><td><b>${ctx.esc(x.stadt)}</b>${x.ags ? `<div class="sub-line mono">${ctx.esc(x.ags)}</div>` : ''}</td><td>${ctx.esc(x.verfahren || '–')}</td><td class="n">${x.frist ? dayTxt(x.frist) : '–'}${x.fristArt ? `<div class="sub-line">${ctx.esc(x.fristArt)}</div>` : ''}</td>
    <td class="n">${x.obergrenze != null ? ctx.fmt(x.obergrenze) : '–'}${x.jeAnbieter != null ? `<div class="sub-line">${t('aus.perOp', { n: ctx.fmt(x.jeAnbieter) })}</div>` : ''}</td><td class="n">${x.anbieter != null ? ctx.fmt(x.anbieter) : '–'}</td><td>${ctx.esc(x.gebuehren || '–')}</td>
    <td>${/^https:\/\//.test(x.quelle_url || '') ? `<a href="${ctx.esc(x.quelle_url)}" target="_blank" rel="noopener">${ctx.esc(x.quelle || t('aus.source'))}</a>` : ctx.esc(x.quelle || '–')}<div class="sub-line">${t('aus.checked', { d: dayTxt(x.geprueft) })}${x.hinweis ? `. ${ctx.esc(x.hinweis)}` : ''}</div></td></tr>`;
  const head = `<thead><tr><th>${t('aus.colCity')}</th><th>${t('aus.colProc')}</th><th class="n">${t('aus.colDeadline')}</th><th class="n">${t('aus.colCap')}</th><th class="n">${t('aus.colOps')}</th><th>${t('aus.colFees')}</th><th>${t('aus.colSource')}</th></tr></thead>`;
  const byMonth = new Map(); for (const x of next) { const m = x.frist.slice(0, 7); if (!byMonth.has(m)) byMonth.set(m, []); byMonth.get(m).push(x); }
  el.innerHTML = `<div class="panel-head"><div><h2>${t('aus.title')}</h2><div class="sub">${t('aus.sub')}</div></div></div>
    ${list.length ? `<div class="sd-cal">${[...byMonth].map(([m, xs]) => `<section><h3>${dateFmt({ month: 'long', year: 'numeric', timeZone: TZ }).format(new Date(`${m}-15T12:00:00Z`))}</h3><div class="tbl sd-tenders" tabindex="0" role="region" aria-label="${t('aus.title')}"><table>${head}<tbody>${xs.map(x => row(x, true)).join('')}</tbody></table></div></section>`).join('')}
      ${past.length ? `<section><h3>${t('aus.past')}</h3><div class="tbl sd-tenders" tabindex="0" role="region" aria-label="${t('aus.past')}"><table>${head}<tbody>${past.map(x => row(x, false)).join('')}</tbody></table></div></section>` : ''}</div>`
      : `<div class="empty"><b>${t('aus.none')}</b>${t('aus.noneHint')} <a href="https://github.com/fcou1005/mobility-pulse/blob/main/data/ausschreibungen.json">data/ausschreibungen.json</a></div>`}
    <p class="note small" style="margin-top:var(--s3)">${t('aus.note')}</p>`;
}
