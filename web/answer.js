// Mobility Pulse — Antwort-Komponente (S4.1): oben in jeder Hauptansicht genau eine Antwort, bevor das erste Diagramm kommt.
// Ein Satz mit Verb vorn, genau drei Kennzahlen mit Vergleichswert, Klappe „Wie gerechnet?“, Stand-Zeile.
//   answerHtml({ id, sentence, kpis: [{ label, value, cmp, tone?, n?, eq? } × 3], how, asOf })
// sentence und how sind fertiges HTML (Aufrufer escapen Nutzdaten); label/value/cmp werden hier escaped.
// n: Zahl hinter value (für den Test „Antwortwert = Tabellenwert“); eq: Selektor auf die Tabellenzelle/-spalte mit derselben Zahl,
// eqSum: true = Summe der Spalte (eq trifft dann alle Zellen der Spalte).
import { t } from './i18n.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** @param {{ id: string, sentence: string, kpis: Array<{ label: string, value: string, cmp?: string, tone?: string, n?: number|null, eq?: string, eqSum?: boolean }>, how?: string, asOf?: string }} a */
export function answerHtml({ id, sentence, kpis, how = '', asOf = '' }) {
  const k = (kpis || []).slice(0, 3);
  while (k.length < 3) k.push({ label: '', value: '–', cmp: t('ans.noValue') }); // genau drei: fehlende Werte sichtbar als „–“
  const kpi = (x) => `<div class="ans-kpi${x.tone ? ` ${esc(x.tone)}` : ''}"${x.eq ? ` data-eq="${esc(x.eq)}"${x.eqSum ? ' data-eq-sum="1"' : ''}` : ''}><dt>${esc(x.label)}</dt><dd class="ans-v"${Number.isFinite(x.n) ? ` data-n="${x.n}"` : ''}>${esc(x.value)}</dd>${x.cmp ? `<dd class="ans-cmp">${esc(x.cmp)}</dd>` : ''}</div>`;
  return `<section class="answer" data-answer="${esc(id)}" aria-label="${esc(t('ans.aria'))}"><p class="ans-s">${sentence}</p><dl class="ans-k">${k.map(kpi).join('')}</dl>`
    + `${how ? `<details class="ans-how"><summary>${esc(t('ans.how'))}</summary><div class="ans-how-b">${how}</div></details>` : ''}`
    + `${asOf ? `<p class="ans-asof">${esc(t('ans.asOf', { at: asOf }))}</p>` : ''}</section>`;
}

/** Antwort in ein Element setzen; die Klappe bleibt offen, wenn sie es vorher war */
export function setAnswer(el, a) {
  if (!el) return;
  const open = el.querySelector('details.ans-how')?.open;
  el.innerHTML = answerHtml(a);
  if (open) { const d = el.querySelector('details.ans-how'); if (d) d.open = true; }
}

/** Platz der Antwort in der Ansicht: direkt unter der Überschrift (.view-answer), damit sie auf dem Handy im ersten Bildschirm steht */
export const viewSlot = (el) => el?.closest?.('.view')?.querySelector(':scope > .view-answer') || null;
/** Antwort in den Platz der Ansicht setzen und '' liefern; ohne Platz (eingebettet, Druck) das HTML zum Einsetzen */
export function putAnswer(el, a) { const slot = viewSlot(el); if (slot) { setAnswer(slot, a); return ''; } return answerHtml(a); }
/** Platz leeren (Ansicht ohne Antwort, z. B. keine Gemeinde gewählt) */
export function clearAnswer(el) { const slot = viewSlot(el); if (slot) slot.innerHTML = ''; }
/** Antwort für „noch keine Daten“: Satz mit Grund, drei leere Kennzahlen */
export const answerEmpty = (id, sentence) => answerHtml({ id, sentence, kpis: [] });
