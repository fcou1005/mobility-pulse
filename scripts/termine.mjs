// Workflow „Termine“ (Vorlage scripts/termine-workflow.yml): Quellenseiten aus data/termin-quellen.json lesen und künftige Termine herausziehen
// (lib/pulse-termine.js) → termine.json (Branch termine; der Sammler liest sie über TERMINE_URL).
// Aufruf: node scripts/termine.mjs <termin-quellen.json> <termine-vorher.json | -> <termine.json>
// Umgebung: LLM_URL = llama-server (OpenAI-kompatibel, z. B. http://127.0.0.1:8080); ohne LLM_URL oder mit TERMINE_FAKE=1 nur Regeln (schema.org,
// Kalender-Blöcke, einfache Textregel). RENDER=1: Quellen mit statisch: false per Chromium (Playwright) darstellen. MAX_MIN: Zeitbudget (Standard 170);
// wer nicht drankommt, behält seine bisherigen Termine und ist im nächsten Lauf zuerst dran. ONLY: nur diese Quellen-IDs (Komma).
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as TM from '../lib/pulse-termine.js';
import { robotsAllowed } from '../lib/pulse-context.js';
import { dayOf } from '../lib/pulse-track.js';

const [qf, pf, out] = process.argv.slice(2);
if (!qf || !out) { console.error('Aufruf: node scripts/termine.mjs <termin-quellen.json> <termine-vorher.json | -> <termine.json>'); process.exit(2); }
const UA = 'mobility-pulse/1.0 (+https://github.com/fcou1005/mobility-pulse)', now = Date.now(), today = dayOf(now), t0 = Date.now();
const budget = (+process.env.MAX_MIN || 170) * 60e3, only = new Set(String(process.env.ONLY || '').split(',').filter(Boolean));
let llmUrl = process.env.TERMINE_FAKE === '1' ? '' : (process.env.LLM_URL || '').replace(/\/$/, ''), llmFails = 0, llmCalls = 0;
const log = (...a) => console.log('[termine]', ...a);

const { ok: all, bad } = TM.checkSources(JSON.parse(await readFile(qf, 'utf8')));
if (bad.length) log(`${bad.length} Quellen fehlerhaft: ${bad.slice(0, 5).join('; ')}`);
const prevDoc = pf && pf !== '-' && existsSync(pf) ? await readFile(pf, 'utf8').then(s => { try { return JSON.parse(s); } catch { return null; } }) : null;
const prevQ = new Map((prevDoc?.quellen || []).map(x => [x.id, x]));
// zuerst, was am längsten nicht gelesen wurde
const sources = all.filter(q => !only.size || only.has(q.id)).sort((a, b) => (prevQ.get(a.id)?.at || 0) - (prevQ.get(b.id)?.at || 0) || a.id.localeCompare(b.id));

