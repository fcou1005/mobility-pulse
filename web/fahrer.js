// @ts-check
// Mobility Pulse – Fahrermodus (S6.2, S6.6): Tour aus dem Link, Stopps abhaken, Navigation je Stopp, Rückmeldung „nicht gefunden/defekt“,
// offline per Service Worker. Karte mit Unterblatt in drei Stufen (Kopf, halb, voll): Ziehen folgt dem Finger, beim Loslassen setzt eine
// Feder mit der Geschwindigkeit des Fingers fort und rastet an der Stufe ein, auf die der Schwung zeigt (Projektion wie beim Scrollen);
// jederzeit greifbar. prefers-reduced-motion: Stufen ohne Bewegung. Das Blatt bewegt sich nur per transform – die Karte darunter springt nicht.
import { decodeTour, feedbackText, navUrl, progress, timeText, tourKey, workStops } from './pulse-fahrer.js';

const TXT = {
  de: { title: 'Fahrermodus', none: 'Keine Tour geladen', noneHint: 'Öffne den Fahrer-Link oder scanne den QR-Code aus der Disposition. Einmal mit Netz geöffnet, geht die Tour danach auch offline.', bad: 'Der Link enthält keine gültige Tour.', of: '{d} von {n}', next: 'Nächster Stopp', allDone: 'Alle Stopps bearbeitet', back: 'zurück zum Depot',
    done: 'Erledigt', nav: 'Navi ↗', missing: 'Nicht gefunden', broken: 'Defekt', share: 'Rückmeldung teilen', copied: 'Rückmeldung kopiert', reset: 'Zurücksetzen', resetSure: 'Wirklich alles zurücksetzen?', grip: 'Liste größer oder kleiner',
    offline: 'Offline – Tour vom {at}. Abhaken geht weiter, alles bleibt im Handy.', depot: 'Depot', pickup: 'Abholen', drop: 'Ausbringen', swap: 'Akku tauschen', pickup_disabled: 'Gesperrtes Fahrzeug abholen', veh: '× {n}', stop: 'Stopp {i}' },
  en: { title: 'Driver mode', none: 'No run loaded', noneHint: 'Open the driver link or scan the QR code from dispatch. Once opened with a connection, the run also works offline.', bad: 'The link does not contain a valid run.', of: '{d} of {n}', next: 'Next stop', allDone: 'All stops handled', back: 'back to the depot',
    done: 'Done', nav: 'Navigate ↗', missing: 'Not found', broken: 'Damaged', share: 'Share report', copied: 'Report copied', reset: 'Reset', resetSure: 'Really reset everything?', grip: 'Make list larger or smaller',
    offline: 'Offline – run from {at}. Ticking off still works, everything stays on the phone.', depot: 'Depot', pickup: 'Pick up', drop: 'Drop off', swap: 'Swap battery', pickup_disabled: 'Pick up disabled vehicle', veh: '× {n}', stop: 'Stop {i}' },
};
const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* privates Fenster */ } } };
const LANG = (() => { try { const q = new URLSearchParams(location.search).get('lang'); if (q === 'de' || q === 'en') return q; } catch { /* */ } const s = store.get('mp-lang'); return s === 'en' || s === 'de' ? s : (navigator.language || '').startsWith('de') ? 'de' : 'en'; })();
const T = (k, p = {}) => String(TXT[LANG][k] ?? k).replace(/\{(\w+)\}/g, (_, x) => String(p[x] ?? ''));
const $ = (s) => /** @type {HTMLElement} */ (document.querySelector(s));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
document.documentElement.lang = LANG;
const reduce = matchMedia('(prefers-reduced-motion: reduce)');

