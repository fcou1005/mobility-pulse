// Mobility Pulse — Karten per Tastatur (alle Leaflet-Karten: Übersicht, Disposition, Vergleich, Spot-Abgleich, Fahrtrouten, Bericht).
// Leaflet bringt Fokus (tabindex), Pfeiltasten (verschieben), +/− (zoomen) und Esc (Popup schließen) mit. Dazu kommt hier:
// N / P (auch Umschalt+N) springt durch die Objekte im sichtbaren Ausschnitt, nach Abstand zur Kartenmitte (höchstens MAX_ITEMS, die
// nächsten), hebt das Objekt mit einem Ring hervor, öffnet Tooltip bzw. Popup und sagt den Text in einer Live-Region an. Enter löst
// dieselbe Aktion aus wie ein Klick, Esc schließt. Die Objektliste kommt aus den Layern der Karte (auch Canvas-Marker), nie aus dem DOM;
// Karten ohne anklickbare Layer (Zellraster) geben eine eigene Liste über opts.items. Unter der Karte steht ein kurzer Hinweis (DE/EN),
// verknüpft per aria-describedby.
import { t, onLang } from './i18n.js?v=mvyy3d52';

export const MAX_ITEMS = 500;
const STYLE = `
.leaflet-container.mk-map:focus,.leaflet-container.mk-map:focus-visible{outline:none}
.leaflet-container.mk-map:focus-visible::after{content:"";position:absolute;inset:0;z-index:1001;pointer-events:none;border-radius:inherit;box-shadow:inset 0 0 0 3px var(--accent),inset 0 0 0 5px var(--panel)}
.mk-hint{margin:var(--s2) 0 0;font-size:12px;line-height:1.5;color:var(--muted);max-width:96ch}
.mk-hint kbd{display:inline-block;min-width:1.6em;padding:0 4px;font:500 11px/16px var(--mono);text-align:center;color:var(--fg-2);background:var(--panel-2);border:1px solid var(--line-2);border-bottom-width:2px;border-radius:4px}
.mk-live{position:absolute!important;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
[hidden]+.mk-hint{display:none}
@media (hover:none) and (pointer:coarse){.mk-hint{display:none}}
@media print{.mk-hint{display:none}}`;
let styled = false, seq = 0;
function injectStyle() {
  if (styled || typeof document === 'undefined') return; styled = true;
  const s = document.createElement('style'); s.id = 'mk-style'; s.textContent = STYLE; document.head.appendChild(s);
}
const OWN = new WeakSet(); // eigene Hervorhebungen: nie selbst Objekt der Liste
// Text eines Tooltips/Popups: Zeilen (Blockelemente) mit „; “ verbinden; HTML-Zeichenketten über <template> (inert, lädt nichts)
const clean = (s) => String(s || '').split(/\n+/).map(x => x.replace(/\s+/g, ' ').trim()).filter(Boolean).join('; ').slice(0, 400);
const strip = (html) => { const tp = document.createElement('template'); tp.innerHTML = String(html ?? ''); return tp.content.textContent || ''; };
const textOf = (el) => (el ? clean(el.innerText ?? el.textContent) : '');
const ownClick = (l) => (l?._events?.click || []).some(h => h.fn !== l._openPopup); // Klick-Aktion außer „Popup öffnen“
const isOwner = (l) => !!(l.getTooltip?.() || l.getPopup?.() || ownClick(l));
// Wer reagiert auf den Layer? Er selbst oder eine Gruppe, zu der sein Klick aufsteigt (FeatureGroup, GeoJSON)
function ownerOf(l, depth = 0) {
  if (isOwner(l)) return l;
  if (depth > 3) return null;
  for (const id in l._eventParents || {}) { const o = ownerOf(l._eventParents[id], depth + 1); if (o) return o; }
  return null;
}