const get = async (url, ms, accept) => { const c = new AbortController(), tm = setTimeout(() => c.abort(), ms); try { return await fetch(url, { headers: { 'User-Agent': UA, accept, 'accept-language': 'de-DE,de;q=0.9' }, signal: c.signal, redirect: 'follow' }); } finally { clearTimeout(tm); } };
const robots = new Map();
async function allowed(u) {
  const x = new URL(u); if (!robots.has(x.origin)) { let txt = ''; try { const r = await get(`${x.origin}/robots.txt`, 10e3, 'text/plain'); if (r.ok) txt = (await r.text()).slice(0, 50e3); } catch {} robots.set(x.origin, txt); }
  return robotsAllowed(robots.get(x.origin), x.pathname + x.search);
}
let browser = null;
async function render(url) {
  if (!browser) { let pw; try { pw = await import('playwright'); } catch { pw = createRequire(import.meta.url)('playwright'); } browser = await pw.chromium.launch(); } // global installiert: require (NODE_PATH)
  const page = await browser.newPage({ userAgent: UA, locale: 'de-DE' });
  try { await page.goto(url, { waitUntil: 'networkidle', timeout: 45e3 }).catch(() => {}); await page.waitForTimeout(1500); return await page.content(); } finally { await page.close(); }
}
async function llm(messages) {
  const c = new AbortController(), tm = setTimeout(() => c.abort(), 6 * 60e3); llmCalls++;
  try {
    const r = await fetch(`${llmUrl}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: c.signal,
      body: JSON.stringify({ messages, temperature: 0, max_tokens: TM.TERMINE.maxTokens, response_format: { type: 'json_schema', json_schema: { name: 'termine', schema: TM.TERMIN_SCHEMA } } }) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json(), txt = j?.choices?.[0]?.message?.content || '';
    llmFails = 0; return TM.parseLlm(txt);
  } catch (e) { if (++llmFails >= 3) { log(`Sprachmodell antwortet nicht (${e?.message || e}) – weiter nur mit Regeln`); llmUrl = ''; } throw e; } finally { clearTimeout(tm); }
}

const results = [], states = [];
for (const q of sources) {
  const st = { id: q.id, name: q.name, url: q.url, ags: q.ags, art: q.art }, ts = Date.now();
  if (Date.now() - t0 > budget) { states.push({ ...prevQ.get(q.id), ...st, status: 'nicht dran (Zeit)' }); results.push({ q, ok: false, entries: [] }); continue; }
  try {
    if (!(await allowed(q.url))) throw Object.assign(new Error('robots.txt verbietet den Abruf'), { robots: true });
    // Abruf; scheitert er (manche Seiten lehnen einfache Abrufe ab) oder steht kein Datum im Text (Termine per JavaScript), mit Chromium darstellen
    const canRender = process.env.RENDER === '1' && q.format !== 'ics';
    let body = '', rendered = false;
    try { const r = await get(q.url, 30e3, q.format === 'ics' ? 'text/calendar' : 'text/html'); if (!r.ok) throw new Error(`HTTP ${r.status}`); body = (await r.text()).slice(0, 4e6); }
    catch (e) { if (!canRender) throw e; log(`${q.name}: ${e?.message || e} – Darstellung mit Chromium`); body = ''; }
    const noDates = (b) => !TM.dateChunks(TM.pageLines(b)).length && !TM.ldTermine(b, q.url).length;
    if (canRender && (q.statisch === false || !body || noDates(body))) { try { const h = await render(q.url); if (h && (!body || !noDates(h) || q.statisch === false)) { body = h; rendered = true; } } catch (e) { log(`${q.name}: Darstellung fehlgeschlagen (${e?.message || e})`); if (!body) throw e; } }
    const why = {}, accepted = [], beispiele = []; let chunks = 0, antworten = 0;
    // Diagnose: je Quelle Zahl der Ausschnitte und Modell-Antworten, die ersten zwei verworfenen Datumsangaben (nur Datum, Grund)
    const take = (t, chunk) => { const c = TM.checkTermin(t, q, chunk, today); if (c.ok) accepted.push(t); else { why[c.why] = (why[c.why] || 0) + 1; if (beispiele.length < 2) beispiele.push({ datum: String(t?.datumText || '').slice(0, 60), beginn: t?.beginn, ende: t?.ende, grund: c.why }); } };
    let via = 'regel';
    for (const t of TM.ruleTermine(body, q)) take(t, null);
    if (!accepted.length) {
      const lines = TM.pageLines(body);
      if (llmUrl) {
        via = 'modell';
        for (const chunk of TM.dateChunks(lines)) {
          if (Date.now() - t0 > budget || !llmUrl) break;
          chunks++;
          try { const got = await llm(TM.llmMessages(q, chunk, today)); antworten += got.length; for (const t of got) take(t, chunk); } catch (e) { why[`Modell: ${String(e?.message || e).slice(0, 40)}`] = (why[`Modell: ${String(e?.message || e).slice(0, 40)}`] || 0) + 1; }
        }
      }
      if (!accepted.length && !llmUrl) { via = 'textregel'; for (const t of TM.textTermin(lines, q, today)) take(t, t.datumText); }
    }
    // gleiche Termine (Titel und Beginn) nur einmal, höchstens maxPerSource
    const seen = new Set(), uniq = accepted.filter(t => { const k = `${TM.norm(t.titel)}|${t.beginn}`; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, TM.TERMINE.maxPerSource);
    const entries = uniq.flatMap(t => TM.terminEntries(t, q, { stand: today, via, from: today }));
    results.push({ q, ok: true, entries });
    states.push({ ...st, at: now, status: 'ok', via, ...(rendered ? { dargestellt: true } : {}), termine: uniq.length, tage: entries.length, zeilen: TM.pageLines(body).length, ...(via === 'modell' ? { ausschnitte: chunks, antworten } : {}), ...(Object.keys(why).length ? { verworfen: why, beispiele } : {}), sek: Math.round((Date.now() - ts) / 1000) });
    log(`${q.name}: ${uniq.length} Termine (${via}${rendered ? ', dargestellt' : ''}${via === 'modell' ? `, ${chunks} Ausschnitte, ${antworten} Antworten` : ''})${Object.keys(why).length ? `, verworfen ${JSON.stringify(why)} ${JSON.stringify(beispiele)}` : ''}`);
  } catch (e) {
    results.push({ q, ok: false, entries: [] });
    states.push({ ...prevQ.get(q.id), ...st, at: now, status: 'fehler', fehler: String(e?.message || e).slice(0, 100) });
    log(`${q.name}: ${e?.message || e}`);
  }
}
if (browser) await browser.close().catch(() => {});
const termine = TM.mergeTermine(prevDoc, results, { now });
await writeFile(out, JSON.stringify({ version: 1, v: TM.TERMINE.version, at: now, modell: llmCalls ? TM.TERMINE.model : 'ohne Sprachmodell (nur Regeln)', modellAufrufe: llmCalls,
  quelle: 'offizielle Seiten aus data/termin-quellen.json (je Termin verlinkt), gelesen im Workflow „Termine“; robots.txt beachtet',
  felder: 'termine[]: Einträge wie data/ereignisse.json (art veranstaltung | volksfest, kategorie = Art der Quelle, via = regel | modell | textregel, quelleId)',
  sek: Math.round((Date.now() - t0) / 1000), quellen: states.sort((a, b) => a.id.localeCompare(b.id)), fehlerhaft: bad, termine }, null, 1));
log(`${termine.length} Einträge (${results.filter(r => r.ok).length}/${sources.length} Quellen gelesen, ${llmCalls} Modellaufrufe, ${Math.round((Date.now() - t0) / 1000)} s)`);