// ---------- Tour laden: Link vor zuletzt geöffneter Tour (offline ohne Link) ----------
const fromHash = (() => { const m = /[#&]t=([A-Za-z0-9_-]+)/.exec(location.hash); return m ? m[1] : null; })();
const text = fromHash || store.get('mp-tour-last');
const tour = text ? decodeTour(text) : null;
const KEY = text ? `mp-tour:${tourKey(text)}` : null;
if (tour && fromHash) store.set('mp-tour-last', fromHash);
/** @type {{ done: Record<string, number>, issue: Record<string, string> }} */
let st = (() => { try { const j = JSON.parse(store.get(KEY || '') || 'null'); return j && typeof j === 'object' ? { done: j.done || {}, issue: j.issue || {} } : { done: {}, issue: {} }; } catch { return { done: {}, issue: {} }; } })();
const save = () => { if (KEY) store.set(KEY, JSON.stringify(st)); };
const atText = tour ? new Date(tour.at).toLocaleString(LANG === 'en' ? 'en-GB' : 'de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
document.title = tour ? `${T('title')} · ${tour.id}` : `Mobility Pulse – ${T('title')}`;

// ---------- Karte ----------
/** @type {any} */ const L = /** @type {any} */ (globalThis).L;
let map = null; const pins = new Map();
function initMap() {
  if (!L || !tour) return;
  map = L.map('map', { zoomControl: false, attributionControl: true });
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' }).addTo(map);
  tour.stops.forEach((s, i) => {
    const m = L.marker([s.lat, s.lon], { icon: L.divIcon({ className: '', html: `<div class="pin${s.type === 'depot' ? ' depot' : ''}">${s.type === 'depot' ? 'D' : i}</div>`, iconSize: [30, 30], iconAnchor: [15, 15] }), keyboard: false }).addTo(map);
    if (s.type !== 'depot') m.on('click', () => { snapTo('half'); document.getElementById(`s${i}`)?.scrollIntoView({ block: 'nearest' }); });
    pins.set(i, m);
  });
  fitMap();
}
function fitMap() { if (!map || !tour?.stops.length) return; map.fitBounds(L.latLngBounds(tour.stops.map(s => [s.lat, s.lon])), { paddingTopLeft: [24, 48], paddingBottomRight: [24, visible() + 16], maxZoom: 17, animate: false }); }

// ---------- Darstellung ----------
const label = (s) => T(s.type);
function stopHtml(s) {
  const d = !!st.done[s.i], is = st.issue[s.i] || '';
  return `<li class="stop${d ? ' done' : ''}${is ? ' issue' : ''}" id="s${s.i}"><span class="no" aria-hidden="true">${s.i}</span><div><div class="what">${esc(label(s))}${s.count ? ` ${T('veh', { n: s.count })}` : ''}</div>
    <div class="meta">${s.eta != null ? `<span>${timeText(s.eta)}</span> · ` : ''}${esc(s.note)}${s.note ? ' · ' : ''}${s.lat.toFixed(5)}, ${s.lon.toFixed(5)}</div></div>
    <div class="acts"><button type="button" data-act="done" data-i="${s.i}" aria-pressed="${d}" aria-label="${esc(`${T('stop', { i: s.i })}: ${T('done')}`)}">✓ ${T('done')}</button><a class="btn" href="${navUrl(s)}" target="_blank" rel="noopener" aria-label="${esc(`${T('stop', { i: s.i })}: ${T('nav')}`)}">${T('nav')}</a>
      <button type="button" class="warn" data-act="missing" data-i="${s.i}" aria-pressed="${is === 'missing'}">${T('missing')}</button><button type="button" class="warn" data-act="broken" data-i="${s.i}" aria-pressed="${is === 'broken'}">${T('broken')}</button></div></li>`;
}
function render() {
  if (!tour) {
    $('#drv-title').textContent = T('title');
    $('#drv-next').innerHTML = `<div class="empty" style="padding:0"><h1>${T('none')}</h1><p>${text ? T('bad') : T('noneHint')}</p></div>`;
    $('#stops').innerHTML = ''; $('#foot').innerHTML = ''; return;
  }
  const p = progress(tour, st), w = workStops(tour);
  $('#drv-title').textContent = `${tour.id}${tour.title ? ` · ${tour.title}` : ''}`;
  $('#drv-count').textContent = T('of', { d: p.done + p.issues, n: p.total });
  /** @type {HTMLElement} */ ($('#drv-bar')).style.width = `${p.total ? Math.round(100 * (p.done + p.issues) / p.total) : 0}%`;
  const n = p.next;
  $('#drv-next').innerHTML = n ? `<div><p>${T('next')}${n.eta != null ? ` · ${timeText(n.eta)}` : ''}</p><h1>${n.i} · ${esc(label(n))}${n.count ? ` ${T('veh', { n: n.count })}` : ''}</h1><p>${esc(n.note)}</p></div>
    <div class="acts" style="grid-column:auto;margin:0"><a class="btn" href="${navUrl(n)}" target="_blank" rel="noopener">${T('nav')}</a><button type="button" class="primary" data-act="done" data-i="${n.i}" aria-pressed="false">✓ ${T('done')}</button></div>`
    : `<div><h1>${T('allDone')}</h1><p>${T('back')}</p></div>`;
  $('#stops').innerHTML = w.map(stopHtml).join('');
  $('#foot').innerHTML = `<button type="button" class="primary" data-act="share">${T('share')}</button><button type="button" data-act="reset">${T('reset')}</button><span class="sr" role="status" id="drv-said"></span>`;
  for (const [i, m] of pins) { const s = tour.stops[i]; if (s.type === 'depot') continue; const el = m.getElement()?.firstElementChild; if (el) el.className = `pin${st.done[i] ? ' done' : st.issue[i] ? ' issue' : ''}${n?.i === i ? ' next' : ''}`; }
}
document.addEventListener('click', async (e) => {
  const b = /** @type {HTMLElement|null} */ (/** @type {HTMLElement} */ (e.target).closest('[data-act]')); if (!b) return;
  const act = b.getAttribute('data-act'), i = b.getAttribute('data-i');
  if (act === 'done' && i != null) { if (st.done[i]) delete st.done[i]; else { st.done[i] = Date.now(); delete st.issue[i]; } save(); render(); return; }
  if ((act === 'missing' || act === 'broken') && i != null) { if (st.issue[i] === act) delete st.issue[i]; else { st.issue[i] = act; delete st.done[i]; } save(); render(); return; }
  if (act === 'share' && tour) {
    const msg = feedbackText(tour, st, { lang: LANG });
    try { if (navigator.share) { await navigator.share({ title: `${T('title')} ${tour.id}`, text: msg }); return; } } catch { /* abgebrochen */ }
    try { await navigator.clipboard.writeText(msg); $('#drv-said').textContent = T('copied'); b.textContent = T('copied'); } catch { /* ohne Zwischenablage */ }
    return;
  }
  if (act === 'reset') { if (b.dataset.sure) { st = { done: {}, issue: {} }; save(); render(); } else { b.dataset.sure = '1'; b.textContent = T('resetSure'); } }
});

// ---------- Unterblatt: drei Stufen, Feder, Schwung ----------
const sheet = $('#sheet'), grip = /** @type {HTMLButtonElement} */ ($('#grip'));
grip.setAttribute('aria-label', T('grip'));
let H = 0, y = 0, vel = 0, target = 0, raf = 0, stage = 'peek';
const vh = () => window.innerHeight;
const heights = () => ({ peek: Math.min(H, $('#head').offsetHeight + 28 + 20), half: Math.min(H, Math.round(vh() * 0.5)), full: H });
const visible = () => H - y;
function place(v) { y = Math.max(0, Math.min(H, v)); sheet.style.setProperty('--y', `${y}px`); /** @type {HTMLElement} */ ($('#list')).style.maxHeight = `${Math.max(0, H - y - $('#head').offsetHeight - 28)}px`; }
function spring(to, v0 = 0, damping = 1) {
  cancelAnimationFrame(raf); target = to; vel = v0;
  if (reduce.matches) { place(to); vel = 0; return; }
  const response = 0.35, k = (2 * Math.PI / response) ** 2, c = 2 * damping * Math.sqrt(k); let last = performance.now();
  const step = (now) => { const dt = Math.min(0.032, (now - last) / 1000); last = now; const a = -k * (y - target) - c * vel; vel += a * dt; place(y + vel * dt);
    if (Math.abs(y - target) < 0.5 && Math.abs(vel) < 8) { place(target); vel = 0; return; } raf = requestAnimationFrame(step); };
  raf = requestAnimationFrame(step);
}
function snapTo(name, v0 = 0, damping = 1) { const h = heights()[name]; stage = name; grip.setAttribute('aria-expanded', String(name !== 'peek')); spring(H - h, v0, damping); }
const project = (v, rate = 0.998) => (v / 1000) * rate / (1 - rate); // Apple, „Designing Fluid Interfaces“: Ruhepunkt aus der Geschwindigkeit
let drag = null, quietUntil = 0;
function down(e) { if (e.button > 0) return; drag = { id: e.pointerId, y0: e.clientY, s0: y, hist: [[e.timeStamp, e.clientY]], moved: false }; cancelAnimationFrame(raf); /** @type {HTMLElement} */ (e.currentTarget).setPointerCapture(e.pointerId); }
function move(e) { if (!drag || e.pointerId !== drag.id) return; const dy = e.clientY - drag.y0; if (!drag.moved && Math.abs(dy) < 6) return; drag.moved = true; place(drag.s0 + dy); drag.hist.push([e.timeStamp, e.clientY]); if (drag.hist.length > 6) drag.hist.shift(); }
function up(e) {
  if (!drag || e.pointerId !== drag.id) return; const d = drag; drag = null; if (!d.moved) return; quietUntil = performance.now() + 400; // der Klick nach dem Ziehen schaltet nicht um
  const [t0, y0] = d.hist[0], [t1, y1] = d.hist[d.hist.length - 1], v = t1 > t0 ? (y1 - y0) / (t1 - t0) * 1000 : 0; // px/s nach unten
  const end = y + project(v), hs = heights(); let best = 'peek', bd = Infinity;
  for (const [nm, h] of Object.entries(hs)) { const dd = Math.abs((H - h) - end); if (dd < bd) { bd = dd; best = nm; } }
  snapTo(best, v, Math.abs(v) > 600 ? 0.85 : 1); // kleiner Nachschwung nur nach einem Wurf
  e.preventDefault();
}
for (const el of [grip, $('#head')]) { el.addEventListener('pointerdown', down); el.addEventListener('pointermove', move); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up); }
grip.addEventListener('click', () => { if (performance.now() < quietUntil) return; snapTo(stage === 'peek' ? 'half' : stage === 'half' ? 'full' : 'peek'); });
function layout() { H = sheet.offsetHeight; snapTo(stage); }
window.addEventListener('resize', () => { const was = stage; H = sheet.offsetHeight; cancelAnimationFrame(raf); place(H - heights()[was]); });

// ---------- offline ----------
function online() { const o = $('#offline'); if (navigator.onLine || !tour) { o.hidden = true; return; } o.textContent = T('offline', { at: atText }); o.hidden = false; }
window.addEventListener('online', online); window.addEventListener('offline', online);
if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw-fahrer.js', { scope: './fahrer.html' }).catch(() => { /* ohne Service Worker nur online */ });

render(); H = sheet.offsetHeight; stage = 'peek'; place(H - heights().peek); grip.setAttribute('aria-expanded', 'false'); initMap(); render(); online();
window.addEventListener('load', () => { layout(); fitMap(); });
/** @type {any} */ (globalThis).__drv = { snapTo, stage: () => stage, visible };
