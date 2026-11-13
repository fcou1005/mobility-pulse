// Sammler, Phase „abruf“ (S3.9: aus scripts/collect.mjs geschnitten; Ablauf und Zeitmessung in scripts/collect.mjs).
// ctx trägt, was Phasen voneinander brauchen; let-Werte stehen nur in ctx, Konstanten und Funktionen werden hier ausgepackt.
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import * as C from '../../lib/pulse-core.js';
import { gzipSync, gunzipSync } from 'node:zlib';

export async function run(ctx) {
  const { TRACK_DIR, catalog, expandSource, fetchJson, log, now, pool, prevSources, setupMobidrom } = ctx;
  // ---------- Abruf ----------
  const active = catalog.sources.filter(s => !s.disabled);
  await setupMobidrom(active);
  const expanded = (await pool(active, expandSource, 6)).flat();
  log(`Quellen: ${active.length} → ${expanded.length} Systeme`);
  // CityBikes-Kopien (Status duplicate im vorigen Lauf) nur alle CB_RECHECK_MS neu abrufen: api.citybik.es antwortet ab etwa 50 Abrufen je Lauf
  // mit 429 (07.11.2026: 17 von 68 Netzen), darunter Netze ohne andere Quelle; Kopien zählen ohnehin nicht. Status und Verweis bleiben aus dem vorigen Lauf,
  // solange das Original im vorigen Lauf lieferte (fällt es aus, wird die Kopie wieder abgerufen und kann zählen).
  const CB_RECHECK_MS = 2 * 3600e3;
  // CityBikes (9.11.2026: weiter 12 Netze je Lauf mit HTTP 429, sprintrad in 288 von 625 Läufen): Abrufe nacheinander mit Abstand CB_GAP_MS statt
  // im Pulk; scheitert ein Netz (429, 5xx, Zeitüberschreitung), gilt der letzte gute Abruf bis CB_CACHE_MS weiter (privat in TRACK_DIR, nicht
  // veröffentlicht). Die Frische kommt aus den Zeitstempeln der Stationen: ein 20 Min. alter Stand gilt als verzögert, zählt aber.
  const CB_GAP_MS = process.env.CB_GAP_MS != null ? +process.env.CB_GAP_MS : 1200, CB_CACHE_MS = 45 * 60e3;
  const cbCacheFile = TRACK_DIR ? path.join(TRACK_DIR, 'citybikes-cache.json.gz') : null;
  const cbCache = await (async () => { if (!cbCacheFile || !existsSync(cbCacheFile)) return {}; try { return JSON.parse(gunzipSync(await readFile(cbCacheFile)).toString('utf8')); } catch { return {}; } })();
  const fetchSource = async (src) => {
    try {
      if (src._probe) return { src, sys: null, probe: src._probe };
      if (src.api === 'citybikes') { const p = prevSources.get(src.id); if (p?.status === 'duplicate' && p.duplicateOf && p.dupCheckedAt && now - p.dupCheckedAt < CB_RECHECK_MS && ['live', 'delayed'].includes(prevSources.get(p.duplicateOf)?.status)) return { src, sys: null, reuse: p }; }
      if (src.api === 'citybikes') {
        let cachedAt = null, lastStatus = null;
        const fj = async (u) => {
          const r = await fetchJson(u); lastStatus = r.status;
          if (r.ok && r.json?.network) { cbCache[src.id] = { at: now, json: r.json }; return r; }
          const c = cbCache[src.id]; if (c && now - c.at <= CB_CACHE_MS && !(r.status === 404 || r.status === 410)) { cachedAt = c.at; return { ok: true, status: 200, json: c.json }; }
          return r;
        };
        const sys = await C.readCityBikesNetwork(src, fj, { now });
        if (cachedAt != null) Object.assign(sys, { cbCachedAt: cachedAt, cbFailStatus: lastStatus });
        return { src, sys };
      }
      // leerer Hauptfeed mit Ersatz auf anderem Host: Ersatz zählt (C.readGbfsWithFallback → sources[].viaAlt, Hinweis in der Feed-Prüfung)
      const sys = await C.readGbfsWithFallback(src, fetchJson, { now });
      return { src, sys };
    } catch (e) { return { src, sys: null, error: e.message }; }
  };
  const results = new Array(expanded.length);
  ctx.results = results;
  {
    const ix = expanded.map((s, i) => i), cbIx = ix.filter(i => expanded[i].api === 'citybikes'), mainIx = ix.filter(i => expanded[i].api !== 'citybikes');
    await Promise.all([
      pool(mainIx, async (i) => { results[i] = await fetchSource(expanded[i]); }),
      pool(cbIx, async (i, k) => { if (k && CB_GAP_MS > 0) await new Promise(r => setTimeout(r, CB_GAP_MS)); results[i] = await fetchSource(expanded[i]); }, 1),
    ]);
    if (cbCacheFile) { for (const [id, c] of Object.entries(cbCache)) if (now - c.at > CB_CACHE_MS) delete cbCache[id]; await writeFile(cbCacheFile, gzipSync(JSON.stringify(cbCache))).catch(e => log(`CityBikes-Zwischenstand: ${e.message}`)); }
    const cbN = cbIx.length, cbHit = results.filter(r => r?.sys?.cbCachedAt != null).length, cb429 = results.filter(r => r?.src?.api === 'citybikes' && (r.sys?.cbFailStatus === 429 || r.sys?.httpStatus === 429)).length;
    if (cbN) log(`CityBikes: ${cbN} Netze nacheinander (Abstand ${CB_GAP_MS} ms), ${cb429} mit HTTP 429, ${cbHit} aus dem letzten guten Abruf`);
  }
}