/**
 * Tastaturbedienung für eine Leaflet-Karte. Einmal je Karte (weitere Aufrufe liefern dieselbe Steuerung).
 * opts.items()      eigene Objektliste [{ key, latlng, text(), show(), hide(), activate(), ring }] statt der Layer
 * opts.skip(layer)  Layer auslassen
 * opts.open(layer, latlng)  Vorschau für Layer ohne Tooltip/Popup (z. B. gemeinsames Popup der Canvas-Ebenen); true = geöffnet
 * opts.centerClick()        Text statt null: Enter klickt in die Kartenmitte (Depot setzen) und sagt den Text an
 * opts.hintAfter    Element, hinter dem der Hinweis steht (Standard: die Karte; gekoppelte Karten teilen einen Hinweis)
 * opts.hintExtra()  zusätzlicher Satz im Hinweis
 */
export function mapKeys(map, opts = {}) {
  const L = typeof window !== 'undefined' ? window.L : null;
  if (!L || !map) return null;
  if (map._mk) return map._mk;
  injectStyle();
  const box = map.getContainer(), max = opts.max || MAX_ITEMS;
  box.classList.add('mk-map');
  if (!box.hasAttribute('tabindex')) box.tabIndex = 0;
  // Hinweis und Live-Region unter der Karte (bei gleichem Container wiederverwendet)
  const anchor = opts.hintAfter || box;
  let hint = anchor.nextElementSibling;
  if (!hint?.classList.contains('mk-hint')) { hint = document.createElement('p'); hint.className = 'mk-hint'; hint.id = `mk-hint-${++seq}`; anchor.after(hint); }
  const hintHtml = () => [t('maps.hint'), opts.hintExtra?.()].filter(Boolean).join(' ');
  hint.innerHTML = hintHtml();
  const ids = new Set((box.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean)); ids.add(hint.id);
  box.setAttribute('aria-describedby', [...ids].join(' '));
  let live = box.dataset.mkLive ? document.getElementById(box.dataset.mkLive) : null;
  if (!live) { live = document.createElement('div'); live.className = 'mk-live'; live.id = `mk-live-${++seq}`; live.setAttribute('role', 'status'); live.setAttribute('aria-live', 'polite'); live.setAttribute('aria-atomic', 'true'); hint.after(live); box.dataset.mkLive = live.id; }
  const offLang = onLang(() => { if (hint.isConnected) hint.innerHTML = hintHtml(); });

  const pane = map.getPane('mk-focus') || map.createPane('mk-focus');
  pane.style.zIndex = 645; pane.style.pointerEvents = 'none'; // über Markern (600), unter Tooltips (650) und Popups (700)
  const renderer = L.svg({ pane: 'mk-focus', padding: 0.2 });
  let list = null, total = 0, idx = -1, cur = null, stale = true, rings = [], popup = null, timer = 0;

  const cssVar = (n, d) => (getComputedStyle(box).getPropertyValue(n) || '').trim() || d;
  const evt = (ll, oe) => ({ latlng: ll, layerPoint: map.latLngToLayerPoint(ll), containerPoint: map.latLngToContainerPoint(ll), originalEvent: oe || { type: 'keyboard' } });
  const announce = (msg) => { clearTimeout(timer); live.textContent = ''; timer = setTimeout(() => { live.textContent = msg; }, 40); };
  // Ankerpunkt im Ausschnitt: Punkt-Layer ihr Ort, Flächen/Linien ihre Mitte (liegt sie außerhalb: nächster Punkt des Umrisses zur Kartenmitte)
  function place(l, view) {
    if (l.getLatLng) { const ll = l.getLatLng(); return ll && view.contains(ll) ? ll : null; }
    if (!l.getBounds) return null;
    const b = l.getBounds(); if (!b?.isValid?.() || !view.intersects(b)) return null;
    let c; try { c = l.getCenter(); } catch { c = b.getCenter(); }
    if (view.contains(c)) return c;
    const m = map.getCenter();
    return L.latLng(Math.min(Math.max(m.lat, b.getSouth()), b.getNorth()), Math.min(Math.max(m.lng, b.getWest()), b.getEast()));
  }
  function collect() {
    const view = map.getBounds(), mid = map.getSize().divideBy(2), out = [];
    const dist = (ll) => map.latLngToContainerPoint(ll).distanceTo(mid);
    if (opts.items) {
      for (const it of opts.items() || []) { const ll = L.latLng(it.latlng); if (view.contains(ll)) out.push({ ...it, latlng: ll, d: dist(ll) }); }
    } else {
      const byGroup = new Map(); // Popup/Tooltip an einer Gruppe (GeoJSON-Zone): ein Objekt, der nächste Teil zählt
      map.eachLayer((l) => {
        if (OWN.has(l) || l instanceof L.LayerGroup || l instanceof L.GridLayer || l instanceof L.Renderer || l instanceof L.DivOverlay) return;
        if (l.options?.interactive === false || opts.skip?.(l)) return;
        const owner = ownerOf(l); if (!owner) return;
        const ll = place(l, view); if (!ll) return;
        const it = { key: l, layer: l, owner, latlng: ll, d: dist(ll) };
        if (owner !== l && (owner.getTooltip?.() || owner.getPopup?.())) { const p = byGroup.get(owner); if (p && p.d <= it.d) return; byGroup.set(owner, it); it.key = owner; }
        out.push(it);
      });
      if (byGroup.size) { const keep = new Set(byGroup.values()); for (let i = out.length - 1; i >= 0; i--) if (out[i].key !== out[i].layer && !keep.has(out[i])) out.splice(i, 1); }
    }
    out.sort((a, b) => a.d - b.d);
    return { items: out.slice(0, max), total: out.length };
  }
  function radiusOf(l) {
    if (!l) return 8;
    if (l instanceof L.Circle) return l._radius || 10; // Meter-Kreis: Pixelradius nach dem Projizieren
    if (l.options?.radius) return l.options.radius;
    const s = l.options?.icon?.options?.iconSize; if (s) return Math.max(...[].concat(s)) / 2;
    return 8;
  }
  function ring(it) {
    if (it.ring === false) return;
    const fg = cssVar('--fg', '#111820'), bg = cssVar('--panel', '#ffffff'), o = { pane: 'mk-focus', renderer, interactive: false, fill: false };
    const l = it.layer, r = Math.min(40, radiusOf(l) + 6);
    if (l instanceof L.Polygon) { const s = l.getLatLngs(); rings.push(L.polygon(s, { ...o, color: bg, weight: 6, opacity: 0.85 }), L.polygon(s, { ...o, color: fg, weight: 2.5 })); }
    rings.push(L.circleMarker(it.latlng, { ...o, radius: r, color: bg, weight: 6, opacity: 0.85 }), L.circleMarker(it.latlng, { ...o, radius: r, color: fg, weight: 2.5 }));
    for (const p of rings) { OWN.add(p); p.addTo(map); }
  }
  function keepPopup() { const p = map._popup; if (p && map.hasLayer(p)) popup = p; }
  // Vorschau: Tooltip (wie Überfahren, samt Hover-Stil der Karte), sonst Popup, sonst opts.open
  function peek(it) {
    if (it.show) { it.show(); return; }
    const { layer: l, owner: o, latlng: ll } = it;
    if (o.getTooltip?.()) { l.fire('mouseover', evt(ll), true); if (!o.isTooltipOpen()) o.openTooltip(ll); return; }
    if (o.getPopup?.()) { if (o !== l) o.getPopup()._source = l; o.openPopup(ll); keepPopup(); return; }
    if (opts.open?.(l, ll)) keepPopup();
  }
  function unpeek() {
    if (cur) {
      if (cur.hide) cur.hide();
      else if (cur.owner?.getTooltip?.() && map.hasLayer(cur.layer)) { cur.layer.fire('mouseout', evt(cur.latlng), true); if (cur.owner.isTooltipOpen()) cur.owner.closeTooltip(); }
    }
    if (popup && map.hasLayer(popup)) map.closePopup(popup);
    popup = null;
    for (const p of rings) p.remove();
    rings = [];
  }
  function textNow(it) {
    if (it.text) return clean(typeof it.text === 'function' ? it.text() : it.text);
    const o = it.owner;
    if (o?.getTooltip?.() && o.isTooltipOpen()) { const s = textOf(o.getTooltip().getElement?.()); if (s) return s; }
    const p = map._popup; if (p && map.hasLayer(p)) { const s = textOf(p.getElement?.()?.querySelector('.leaflet-popup-content')); if (s) return s; }
    return clean(it.layer?.options?.title || it.layer?.options?.alt || '') || t('maps.noText');
  }
  const message = (it) => (total > list.length ? t('maps.itemNearest', { i: idx + 1, n: list.length, text: textNow(it) }) : t('maps.item', { i: idx + 1, n: list.length, text: textNow(it) }));
  function step(dir) {
    if (stale || !list) {
      const was = cur?.key; const r = collect(); list = r.items; total = r.total; stale = false;
      idx = was != null ? list.findIndex(x => x.key === was) : -1;
    }
    unpeek();
    if (!list.length) { cur = null; idx = -1; announce(t('maps.none')); return; }
    idx = idx < 0 ? (dir > 0 ? 0 : list.length - 1) : (idx + dir + list.length) % list.length;
    cur = list[idx]; ring(cur); peek(cur);
    announce(message(cur));
  }
  function activate(e) {
    const center = opts.centerClick?.(); // z. B. Depot-Modus: Enter klickt immer in die Kartenmitte, die Rückgabe wird angesagt
    if (center) { unpeek(); cur = null; map.fire('click', evt(map.getCenter(), e)); announce(center); return; }
    if (!cur || (cur.layer && !map.hasLayer(cur.layer))) { announce(t('maps.pickFirst')); return; }
    if (cur.activate || cur.show) (cur.activate || cur.show)();
    else {
      const { layer: l, owner: o, latlng: ll } = cur;
      if (ownClick(o)) l.fire('click', evt(ll, e), true);
      else if (o.getPopup?.() && !o.isPopupOpen()) { if (o !== l) o.getPopup()._source = l; o.openPopup(ll); }
      keepPopup();
    }
    if (list.length) announce(message(cur));
  }
  function onKey(e) {
    if (e.target !== box || e.altKey || e.ctrlKey || e.metaKey) return;
    const k = e.key;
    if (/^Arrow/.test(k) || ['+', '-', '=', '_'].includes(k)) { stale = true; return; } // Leaflet verschiebt/zoomt
    if (k === 'n' || k === 'N' || k === 'p' || k === 'P') { e.preventDefault(); step(k === 'p' || k === 'P' || e.shiftKey ? -1 : 1); return; }
    if (k === 'Enter') { e.preventDefault(); activate(e); return; }
    if (k === 'Escape') { unpeek(); cur = null; } // Popup schließt Leaflet selbst
  }
  const onOut = (e) => { if (e.relatedTarget && box.contains(e.relatedTarget)) return; unpeek(); cur = null; stale = true; };
  const onDown = (e) => { if (cur && !e.target.closest?.('.leaflet-popup, .leaflet-control')) { unpeek(); cur = null; } };
  const mark = (e) => { if (!e || !(e.layer instanceof L.DivOverlay) && !OWN.has(e.layer)) stale = true; };
  box.addEventListener('keydown', onKey); box.addEventListener('focusout', onOut); box.addEventListener('pointerdown', onDown);
  map.on('zoomend dragend resize', () => { stale = true; }); map.on('layeradd layerremove', mark);
  map.once('unload', () => { offLang(); clearTimeout(timer); box.removeEventListener('keydown', onKey); box.removeEventListener('focusout', onOut); box.removeEventListener('pointerdown', onDown); map._mk = null; });
  map._mk = { refresh: () => { stale = true; }, hint, live };
  return map._mk;
}
