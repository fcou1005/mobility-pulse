// Zusatz-Fixtures für test/run.mjs (eigener Port, im Prozess von run.mjs): Lizenz/Namensnennung, Tarif mit eingeschleuster Währung,
// virtuelle Stationen, CityBikes-Kopie unter anderem Anbieternamen, Zugangsdaten (nur exakter Host, keine fremden Weiterleitungen),
// langsame und zu große Antworten.
import http from 'node:http';

export async function startExtra() {
  const log = []; // { path, host, key }
  const st = { price: 1.0 };
  let base = '', other = '';
  const n = () => Math.floor(Date.now() / 1000);
  const head = (data, extra = {}) => ({ last_updated: n(), ttl: 60, version: '2.3', data, ...extra });
  const SPOTS = [...Array(6)].map((_, i) => ({ id: (i < 3 ? 'z' : 'd') + i, name: `Platz ${i + 1}`, lat: +(48.77 + i * 0.002).toFixed(5), lon: 9.17 }));
  const p = {
    'gbfs.json': () => head({ de: { feeds: ['system_information', 'vehicle_types', 'station_information', 'station_status', 'free_bike_status', 'system_pricing_plans'].map(f => ({ name: f, url: `${base}/p/${f}.json` })) } }),
    'system_information.json': () => head({ system_id: 'p_test', name: 'Rad Test', operator: 'RegioRad Stuttgart', timezone: 'Europe/Berlin', language: 'de', license_id: 'cc-by-sa-40', attribution_organization_name: 'Teststadt Mobil GmbH', attribution_url: 'https://example.org' }),
    'vehicle_types.json': () => head({ vehicle_types: [{ vehicle_type_id: 'bk', form_factor: 'bicycle', propulsion_type: 'human' }] }),
    'station_information.json': () => head({ stations: SPOTS.map(s => ({ station_id: s.id, name: s.name, lat: s.lat, lon: s.lon })) }),
    // z0–z2 ohne num_docks_available (Abstellzonen), d3–d5 mit Docks; d3 leer, d4/d5 je ein Rad
    'station_status.json': () => head({ stations: SPOTS.map((s, i) => ({ station_id: s.id, num_bikes_available: i >= 4 ? 1 : 0, ...(i >= 3 ? { num_docks_available: 5 } : {}), is_installed: true, is_renting: true, is_returning: true, last_reported: n() })) }),
    'free_bike_status.json': () => head({ bikes: [{ bike_id: 'r1', station_id: 'd4', is_reserved: false, is_disabled: false, vehicle_type_id: 'bk', last_reported: n() }, { bike_id: 'r2', station_id: 'd5', is_reserved: false, is_disabled: false, vehicle_type_id: 'bk', last_reported: n() }, { bike_id: 'r3', lat: 48.80, lon: 9.20, is_reserved: false, is_disabled: false, vehicle_type_id: 'bk', last_reported: n() }] }),
    'system_pricing_plans.json': () => head({ plans: [{ plan_id: 'std', name: 'Standard', currency: '<img src=x onerror=alert(1)>', price: st.price, is_taxable: true, description: 'Test', per_min_pricing: [{ start: 0, rate: 0.1, interval: 1 }] }, { plan_id: 'eur', name: 'Euro', currency: 'EUR', price: 0, is_taxable: true, description: 'Test' }] }),
  };
  // CityBikes-Kopie derselben Stationen (≈ 11 m versetzt, gleiche Namen) unter „Deutsche Bahn AG“
  const cb = () => ({ network: { id: 'stadtrad-stuttgart', name: 'RegioRadStuttgart', company: ['Deutsche Bahn AG'], location: { city: 'Stuttgart', country: 'DE' }, stations: SPOTS.map((s, i) => ({ id: 'c' + i, name: s.name, latitude: s.lat + 0.0001, longitude: s.lon, free_bikes: i >= 4 ? 1 : 0, empty_slots: 5, timestamp: new Date().toISOString(), extra: { uid: 'u' + i, renting: 1, returning: 1 } })) } });
  const authFeeds = () => head({ de: { feeds: [
    { name: 'system_information', url: `${base}/auth/system_information.json` },
    { name: 'free_bike_status', url: `${other}/leak/free_bike_status.json?via=${encodeURIComponent(base.replace(/^http:\/\//, ''))}` }, // anderer Host, Host-Name als Text in der URL
    { name: 'vehicle_types', url: `${base}/auth/redir` }, // Weiterleitung auf anderen Host
  ] } });
  // Spiegelquelle mit umgeschlüsselten Kennungen (M-1): /rk/a = Betreiber direkt, /rk/b = Landesfeed, dieselben 30 Räder unter anderen Kennungen.
  // /rk/c = Kind eines Manifests (/mf/manifest.json, abschaltbar über st.manifestUp, M-6) mit 60 E-Scootern, Ladestand höchstens 35 % (M-2).
  st.manifestUp = true;
  // /rk/d = Feed mit kleiner Reichweiten-Skala (wie Lime über MobiData BW): 60 E-Scooter in Stuttgart, kein Ladestand, Reichweite 0–11,8 km
  // in 200-m-Schritten (95. Perzentil 11,2 km → Reichweiten-Schwelle der Quelle 2,2 km; Vielfache von 100 m, damit die Rundung in ops/<Land>.json nichts verschiebt)
  // /rk/e = Platzhalter-Reichweite (wie Donkey Bayern): 60 E-Räder in Stuttgart, Ladestand 0–14 % (Skala unplausibel), Reichweite überall 1 km
  // /rk/z = 250 E-Scooter in Stuttgart (Zeus), nur in Lauf 4: alle Kennungen neu = Standzeit unter einem Laufintervall (Z5 idleUnusable → Ampel)
  const rk = (v) => {
    const veh = v === 'z' ? [...Array(250)].map((_, i) => ({ bike_id: `z-${i}`, lat: +(48.71 + i * 0.0006).toFixed(5), lon: 9.29, is_reserved: false, is_disabled: false, vehicle_type_id: 'sd', current_fuel_percent: 50 + (i % 40), last_reported: n() }))
      : v === 'e' ? [...Array(60)].map((_, i) => ({ bike_id: `e-${i}`, lat: +(48.75 + i * 0.0007).toFixed(5), lon: 9.25, is_reserved: false, is_disabled: false, vehicle_type_id: 'eb', current_fuel_percent: i % 15, current_range_meters: 1000, last_reported: n() }))
      : v === 'c' ? [...Array(60)].map((_, i) => ({ bike_id: `c-${i}`, lat: +(48.50 + i * 0.0007).toFixed(5), lon: 9.02, is_reserved: false, is_disabled: false, vehicle_type_id: 'sc', current_fuel_percent: Math.round(i * 0.6), last_reported: n() }))
      : v === 'd' ? [...Array(60)].map((_, i) => ({ bike_id: `d-${i}`, lat: +(48.75 + i * 0.0007).toFixed(5), lon: 9.20, is_reserved: false, is_disabled: false, vehicle_type_id: 'sd', current_range_meters: i * 200, last_reported: n() }))
      : [...Array(30)].map((_, i) => ({ bike_id: `${v}-${i}`, lat: +(48.50 + i * 0.0015).toFixed(5), lon: 9.10, is_reserved: false, is_disabled: false, vehicle_type_id: 'bk', last_reported: n() }));
    return {
      'gbfs.json': () => head({ de: { feeds: ['system_information', 'vehicle_types', 'free_bike_status'].map(f => ({ name: f, url: `${base}/rk/${v}/${f}.json` })) } }),
      'system_information.json': () => head(v === 'c' ? { system_id: 'mfkid', name: 'Lime Test', operator: 'Lime', timezone: 'Europe/Berlin' } : v === 'd' ? { system_id: 'rl', name: 'Bird Test', operator: 'Bird', timezone: 'Europe/Berlin' } : v === 'e' ? { system_id: 'rf', name: 'Donkey Test', operator: 'Donkey', timezone: 'Europe/Berlin' } : v === 'z' ? { system_id: 'zi', name: 'Zeus Test', operator: 'Zeus', timezone: 'Europe/Berlin' } : { system_id: `rk_${v}`, name: 'nextbike RK', operator: 'nextbike', timezone: 'Europe/Berlin' }),
      'vehicle_types.json': () => head({ vehicle_types: [{ vehicle_type_id: 'bk', form_factor: 'bicycle', propulsion_type: 'human' }, { vehicle_type_id: 'sc', form_factor: 'scooter', propulsion_type: 'electric', max_range_meters: 40000 }, { vehicle_type_id: 'sd', form_factor: 'scooter', propulsion_type: 'electric' }, { vehicle_type_id: 'eb', form_factor: 'bicycle', propulsion_type: 'electric_assist' }] }),
      'free_bike_status.json': () => head({ bikes: veh }),
    };
  };
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x'); const key = req.headers['x-api-key'] || null;
    log.push({ path: u.pathname, host: req.headers.host, key, q: Object.fromEntries(u.searchParams) });
    const json = (b, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
    const [, kind, file] = u.pathname.split('/');
    if (kind === 'p' && p[file]) return json(p[file]());
    // Chronos-Lauf (Branch tsfm): eine Gruppe, 48 Stunden ab der laufenden Stunde, Vortagsprognose für heute
    if (u.pathname === '/tsfm/chronos.json') { const from = Math.floor(Date.now() / 3600e3) * 3600e3, d0 = new Date(from).toISOString().slice(0, 10); return json({ version: 1, model: 'test', at: '2026-11-07T12:00:00.000Z', from, hours: 48, groups: { '08416041|Bolt|scooter': { m: new Array(48).fill(3) } }, back: { [d0]: { from: from - 3600e3 * 2, hours: 24, groups: { '08416041|Bolt|scooter': new Array(24).fill(4) } } } }); }
    // erster Abruf eines Teilfeeds mit 429 (wie Yoio/rideatom): der Sammler wiederholt einmal
    if (u.pathname === '/rk/d/free_bike_status.json' && !st.flakyServed) { st.flakyServed = true; return json({}, 429); }
    if (kind === 'rk') { const [, , v, f] = u.pathname.split('/'); const doc = ['a', 'b', 'c', 'd', 'e', 'z'].includes(v) ? rk(v)[f] : null; return doc ? json(doc()) : json({}, 404); }
    if (kind === 'mf') return st.manifestUp ? json(head({ datasets: [{ system_id: 'mfkid', versions: [{ version: '2.3', url: `${base}/rk/c/gbfs.json` }] }] })) : json({}, 500);
    if (kind === 'weather') { // Bright-Sky-Format: stündliche Zeilen von date 00:00 bis last_date 00:00 (UTC); ein unplausibler Temperaturwert (999) pro Antwort
      if (st.weatherDown) return json({}, 500);
      const d0 = Date.parse(`${u.searchParams.get('date')}T00:00:00Z`), d1 = Date.parse(`${u.searchParams.get('last_date')}T00:00:00Z`), w = [];
      for (let t = d0, i = 0; t <= d1; t += 3600e3, i++) w.push({ timestamp: new Date(t).toISOString().replace('Z', '+00:00'), temperature: i === 3 ? 999 : 8 + (i % 24) / 2, precipitation: i % 24 === 5 ? 1.2 : 0, wind_speed: 12, sunshine: 0 });
      return json({ weather: w, sources: [] });
    }
    if (kind === 'alerts') { // Bright-Sky-Warnungen: eine schwere ab der nächsten Stunde für 3 Stunden, eine Probewarnung
      const t = Math.floor(Date.now() / 3600e3 + 1) * 3600e3, iso = (x) => new Date(x).toISOString();
      return json({ alerts: [{ id: 1, alert_id: 'a', status: 'actual', severity: 'severe', onset: iso(t), expires: iso(t + 3 * 3600e3), event_de: 'STURMBÖEN', headline_de: 'Text' }, { id: 2, alert_id: 'b', status: 'test', severity: 'extreme', onset: iso(t), expires: iso(t + 3600e3) }], location: null });
    }
    if (kind === 'autobahn') { // Autobahn-API: A8 mit Sperrung und Stau (Stuttgart), Dauer-Baustellenhinweis; A81 nicht erreichbar
      const [, , road, , sv] = u.pathname.split('/');
      if (!road) return json({ roads: ['A8', 'A81 '] });
      if (road !== 'A8') return json({}, 500);
      if (sv === 'closure') return json({ closure: [{ coordinate: { lat: '48.775', long: '9.175' }, future: false, isBlocked: 'true', title: 'A8' }] });
      if (sv === 'warning') return json({ warning: [{ coordinate: { lat: '48.776', long: '9.176' }, future: false, abnormalTrafficType: 'STATIONARY_TRAFFIC' }, { coordinate: { lat: '48.776', long: '9.176' }, future: false, description: ['Baustelle'], startTimestamp: '2025-01-01T00:00:00.000+0100' }] });
      return json({}, 404);
    }
    if (kind === 'sparql') { // Wikidata: Arena in Tübingen (zweimal mit zwei Websites), Friedhof, zu kleine Halle
      const B = (id, l, c, p, t, w) => ({ i: { value: `http://www.wikidata.org/entity/${id}` }, l: { value: l }, c: { value: String(c) }, p: { value: p }, types: { value: t }, ...(w ? { w: { value: w } } : {}) });
      return json({ results: { bindings: [B('Q1', 'Testarena', 8000, 'Point(9.06 48.52)', 'Mehrzweckhalle', 'https://testarena.example/en/'), B('Q1', 'Testarena', 8000, 'Point(9.06 48.52)', 'Mehrzweckhalle', 'https://testarena.example/'),
        B('Q2', 'Waldfriedhof', 20000, 'Point(9.07 48.53)', 'Friedhof'), B('Q3', 'Kleine Halle', 3000, 'Point(9.05 48.51)', 'Mehrzweckhalle')] } });
    }
    if (kind === 'robots.txt') return (res.writeHead(200, { 'content-type': 'text/plain' }), res.end('User-agent: *\nDisallow: /kal/geheim\n'));
    if (kind === 'kal') { // Programmseite der Testarena (Termin morgen 20 Uhr, mehrtägig, Tournee), ICS-Kalender, gesperrte Seite
      const d = new Date(Date.now() + 86400e3), dd = `${String(d.getUTCDate()).padStart(2, '0')}.${String(d.getUTCMonth() + 1).padStart(2, '0')}.${d.getUTCFullYear()}`;
      const ymd = d.toISOString().slice(0, 10).replace(/-/g, '');
      if (file === 'programm') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(`<html><body><div class="e"><span>${dd}, 20:00 Uhr</span><a href="/kal/detail/x">Band X</a></div><div class="e"><h3>Festival</h3><p>01.01.2030 - 31.01.2030</p><a href="/kal/detail/f">Infos</a></div></body></html>`); }
      // Sammelseite wie hallenduo.de: Termin heute ohne Uhrzeit, einziger Link führt zu einer Karte (anderer Host)
      if (file === 'hallen') { const td = new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date()); res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(`<html><body><div class="event-item"><div class="event-date">${td}</div><div class="event-title">Heute ohne Zeit</div><span><a href="http://maps.example/?q=Halle+1">Halle 1</a></span></div></body></html>`); }
      if (file === 'cal.ics') { res.writeHead(200, { 'content-type': 'text/calendar' }); return res.end(`BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nSUMMARY:Messe Test\r\nDTSTART;VALUE=DATE:${ymd}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`); }
      return json({}, 404);
    }
    if (kind === 'getmatchdata') { // OpenLigaDB: bl1 mit Heimspiel in 2 h (Testverein → Tübingen), unbekanntem Heimverein, altem Spiel, Spiel ohne Anstoß; bl2 leer; bl3 Fehler
      const [, , lg] = u.pathname.split('/'), t = Math.floor(Date.now() / 3600e3 + 2) * 3600e3 + 30 * 60e3, iso = (x) => new Date(x).toISOString().replace('.000Z', 'Z');
      const m = (id, at, h, g) => ({ matchID: id, matchDateTime: null, matchDateTimeUTC: at == null ? null : iso(at), leagueShortcut: lg, team1: { teamName: h, shortName: h }, team2: { teamName: g, shortName: g }, location: null });
      if (lg === 'bl1') return json([m(1, t, 'Testverein', 'Gast FC'), m(2, t, 'Unbekannt FC', 'Gast FC'), m(3, Date.now() - 70 * 86400e3, 'Testverein', 'Alt FC'), m(4, null, 'Testverein', 'Ohne Zeit')]);
      if (lg === 'bl2') return json([]);
      return json({}, 500);
    }
    if (kind === 'cb') return json(cb());
    if (kind === 'auth') {
      if (key !== 'geheim-123') return json({}, 401);
      if (file === 'gbfs.json') return json(authFeeds());
      if (file === 'system_information.json') return json(head({ system_id: 'auth_test', name: 'Auth', timezone: 'Europe/Berlin' }));
      if (file === 'redir') { res.writeHead(302, { location: `${other}/leak/vehicle_types.json` }); return res.end(); }
    }
    if (kind === 'leak') return json(head(file.startsWith('free_bike') ? { bikes: [{ bike_id: 'x1', lat: 48.79, lon: 9.19, is_reserved: false, is_disabled: false }] } : { vehicle_types: [] }));
    if (kind === 'slow') { res.writeHead(200, { 'content-type': 'application/json' }); res.write('{"data":'); const t = setTimeout(() => { try { res.end('{}}'); } catch {} }, 6000); res.on('close', () => clearTimeout(t)); return; }
    if (kind === 'big') { res.writeHead(200, { 'content-type': 'application/json' }); res.write('{"data":"'); for (let i = 0; i < 30; i++) res.write('x'.repeat(10000)); return res.end('"}'); }
    res.writeHead(404); res.end('nf');
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  base = `http://127.0.0.1:${port}`; other = `http://localhost:${port}`;
  return { port, base, log, st, close: () => { srv.closeAllConnections?.(); srv.close(); } };
}
