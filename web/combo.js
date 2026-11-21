// Suchfeld für lange Auswahllisten (Gebiet, Anbieter, Gemeinde der Ströme; 14.11.2026): Tippen filtert die Liste, Pfeiltasten und Enter
// oder Klick wählen, Escape stellt die bisherige Wahl wieder her. Das <select> bleibt die Quelle der Wahrheit (Werte, change-Ereignisse,
// bestehende Listener, Setzen per Code) und ist nur verdeckt. Muster: ARIA 1.2 Combobox mit Listbox und aria-activedescendant.
import { t } from './i18n.js';

/** Vergleichsform: klein, ohne Akzente, ß → ss (Tübingen = tubingen, Straße = strasse) */
export const fold = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ß/g, 'ss');
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const MAX = 300; // so viele Treffer werden gezeichnet; den Rest kündigt die Liste an

/** @typedef {{ value: string, text: string, group: string, disabled: boolean, el: HTMLOptionElement }} ComboItem */

/** Treffer: jedes Wort steht im Text oder in der Gruppe (Land); zuerst Anfang des Namens, dann Wortanfang, dann irgendwo. null = keine Suche */
export function matchOptions(/** @type {ComboItem[]} */ items, /** @type {string} */ q) {
  const toks = fold(q).split(/[\s,]+/).filter(Boolean);
  if (!toks.length) return null;
  const word = new RegExp(`(^|[\\s(/-])${escRe(toks[0])}`);
  /** @type {Array<[number, ComboItem]>} */ const out = [];
  for (const it of items) {
    if (it.disabled) continue;
    const txt = fold(it.text), hay = `${txt} ${fold(it.group)}`;
    if (toks.every(k => hay.includes(k))) out.push([txt.startsWith(toks[0]) ? 0 : word.test(txt) ? 1 : 2, it]);
  }
  return out.sort((a, b) => a[0] - b[0]).map(x => x[1]);
}

