// Sammler, Phase „start“ (S3.9: aus scripts/collect.mjs geschnitten; Ablauf und Zeitmessung in scripts/collect.mjs).
// ctx trägt, was Phasen voneinander brauchen; let-Werte stehen nur in ctx, Konstanten und Funktionen werden hier ausgepackt.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import * as C from '../../lib/pulse-core.js';
import * as T from '../../lib/pulse-track.js';
import * as SS from '../../lib/pulse-status.js';
import { createHmac, randomBytes } from 'node:crypto';

export async function run(ctx) {
  ctx.fetchJson = fetchJson;
  ctx.setupMobidrom = setupMobidrom;
  ctx.expandSource = expandSource;
  ctx.pool = pool;
  const ROOT = path.resolve(new URL('../..', import.meta.url).pathname);
  ctx.ROOT = ROOT;
  const DATA = process.env.DATA_DIR || path.join(ROOT, 'data');
  ctx.DATA = DATA;
  const now = Date.now();
  ctx.now = now;
  const log = (...a) => console.error('[collect]', ...a);
  ctx.log = log;
  const PH = SS.phaseClock(now); // S3.2: Zeit je Phase (status.json → phases)
  ctx.PH = PH;
  const CONCURRENCY = +process.env.CONCURRENCY || 8;
  const TIMEOUT = +process.env.FETCH_TIMEOUT || 20000;
  const MAX_BYTES = +process.env.MAX_BYTES || 40e6; // Obergrenze je Antwort
  const HISTORY_DAYS = +process.env.HISTORY_DAYS || 30;
  ctx.HISTORY_DAYS = HISTORY_DAYS;
  const HEALTH = { minShare: 0.9, minVehShare: 0.85 }; // Ausfall-Wächter: „fail“ unter 90 % der üblichen Zahl liefernder Quellen oder unter 85 % der üblichen Fahrzeugzahl (HEALTH_FILE)
  ctx.HEALTH = HEALTH;
  const UA = 'mobility-pulse/1.0 (+https://github.com/fcou1005/mobility-pulse)';
  ctx.UA = UA;
  // Verfolgungszustand: mit TRACK_DIR (privater Cache des Workflows) gesalzene HMAC-Schlüssel und kein out/track mehr;
  // ohne TRACK_DIR wie bisher (out/track, nachrechenbarer Hash) – so läuft der alte Workflow unverändert weiter.
  const TRACK_DIR = process.env.TRACK_DIR ? path.resolve(process.env.TRACK_DIR) : null;
  ctx.TRACK_DIR = TRACK_DIR;
  if (TRACK_DIR && (TRACK_DIR + path.sep).startsWith(path.resolve(DATA) + path.sep)) { console.error('[collect] TRACK_DIR liegt im veröffentlichten Datenverzeichnis – Abbruch'); process.exit(2); }
  ctx.hmac = null; ctx.keyId = null;
  if (TRACK_DIR) {
    await mkdir(TRACK_DIR, { recursive: true });
    const saltFile = path.join(TRACK_DIR, 'salt');
    let salt = existsSync(saltFile) ? (await readFile(saltFile, 'utf8')).trim() : '';
    if (!/^[0-9a-f]{64}$/.test(salt)) { salt = randomBytes(32).toString('hex'); await writeFile(saltFile, salt + '\n', { mode: 0o600 }); log('Track-Salt neu erzeugt'); }
    const key = Buffer.from(salt, 'hex');
    ctx.hmac = (s) => T.keyFromDigest(createHmac('sha256', key).update(s).digest());
    ctx.keyId = ctx.hmac('#mobility-pulse-key-check'); // passt der Zustand zum Salt? (sonst wären alle Kennungen „neu“ → Scheinfahrten)
  }
  const vkey = (operator, rawId) => T.vehicleKey(operator, rawId, ctx.hmac);
  ctx.vkey = vkey;
  const RULE = `${T.METHOD_VERSION}@${String(process.env.GITHUB_SHA || 'lokal').slice(0, 7)}`; // Regelstand je Lauf (events runs[k][3], runs.json)
  ctx.RULE = RULE;
  const catalog = JSON.parse(await readFile(process.env.SOURCES_FILE || path.join(DATA, 'sources.json'), 'utf8'));
  ctx.catalog = catalog;
  const manual = JSON.parse(await readFile(path.join(ROOT, 'data', 'sources-manual.json'), 'utf8'));
  ctx.manual = manual;
  const boundariesPath = process.env.BOUNDARIES || path.join(DATA, 'boundaries.json');
  ctx.index = null; ctx.boundaries = null;
  if (existsSync(boundariesPath)) {
    ctx.boundaries = JSON.parse(await readFile(boundariesPath, 'utf8'));
    ctx.index = C.buildMunicipalityIndex(ctx.boundaries);
    log(`Gemeindegrenzen: ${ctx.boundaries.features.length}`);
  } else log('WARNUNG: keine Gemeindegrenzen – Ortszuordnung entfällt');
  const prev = existsSync(path.join(DATA, 'latest.json')) ? JSON.parse(await readFile(path.join(DATA, 'latest.json'), 'utf8')) : null;
  ctx.prev = prev;
  const prevSources = new Map((prev?.sources || []).map(s => [s.id, s]));
  ctx.prevSources = prevSources;
  // ---------- HTTP ----------
  const authRules = []; // { host, path, headers }: Zugangsdaten nur an genau diesen Host (und Pfadpräfix)
  const authFor = (url) => { let u; try { u = new URL(url); } catch { return null; } const r = authRules.find(a => a.host === u.host && (!a.path || u.pathname.startsWith(a.path))); return r ? r.headers : null; };
  const corsByUrl = new Map(); // url → Access-Control-Allow-Origin
  ctx.corsByUrl = corsByUrl;
  // Antwort mit Obergrenze lesen (C.readLimited); der Timeout-Timer läuft bis zum Ende des Lesens
  async function fetchJson(url, { retry = 1 } = {}) {
    const t0 = Date.now();
    for (let attempt = 0; ; attempt++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
      try {
        let target = url, r;
        for (let hop = 0; ; hop++) {
          const auth = authFor(target);
          const headers = { 'user-agent': UA, accept: 'application/json', ...(auth || {}) };
          // mit Zugangsdaten Weiterleitungen selbst prüfen: nur zum selben Host folgen
          r = await fetch(target, { signal: ctrl.signal, headers, redirect: auth ? 'manual' : 'follow' });
          if (!auth || r.status < 300 || r.status >= 400) break;
          const loc = r.headers.get('location');
          if (!loc) break;
          await r.body?.cancel().catch(() => {});
          const next = new URL(loc, target);
          if (next.host !== new URL(target).host) throw Object.assign(new Error('Weiterleitung mit Zugangsdaten verweigert'), { final: true });
          if (hop >= 5) throw Object.assign(new Error('zu viele Weiterleitungen'), { final: true });
          target = next.href;
        }
        // 429/503: einmal nach Retry-After (höchstens 5 s, sonst 1,5 s) wiederholen – Yoio (rideatom) antwortet einzelne Teilfeeds mit 429, die ganze
        // Quelle fiel dann für den Lauf aus (Erfurt 07.11.2026: 214 → 0). Nicht bei api.citybik.es: dort zählt jeder Abruf gegen das Kontingent.
        if ((r.status === 429 || r.status === 503) && attempt < retry && !/(^|\.)citybik\.es$/.test(new URL(target).host)) {
          const ra = Number(r.headers.get('retry-after')); await r.body?.cancel().catch(() => {}); clearTimeout(timer);
          await new Promise(res => setTimeout(res, Math.min(5000, ra > 0 ? ra * 1000 : 1500))); continue;
        }
        corsByUrl.set(url, r.headers.get('access-control-allow-origin'));
        let json = null, error = null;
        if (r.ok) { try { json = C.parseJsonSafe(await C.readLimited(r, MAX_BYTES)); } catch (e) { error = e.message === 'Antwort zu groß' ? e.message : e.name === 'AbortError' ? 'Timeout' : 'kein JSON'; } }
        else await r.body?.cancel().catch(() => {});
        clearTimeout(timer);
        return { ok: r.ok && !!json, status: r.status, json, error, latencyMs: Date.now() - t0 };
      } catch (e) {
        clearTimeout(timer);
        if (attempt < retry && !e.final) continue;
        return { ok: false, status: 0, json: null, error: e.name === 'AbortError' ? 'Timeout' : (e.cause?.code || e.message), latencyMs: Date.now() - t0 };
      }
    }
  }
  // MOBIDROM: OAuth-Dienstzugang (Client-Credentials laut öffentlicher Datensatzbeschreibung)
  async function setupMobidrom(sources) {
    const s = sources.find(x => x.auth?.type === 'oauth_client_credentials' && x.auth.datasetUrl);
    if (!s) return;
    try {
      const name = s.notesDataset;
      const r = await fetchJson(`https://www.mobilitaetsdaten.nrw/api/ckan/api/3/action/package_show?id=${encodeURIComponent(name)}`);
      const notes = r.json?.result?.notes || '';
      const secret = (notes.match(/Client Secret:\*\*\s*`?([^`\s<]+)/i) || notes.match(/client_secret[=:]\s*`?([^`\s<&'"]+)/i) || [])[1];
      const tokenUrl = s.auth.tokenUrl || (notes.match(/https:\/\/www\.mobilitaetsdaten\.nrw\/keycloak\/realms\/[^\s`'")]+token/) || [])[0];
      const clientId = s.auth.clientId || (notes.match(/Client ID:\*\*\s*`?([\w-]+)/i) || [])[1] || 'gbfs-api';
      if (!secret || !tokenUrl) { log('MOBIDROM: Zugangsdaten nicht in CKAN-Notes gefunden'); return; }
      const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: secret });
      const tr = await fetch(tokenUrl, { method: 'POST', body, headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': UA }, redirect: 'error' }); // Geheimnis folgt keiner Weiterleitung
      const tok = await tr.json().catch(() => null);
      if (!tr.ok || !tok?.access_token) { log('MOBIDROM: Token fehlgeschlagen', tr.status); return; }
      authRules.push({ host: new URL(s.url).host, path: '/api/systemadapter', headers: { authorization: `Bearer ${tok.access_token}` } });
      log('MOBIDROM: Token erhalten');
    } catch (e) { log('MOBIDROM: ', e.message); }
  }
  // Header-Zugänge (z. B. DB API Marketplace) aus Umgebungsvariablen
  for (const [key, cfg] of Object.entries(catalog.auth_sources || {})) {
    if (!cfg.env.every(e => process.env[e])) continue;
    authRules.push({ host: cfg.host, path: cfg.path || null, headers: Object.fromEntries(Object.entries(cfg.headers).map(([h, e]) => [h, process.env[e]])) });
    log(`Zugang ${key}: aktiv`);
  }
  // Manifest / Sammelindex in Einzelsysteme auflösen
  async function expandSource(src) {
    if (src.api !== 'gbfs') return [src];
    if (!/manifest\.json$|systems\.json$/.test(src.url)) return [src];
    const r = await fetchJson(src.url);
    if (!r.ok) return [{ ...src, _probe: r }];
    const d = r.json?.data;
    const out = [];
    const datasets = d?.datasets || d?.systems || (Array.isArray(r.json?.systems) ? r.json.systems : null) || (Array.isArray(r.json) ? r.json : null);
    if (!datasets) return [src];
    for (const ds of datasets) {
      const sysId = ds.system_id || ds.id || ds.system || ds.name;
      const url = ds.versions?.slice().sort((a, b) => String(b.version).localeCompare(String(a.version)))?.[0]?.url || ds.url || ds.gbfs_url || ds.auto_discovery_url;
      if (!url) continue;
      out.push({ ...src, id: `${src.id}:${sysId}`, name: `${src.name} · ${sysId}`, url, parent: src.id });
    }
    return out.length ? out : [src];
  }
  async function pool(items, worker, n = CONCURRENCY) {
    const results = new Array(items.length); let i = 0;
    await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; results[k] = await worker(items[k], k); } }));
    return results;
  }
}
