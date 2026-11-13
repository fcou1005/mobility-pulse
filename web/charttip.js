// Mobility Pulse — ein Hover-Layer für alle Diagramme (S4.5), aus dem Muster des Verfügbarkeitsdiagramms im Bericht:
// Fadenkreuz an der nächsten Stelle, alle Reihen im Tooltip (größter Wert oben), Antippen hält ihn fest (nochmal antippen oder Esc löst),
// Pfeiltasten/Pos1/Ende wandern bei fokussiertem Diagramm, „Als Tabelle“ zeigt dieselben Werte als Tabelle. Werte stehen nie in SVG-<title>.
// Ein Diagramm meldet sich mit chartSpec(spec) an und setzt die gelieferten Attribute auf sein <svg>; ein Knopf aus tableButton(id) daneben.
//   spec = { n, x(i) → x im viewBox, top, bottom (Fadenkreuz im viewBox), head(i) → Text, rows(i) → [{ color, label, value }],
//            label: Tabellenüberschrift, colHead: Kopf der ersten Spalte, cols?: [Reihenname], cell?(i, k) → Text }
import { t } from './i18n.js';

const SPECS = new Map(); let seq = 0, bound = false;
const ACTIVE = new WeakMap(); // svg → { i, pinned }
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Diagramm anmelden; liefert { id, attrs } – attrs auf das <svg> setzen (data-ct, tabindex, Hinweis für Tastatur).
 *  focus: false für Kleinstdiagramme in Tabellenzeilen (kein eigener Tab-Halt, Werte stehen in der Zeile) */
export function chartSpec(spec, { focus = true } = {}) {
  const id = `ct${++seq}`; SPECS.set(id, spec);
  if (SPECS.size > 300) SPECS.delete(SPECS.keys().next().value); // alte Diagramme (neu gezeichnet) vergessen
  bind();
  return { id, attrs: focus ? `data-ct="${id}" tabindex="0" aria-describedby="ct-help"` : `data-ct="${id}"` };
}
/** Zusatzzeile für Stelle i eines gezeichneten Diagramms (z. B. Veranstaltung über der Stunde); erscheint im Tooltip unter den Reihen */
export function chartExtra(svg, i, row) {
  const sp = specOf(svg); if (!sp) return;
  (sp.extra ||= {}); (sp.extra[i] ||= []).push(row);
}
/** Knopf „Als Tabelle“ für ein angemeldetes Diagramm */
export const tableButton = (id) => `<button type="button" class="ct-tbl-btn" data-ct-table="${id}" aria-expanded="false">${esc(t('ct.asTable'))}</button>`;