let seq = 0;
/** Macht aus einem <select> ein Suchfeld mit Liste; mehrfacher Aufruf ist harmlos */
export function searchable(/** @type {HTMLSelectElement | null} */ sel) {
  if (!sel || sel.dataset.combo) return;
  sel.dataset.combo = '1';
  const id = `combo${++seq}`, wrap = document.createElement('span'), input = document.createElement('input');
  const pop = document.createElement('div'), list = document.createElement('div'), note = document.createElement('div'), live = document.createElement('span');
  wrap.className = 'combo';
  // Suchfeld statt Textfeld (21.11.2026): Safari bot am Mac im Feld „Gebiet“ Kontakte zum automatischen Ausfüllen an und übergeht dabei
  // autocomplete="off"; für type="search" und einen Namen mit „search“ füllt es nicht aus. Die data-Attribute halten Passwort-Manager fern.
  Object.assign(input, { type: 'search', id: `${id}-in`, name: `${id}-search`, autocomplete: 'off', spellcheck: false, placeholder: t('combo.placeholder') });
  input.dataset.i18nPlaceholder = 'combo.placeholder';
  for (const [k, v] of [['role', 'combobox'], ['aria-autocomplete', 'list'], ['aria-expanded', 'false'], ['aria-controls', `${id}-list`], ['autocapitalize', 'off'], ['autocorrect', 'off'], ['data-1p-ignore', ''], ['data-lpignore', 'true'], ['data-form-type', 'other']]) input.setAttribute(k, v);
  pop.className = 'combo-pop'; pop.hidden = true;
  list.id = `${id}-list`; list.setAttribute('role', 'listbox');
  note.className = 'combo-note';
  live.className = 'vh'; live.setAttribute('role', 'status');
  pop.append(list, note); wrap.append(input, pop, live);
  sel.before(wrap);
  sel.classList.add('vh'); sel.tabIndex = -1; sel.setAttribute('aria-hidden', 'true');

  /** @type {ComboItem[]} */ let shown = [];
  let active = -1, open = false, query = '';
  // Name der Liste = Text der Beschriftung ohne die Bedienelemente (Gebiet, Anbieter, Gemeinde); bei jedem Öffnen neu (Sprachwechsel)
  const labelText = () => { const l = sel.closest('label'); return l ? [...l.childNodes].filter(n => !(n instanceof Element && n.matches('select, .combo'))).map(n => n.textContent).join(' ').replace(/\s+/g, ' ').trim() : ''; };
  const cur = () => sel.selectedOptions[0] || null;
  const sync = () => {
    if (!open) input.value = cur()?.textContent?.trim() || '';
    input.title = sel.title || ''; input.disabled = sel.disabled;
  };
  const items = () => [...sel.querySelectorAll('option')].map(o => ({ value: o.value, text: (o.textContent || '').trim(), group: o.parentElement instanceof HTMLOptGroupElement ? o.parentElement.label : '', disabled: o.disabled, el: o }));
  const optEl = (i) => /** @type {HTMLElement | null} */ (list.querySelector(`[data-i="${i}"]`));
  const setActive = (i, scroll = true) => {
    optEl(active)?.classList.remove('active');
    active = i;
    const el = optEl(i);
    if (!el) { input.removeAttribute('aria-activedescendant'); return; }
    el.classList.add('active'); input.setAttribute('aria-activedescendant', el.id);
    if (!scroll) return;
    const top = el.offsetTop, bot = top + el.offsetHeight;
    if (top < pop.scrollTop) pop.scrollTop = top - 4; else if (bot > pop.scrollTop + pop.clientHeight) pop.scrollTop = bot - pop.clientHeight + 4;
  };
  const render = () => {
    const all = items(), hits = matchOptions(all, query), frag = document.createDocumentFragment();
    shown = [];
    const add = (/** @type {ComboItem} */ it, /** @type {Node} */ parent, withGroup) => {
      const d = document.createElement('div'), s = document.createElement('span');
      d.id = `${id}-o${shown.length}`; d.className = 'combo-opt'; d.dataset.i = String(shown.length);
      d.setAttribute('role', 'option'); d.setAttribute('aria-selected', String(it.el.selected));
      s.textContent = it.text; d.append(s);
      if (withGroup && it.group) { const g = document.createElement('small'); g.textContent = it.group; d.append(' ', g); }
      shown.push(it); parent.appendChild(d);
    };
    if (!hits) { // ohne Suche die ganze Liste wie im <select>, mit den Ländern als Zwischenüberschrift
      let grp = null; /** @type {HTMLElement | null} */ let box = null;
      for (const it of all) {
        if (it.disabled) continue;
        if (it.group !== grp) {
          grp = it.group; box = null;
          if (grp) { box = document.createElement('div'); box.setAttribute('role', 'group'); box.setAttribute('aria-label', grp); const h = document.createElement('div'); h.className = 'combo-grp'; h.setAttribute('aria-hidden', 'true'); h.textContent = grp; box.append(h); frag.append(box); }
        }
        add(it, box || frag, false);
      }
    } else for (const it of hits.slice(0, MAX)) add(it, frag, true);
    list.replaceChildren(frag); list.hidden = !shown.length; list.setAttribute('aria-label', labelText());
    const off = all.filter(i => i.disabled && i.text && i.text !== '–').map(i => i.text).join(' ');
    note.textContent = hits && !hits.length ? t('combo.none', { q: query.trim() }) : hits && hits.length > MAX ? t('combo.more', { n: hits.length - MAX }) : hits ? '' : off;
    note.hidden = !note.textContent;
    live.textContent = hits ? t('combo.count', { n: hits.length }) : '';
    if (hits) { pop.scrollTop = 0; setActive(shown.length ? 0 : -1); }
    else { const i = shown.findIndex(it => it.el.selected); setActive(i, false); const el = optEl(i); pop.scrollTop = el ? Math.max(0, el.offsetTop - pop.clientHeight / 2) : 0; }
  };
  const show = () => {
    if (open || input.disabled) return;
    open = true; pop.hidden = false; input.setAttribute('aria-expanded', 'true');
    pop.style.left = ''; pop.style.right = '';
    const r = pop.getBoundingClientRect(); if (r.right > window.innerWidth - 8) { pop.style.left = 'auto'; pop.style.right = '0'; }
  };
  const hide = () => {
    if (!open) return;
    open = false; pop.hidden = true; input.setAttribute('aria-expanded', 'false'); setActive(-1); live.textContent = '';
  };
  const start = () => { query = ''; show(); render(); };
  const choose = (i) => {
    const it = shown[i]; if (!it) return;
    hide(); input.value = it.text;
    if (sel.value !== it.value) { sel.value = it.value; sel.dispatchEvent(new Event('change', { bubbles: true })); }
  };
  const move = (d) => { if (!shown.length) return; setActive(Math.max(0, Math.min(shown.length - 1, (active < 0 ? (d > 0 ? -1 : shown.length) : active) + d))); };

  input.addEventListener('focus', () => input.select());
  input.addEventListener('click', () => { if (!open) start(); });
  input.addEventListener('input', () => { query = input.value; show(); render(); });
  input.addEventListener('keydown', (e) => {
    const k = e.key;
    if (k === 'ArrowDown' || k === 'ArrowUp') { e.preventDefault(); if (!open) start(); else move(k === 'ArrowDown' ? 1 : -1); }
    else if ((k === 'PageDown' || k === 'PageUp') && open) { e.preventDefault(); move(k === 'PageDown' ? 10 : -10); }
    else if (k === 'Enter' && open) { e.preventDefault(); if (active >= 0) choose(active); }
    else if (k === 'Escape' && open) { e.preventDefault(); e.stopPropagation(); hide(); sync(); input.select(); }
    else if (k === 'Tab') { hide(); sync(); }
  });
  input.addEventListener('blur', () => { hide(); sync(); });
  pop.addEventListener('mousedown', (e) => e.preventDefault()); // Fokus bleibt im Feld, die Liste bleibt offen bis zur Wahl
  pop.addEventListener('click', (e) => { e.preventDefault(); const o = /** @type {Element} */ (e.target).closest('[role="option"]'); if (o instanceof HTMLElement) choose(+(o.dataset.i || -1)); }); // preventDefault: kein Klick der Beschriftung aufs Feld
  list.addEventListener('mousemove', (e) => { const o = /** @type {Element} */ (e.target).closest('[role="option"]'); if (o instanceof HTMLElement && +(o.dataset.i || -1) !== active) setActive(+(o.dataset.i || -1), false); });

  // Wert per Code gesetzt (Link, Router, Neuaufbau der Liste) → Text im Feld nachziehen
  const proto = HTMLSelectElement.prototype;
  for (const key of ['value', 'selectedIndex']) {
    const d = Object.getOwnPropertyDescriptor(proto, key);
    if (d?.get && d.set) Object.defineProperty(sel, key, { configurable: true, get() { return d.get.call(sel); }, set(v) { d.set.call(sel, v); sync(); } });
  }
  sel.addEventListener('change', sync);
  new MutationObserver(() => { if (open) render(); sync(); }).observe(sel, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['disabled', 'title', 'label', 'selected'] });
  sync();
}
