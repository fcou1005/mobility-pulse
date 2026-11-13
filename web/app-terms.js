// Mobility Pulse — Begriffe (S4.8) und Erstbesuch-Karte „Wofür nutzen Sie Mobility Pulse?“ (S4.8/S5.6).
// Begriffe: eine Seite mit allen Fachwörtern der Kennzahlen; Erklärungen aus derselben Quelle wie die Glossar-Tooltips (GLOSS).
import { t } from './i18n.js';
import { $, GLOSS, esc } from './app-core.js';
import { ROLE_START } from './app-router.js';

// [Anker, Begriff (Schlüssel), Erklärung (GLOSS-Schlüssel oder Wörterbuch-Schlüssel)]
const TERMS = [
  ['bestand', 'terms.fleet', 'terms.fleetDef'], ['verfuegbar', 'terms.available', 'terms.availableDef'], ['gesperrt', 'terms.disabled', 'terms.disabledDef'],
  ['fahrt', 'terms.trip', 'terms.tripDef'], ['rvd', 'terms.rvd', 'gloss:rvd'], ['auslastung', 'terms.util', 'gloss:util'], ['umsetzung', 'terms.reloc', 'gloss:reloc'],
  ['akkutausch', 'terms.swap', 'gloss:rot'], ['abholung', 'terms.pickup', 'gloss:pickup'], ['zelle', 'terms.cell', 'gloss:cell'], ['leer', 'terms.empty', 'gloss:empty'],
  ['datenalter', 'terms.fresh', 'gloss:fresh'], ['messpunkt', 'terms.point', 'gloss:point'], ['luecke', 'terms.gap', 'gloss:gap'], ['quelle-aktuell', 'terms.sourceCurrent', 'terms.sourceCurrentDef'],
  ['kalibrierung', 'terms.calib', 'terms.calibDef'], ['plan', 'terms.plan', 'terms.planDef'], ['live-prognose', 'terms.live', 'terms.liveDef'], ['wie-gestern', 'terms.naive', 'terms.naiveDef'],
  ['abweichung', 'terms.wape', 'terms.wapeDef'], ['spot', 'terms.spot', 'terms.spotDef'], ['netto-abfluss', 'terms.outflow', 'terms.outflowDef'], ['soll', 'terms.target', 'terms.targetDef'],
  ['obergrenze', 'terms.cap', 'terms.capDef'], ['realisierung', 'terms.real', 'gloss:real'], ['wertung', 'terms.score', 'gloss:score'],
];
const def = (k) => (k.startsWith('gloss:') ? GLOSS[k.slice(6)] : t(k));

export function renderTerms() {
  const el = $('#terms'); if (!el) return;
  const list = TERMS.map(([id, term, d]) => [id, t(term), def(d)]).sort((a, b) => a[1].localeCompare(b[1], 'de'));
  el.innerHTML = list.map(([id, term, d]) => `<div class="term" id="b-${id}"><dt>${esc(term)}</dt><dd>${esc(d)}</dd></div>`).join('');
}

// Erstbesuch: einmal fragen, wofür die Seite genutzt wird; die Wahl setzt die Startansicht (gemerkt, ?rolle= im Link geht vor)
export function firstVisit() {
  const box = $('#first-visit'); if (!box) return;
  let seen = false; try { seen = !!localStorage.getItem('mp-rolle') || !!localStorage.getItem('mp-first-done'); } catch { seen = true; }
  if (seen || new URLSearchParams(location.search).has('rolle') || new URLSearchParams(location.search).has('embed')) { box.hidden = true; return; }
  box.innerHTML = `<p class="fv-q"><b>${esc(t('ux.firstQ'))}</b> ${esc(t('ux.firstSub'))}</p><div class="fv-roles">${Object.keys(ROLE_START).map(r => `<button type="button" data-role="${r}">${esc(t(`ux.role.${r}`))}</button>`).join('')}<button type="button" class="ghost" data-role="">${esc(t('ux.firstSkip'))}</button></div>`;
  box.hidden = false;
  box.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-role]'); if (!b) return;
    const r = b.dataset.role;
    try { if (r) localStorage.setItem('mp-rolle', r); localStorage.setItem('mp-first-done', '1'); } catch { /* ohne Speicher: nur diese Sitzung */ }
    box.hidden = true;
    if (r) location.hash = ROLE_START[r];
  });
}
