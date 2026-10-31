#!/usr/bin/env node
// Baut data/sources.json aus den öffentlichen Verzeichnissen.
// Läuft in GitHub Actions (voller Netzzugang); lokal fällt es auf data/cache/* zurück.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const CACHE = path.join(ROOT, 'data', 'cache');
const OUT = path.join(ROOT, 'data', 'sources.json');
const manual = JSON.parse(await readFile(path.join(ROOT, 'data', 'sources-manual.json'), 'utf8'));

const log = (...a) => console.error('[catalog]', ...a);

async function fetchText(url, cacheName, { timeout = 25000 } = {}) {
  const cacheFile = path.join(CACHE, cacheName);
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeout);
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'user-agent': 'mobility-pulse/1.0 (+github.com/fcou1005/mobility-pulse)' } });
    clearTimeout(t);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const txt = await r.text();
    await mkdir(CACHE, { recursive: true });
    await writeFile(cacheFile, txt);
    return { text: txt, fromCache: false };
  } catch (e) {
    if (existsSync(cacheFile)) {
      log(`${url}: ${e.message} → Cache ${cacheName}`);
      return { text: await readFile(cacheFile, 'utf8'), fromCache: true };
    }
    throw e;
  }
}

function parseCsv(text) {
  const rows = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const [head, ...body] = rows;
  return body.filter(r => r.length === head.length).map(r => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}

const excludeRe = manual.exclude_patterns.map(p => new RegExp(p, 'i'));
const isExcluded = (s) => {
  const parts = [s.id, s.name, (s.url || '').replace(/^https?:\/\//, '')].map(x => String(x || '').toLowerCase());
  return excludeRe.some(re => parts.some(p => re.test(p)));
};

function operatorFor(name, id) {
  const hay = `${name} ${id}`.toLowerCase();
  // längste Alias-Treffer zuerst
  const keys = Object.keys(manual.operator_aliases).sort((a, b) => b.length - a.length);
  for (const k of keys) if (hay.includes(k)) return manual.operator_aliases[k];
  const n = name.replace(/^Gebündelte Daten\s+/i, '').replace(/\s+NRW$/i, '');
  return n.split(/[\s·,-]/)[0] || id;
}

const sources = new Map(); // key: System-ID (Verzeichnisse teilen sich IDs) oder URL
const normUrl = (u) => (u || '').replace(/\/$/, '').replace(/\/gbfs\.json$/, '/gbfs');
const add = (s) => {
  s.priority ??= 2;
  const byId = sources.get(s.id);
  const byUrl = [...sources.values()].find(x => normUrl(x.url) === normUrl(s.url));
  const prev = byId || byUrl;
  if (prev) {
    prev.directories = [...new Set([...prev.directories, ...s.directories])];
    if (!prev.license && s.license) prev.license = s.license;
    if (s.priority < prev.priority) { // Landesfeed bevorzugt: dessen URL wird Hauptadresse
      prev.altUrls = [...new Set([...(prev.altUrls || []), prev.url])];
      prev.url = s.url; prev.priority = s.priority; prev.versions = s.versions;
    } else if (normUrl(s.url) !== normUrl(prev.url)) {
      prev.altUrls = [...new Set([...(prev.altUrls || []), s.url])];
    }
    if (!byId) sources.set(s.id, prev);
    return;
  }
  sources.set(s.id, s);
};

// 1) MobilityData systems.csv — alle DE-Systeme
{
  const { text, fromCache } = await fetchText('https://raw.githubusercontent.com/MobilityData/gbfs/master/systems.csv', 'systems.csv');
  const rows = parseCsv(text).filter(r => r['Country Code'] === 'DE');
  log(`MobilityData: ${rows.length} DE-Systeme${fromCache ? ' (Cache)' : ''}`);
  for (const r of rows) {
    const s = {
      id: r['System ID'], name: r['Name'], location: r['Location'], api: 'gbfs',
      url: r['Auto-Discovery URL'], versions: (r['Supported Versions'] || '').split(';').map(v => v.trim()).filter(Boolean),
      auth: r['Authentication Type'] ? { type: r['Authentication Type'], param: r['Authentication Parameter Name'] || null, info: r['Authentication Info URL'] || null } : null,
      directories: ['mobilitydata'], homepage: r['URL'] || null,
    };
    s.operator = operatorFor(s.name, s.id);
    if (isExcluded(s)) continue;
    if (s.auth && s.auth.type) { s.disabled = `Zugangsdaten erforderlich (${s.auth.type})`; }
    add(s);
  }
}

// 2) MobiData BW — Landesindex
{
  let systems = [];
  try {
    const { text, fromCache } = await fetchText('https://api.mobidata-bw.de/sharing/gbfs', 'mobidata-bw-index.json');
    systems = JSON.parse(text).systems || [];
    log(`MobiData BW: ${systems.length} Systeme${fromCache ? ' (Cache)' : ''}`);
  } catch (e) { log('MobiData BW Index nicht erreichbar:', e.message); }
  for (const sys of systems) {
    const id = sys.id;
    const s = { id, name: id.replace(/[_-]+/g, ' '), api: 'gbfs', url: sys.url || `https://api.mobidata-bw.de/sharing/gbfs/v2/${id}/gbfs`, versions: ['2.3'], auth: null, directories: ['mobidata_bw'], priority: 1 };
    s.operator = operatorFor(s.name, s.id);
    if (isExcluded(s)) continue;
    add(s);
  }
}

// 3) MOBIDROM NRW — CKAN, konflationierte GBFS-Feeds (OAuth-Dienstzugang laut Datensatzbeschreibung)
{
  try {
    const url = 'https://www.mobilitaetsdaten.nrw/api/ckan/api/3/action/package_search?q=systemadapter-gbfs-provider&rows=300';
    const { text, fromCache } = await fetchText(url, 'mobidrom-ckan.json');
    const res = JSON.parse(text).result;
    log(`MOBIDROM NRW: ${res.count} Datensätze${fromCache ? ' (Cache)' : ''}`);
    let tokenUrl = null, clientId = null;
    for (const ds of res.results) {
      const tags = (ds.tags || []).map(t => t.name);
      if (tags.some(t => /car.?sharing/i.test(t))) continue;
      const notes = ds.notes || '';
      tokenUrl ??= (notes.match(/https:\/\/www\.mobilitaetsdaten\.nrw\/keycloak\/realms\/[^\s`'")]+token/) || [])[0];
      clientId ??= (notes.match(/Client ID:\*\*\s*`?([\w-]+)/i) || [])[1];
      const resources = (ds.resources || []).filter(r => /systemadapter-gbfs-provider/.test(r.url || ''));
      const v2 = resources.find(r => /\/v2\.\d\//.test(r.url));
      const v3 = resources.find(r => /\/v3\.\d\//.test(r.url));
      const pick = v2 || v3;
      if (!pick) continue;
      const license = (resources.map(r => r.license_id).find(Boolean)) || ds.license_id || null;
      const s = {
        id: `mobidrom_${ds.name}`, name: ds.title || ds.name, api: 'gbfs', url: pick.url, versions: [v2 ? '2.3' : '3.0'],
        urlV3: v3?.url || null, auth: { type: 'oauth_client_credentials', tokenUrl: null, clientId: null, secret: 'ckan-notes', datasetUrl: `https://www.mobilitaetsdaten.nrw/api/ckan/dataset/${ds.name}` },
        directories: ['mobidrom_nrw'], license, tags, notesDataset: ds.name,
      };
      s.operator = operatorFor(s.name, s.id);
      if (isExcluded(s)) continue;
      add(s);
    }
    for (const s of sources.values()) if (s.auth?.type === 'oauth_client_credentials') { s.auth.tokenUrl = tokenUrl; s.auth.clientId = clientId; }
  } catch (e) { log('MOBIDROM nicht erreichbar:', e.message); }
}

// 4) CityBikes — deutsche Netze als Ergänzung (eigenes API-Format, geprüfte Zeitstempel)
{
  try {
    const { text, fromCache } = await fetchText('https://api.citybik.es/v2/networks', 'citybikes-networks.json');
    const nets = (JSON.parse(text).networks || []).filter(n => n.location?.country === 'DE');
    log(`CityBikes: ${nets.length} DE-Netze${fromCache ? ' (Cache)' : ''}`);
    for (const n of nets) {
      const s = {
        id: `citybikes_${n.id}`, name: n.name, location: n.location?.city || null, api: 'citybikes',
        url: `https://api.citybik.es/v2/networks/${n.id}`, gbfsHref: n.gbfs_href || null, company: n.company || [],
        directories: ['citybikes'], priority: 3, lat: n.location?.latitude, lon: n.location?.longitude,
      };
      s.operator = operatorFor(`${n.name} ${(n.company || []).join(' ')}`, n.id);
      if (isExcluded(s)) continue;
      add(s);
    }
  } catch (e) { log('CityBikes nicht erreichbar:', e.message); }
}

// 5) Dott — Direktfeeds (öffentliches Verzeichnis per Kandidaten-Prüfung; Treffer werden vom Sammler bestätigt)
for (const slug of manual.dott_direct_candidates) {
  const url = `https://gbfs.api.ridedott.com/public/v2/${slug}/gbfs.json`;
  if ([...sources.values()].some(s => normUrl(s.url) === normUrl(url))) continue;
  add({ id: `dott-${slug}`, name: `Dott ${slug}`, operator: 'Dott', api: 'gbfs', url, versions: ['2.3'], auth: null, directories: ['dott_direct'], candidate: true });
}

const list = [...new Set(sources.values())].sort((a, b) => a.operator.localeCompare(b.operator) || a.id.localeCompare(b.id));
const out = {
  generatedAt: new Date().toISOString(),
  count: list.length,
  directories: { mobilitydata: 'https://github.com/MobilityData/gbfs/blob/master/systems.csv', mobidata_bw: 'https://api.mobidata-bw.de/sharing/gbfs', mobidrom_nrw: 'https://www.mobilitaetsdaten.nrw/api/ckan/organization/angemeldet', citybikes: 'https://api.citybik.es/v2/networks', dott_direct: 'https://gbfs.api.ridedott.com/public/v2/' },
  known_gaps: manual.known_gaps,
  mobidata_wfs: manual.mobidata_wfs,
  sources: list,
};
await writeFile(OUT, JSON.stringify(out, null, 1));
log(`→ ${OUT}: ${list.length} Quellen (${[...new Set(list.map(s => s.operator))].length} Anbieter)`);