const specOf = (svg) => SPECS.get(svg?.dataset?.ct);
function nearest(svg, sp, clientX) {
  const r = svg.getBoundingClientRect(), vb = svg.viewBox.baseVal, k = (vb?.width || r.width) / r.width, xv = (clientX - r.left) * k + (vb?.x || 0);
  let best = 0, bd = Infinity; for (let i = 0; i < sp.n; i++) { const d = Math.abs(sp.x(i) - xv); if (d < bd) { bd = d; best = i; } } return best;
}
function tipEl(svg) {
  const box = svg.parentElement; if (getComputedStyle(box).position === 'static') box.style.position = 'relative';
  let el = box.querySelector(':scope > .ct-tip'); if (!el) { el = document.createElement('div'); el.className = 'ct-tip'; el.setAttribute('role', 'status'); el.setAttribute('aria-live', 'polite'); box.appendChild(el); }
  return el;
}
function show(svg, i, pinned = ACTIVE.get(svg)?.pinned || false) {
  const sp = specOf(svg); if (!sp || !sp.n) return;
  i = Math.max(0, Math.min(sp.n - 1, i)); ACTIVE.set(svg, { i, pinned });
  const NS = svg.namespaceURI; // SVG-Namensraum vom Diagramm selbst (kein Host im Code)
  let xh = svg.querySelector('line.ct-xh'); if (!xh) { xh = document.createElementNS(NS, 'line'); xh.setAttribute('class', 'ct-xh'); svg.appendChild(xh); }
  const xv = sp.x(i); xh.setAttribute('x1', xv); xh.setAttribute('x2', xv); xh.setAttribute('y1', sp.top); xh.setAttribute('y2', sp.bottom); xh.style.visibility = 'visible';
  const rows = (sp.rows(i) || []).slice().sort((a, b) => (b.sort ?? -Infinity) - (a.sort ?? -Infinity)).concat(sp.extra?.[i] || []);
  const el = tipEl(svg);
  el.innerHTML = `<div class="hd">${esc(sp.head(i))}${pinned ? ` <span class="pin">${esc(t('ct.pinned'))}</span>` : ''}</div>${rows.map(r => `<div class="row">${r.color ? `<i style="background:${esc(r.color)}"></i>` : '<i class="none"></i>'}<span>${esc(r.label)}</span><b>${esc(r.value)}</b></div>`).join('')}`;
  el.hidden = false;
  const r = svg.getBoundingClientRect(), br = svg.parentElement.getBoundingClientRect(), vb = svg.viewBox.baseVal, k = r.width / (vb?.width || r.width);
  const px = r.left - br.left + (xv - (vb?.x || 0)) * k, w = el.offsetWidth, maxX = br.width - w - 4;
  el.style.left = `${Math.max(4, Math.min(maxX, px + 12 + w > br.width ? px - w - 12 : px + 12))}px`;
  el.style.top = `${Math.max(0, r.top - br.top + (sp.top - (vb?.y || 0)) * k)}px`;
}
function hide(svg, force = false) {
  const st = ACTIVE.get(svg); if (st?.pinned && !force) return;
  ACTIVE.delete(svg); const xh = svg.querySelector('line.ct-xh'); if (xh) xh.style.visibility = 'hidden';
  const el = svg.parentElement?.querySelector(':scope > .ct-tip'); if (el) el.hidden = true;
}
function tableHtml(sp) {
  const cols = sp.cols || (sp.rows(0) || []).map(r => r.label);
  const cell = sp.cell || ((i, k) => { const r = (sp.rows(i) || []).find(x => x.label === cols[k]); return r ? r.value : '–'; });
  const body = Array.from({ length: sp.n }, (_, i) => `<tr><th scope="row">${esc(sp.head(i))}</th>${cols.map((_, k) => `<td class="n">${esc(cell(i, k))}</td>`).join('')}</tr>`).join('');
  return `<div class="tbl ct-table" tabindex="0" role="region" aria-label="${esc(sp.label || t('ct.table'))}"><table><thead><tr><th scope="col">${esc(sp.colHead || '')}</th>${cols.map(c => `<th scope="col" class="n">${esc(c)}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table></div>`;
}
function bind() {
  if (bound || typeof document === 'undefined') return; bound = true;
  if (!document.getElementById('ct-help')) { const h = document.createElement('span'); h.id = 'ct-help'; h.hidden = true; h.textContent = t('ct.help'); document.body.appendChild(h); }
  const svgOf = (/** @type {any} */ e) => e.target?.closest?.('svg[data-ct]');
  document.addEventListener('pointermove', (e) => { const s = svgOf(e); if (!s || ACTIVE.get(s)?.pinned || e.pointerType === 'touch') return; const sp = specOf(s); if (sp) show(s, nearest(s, sp, e.clientX)); });
  document.addEventListener('pointerout', (e) => { const s = svgOf(e); if (s && !s.contains(e.relatedTarget)) hide(s); });
  document.addEventListener('click', (e) => {
    const b = /** @type {any} */ (e.target)?.closest?.('[data-ct-table]');
    if (b) { const sp = SPECS.get(b.dataset.ctTable); if (!sp) return; const open = b.getAttribute('aria-expanded') === 'true'; let tb = b.nextElementSibling?.classList.contains('ct-table') ? b.nextElementSibling : null;
      if (open) { tb?.remove(); b.setAttribute('aria-expanded', 'false'); b.textContent = t('ct.asTable'); } else { b.insertAdjacentHTML('afterend', tableHtml(sp)); b.setAttribute('aria-expanded', 'true'); b.textContent = t('ct.asChart'); } return; }
    const s = svgOf(e); if (!s) return; const sp = specOf(s); if (!sp) return;
    const st = ACTIVE.get(s), i = nearest(s, sp, e.clientX);
    if (st?.pinned && st.i === i) hide(s, true); else show(s, i, true); // Antippen hält fest, nochmal antippen löst
  });
  document.addEventListener('focusin', (e) => { const tg = /** @type {any} */ (e.target), s = tg?.matches?.('svg[data-ct]') ? tg : null; if (s) { const sp = specOf(s); if (sp) show(s, ACTIVE.get(s)?.i ?? sp.n - 1); } });
  document.addEventListener('focusout', (e) => { const tg = /** @type {any} */ (e.target), s = tg?.matches?.('svg[data-ct]') ? tg : null; if (s) hide(s, true); });
  document.addEventListener('keydown', (e) => {
    const tg = /** @type {any} */ (e.target), s = tg?.matches?.('svg[data-ct]') ? tg : null; if (!s) return; const sp = specOf(s); if (!sp) return;
    if (e.key === 'Escape') { hide(s, true); return; }
    const d = { ArrowRight: 1, ArrowLeft: -1, Home: -1e9, End: 1e9 }[e.key]; if (d == null) return;
    e.preventDefault(); show(s, (ACTIVE.get(s)?.i ?? sp.n - 1) + d);
  });
}
