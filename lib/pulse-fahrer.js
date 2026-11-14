// Mobility Pulse – S6.2 Fahrermodus: Tour als Link (#t=…) bzw. QR-Code, ohne Server und ohne Konto.
// Die Tour steht vollständig im Link (kompakt: Koordinaten als Differenzen in 1e-5°, Base64url), damit der Fahrermodus offline arbeitet
// (Service Worker hält nur die Seite); Abhaken und Rückmeldungen bleiben im Gerät (localStorage) und gehen als Text an die Disposition.
export const TOUR_V = 1;
export const STOP_TYPES = Object.freeze(['depot', 'pickup', 'drop', 'swap', 'pickup_disabled']);
export const ISSUES = Object.freeze(['missing', 'broken']);
const E5 = 1e5, NOTE_MAX = 48;

/** Tour aus einem Fahrer des Schichtplans (planShift) bzw. einer Tour der Disposition (Stopps mit lat, lon, type, count, eta?) */
export function makeTour({ id, title = '', at = Date.now(), day = null, stops = [], depot = null }) {
  const st = [];
  if (depot && stops[0]?.type !== 'depot') st.push({ type: 'depot', lat: depot.lat, lon: depot.lon, count: 0, eta: null, note: '' });
  for (const s of stops) st.push({ type: STOP_TYPES.includes(s.type) ? s.type : 'pickup', lat: +s.lat, lon: +s.lon, count: s.count || 0, eta: Number.isFinite(s.eta) ? Math.round(s.eta) : null, note: String(s.note || '').slice(0, NOTE_MAX) });
  if (depot && st.at(-1)?.type !== 'depot') st.push({ type: 'depot', lat: depot.lat, lon: depot.lon, count: 0, eta: null, note: '' });
  return { v: TOUR_V, id: String(id || 'T'), title: String(title).slice(0, 80), at: Math.round(at), day, stops: st };
}

const b64u = { enc: (str) => { const by = new TextEncoder().encode(str); let bin = ''; for (const b of by) bin += String.fromCharCode(b); return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); },
  dec: (s) => { const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)); return new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0))); } };

/** Tour → Text für den Link (#t=…): [v, id, title, at in Minuten, day, [[typ, Δlat, Δlon, anzahl, eta, notiz], …]] */
export function encodeTour(tour) {
  let pl = 0, po = 0;
  const rows = tour.stops.map(s => { const la = Math.round(s.lat * E5), lo = Math.round(s.lon * E5), r = [STOP_TYPES.indexOf(s.type), la - pl, lo - po, s.count || 0, s.eta ?? -1]; if (s.note) r.push(s.note); pl = la; po = lo; return r; });
  return b64u.enc(JSON.stringify([tour.v, tour.id, tour.title, Math.round(tour.at / 60e3), tour.day, rows]));
}
/** Umkehrung; null bei kaputtem oder fremdem Text */
export function decodeTour(text) {
  try {
    const a = JSON.parse(b64u.dec(String(text || '').trim()));
    if (!Array.isArray(a) || a[0] !== TOUR_V || !Array.isArray(a[5]) || a[5].length > 400) return null;
    let la = 0, lo = 0;
    const stops = a[5].map(r => { la += +r[1]; lo += +r[2]; const type = STOP_TYPES[r[0]]; if (!type || !Number.isFinite(la) || !Number.isFinite(lo)) throw new Error('Stopp'); return { type, lat: la / E5, lon: lo / E5, count: +r[3] || 0, eta: r[4] >= 0 ? +r[4] : null, note: typeof r[5] === 'string' ? r[5].slice(0, NOTE_MAX) : '' }; });
    if (stops.some(s => Math.abs(s.lat) > 90 || Math.abs(s.lon) > 180)) return null;
    return { v: TOUR_V, id: String(a[1]).slice(0, 20), title: String(a[2] || '').slice(0, 80), at: +a[3] * 60e3, day: a[4] ?? null, stops };
  } catch { return null; }
}
/** Schlüssel einer Tour (FNV-1a über den Linktext) für den Speicher im Gerät */
export function tourKey(text) { let h = 0x811c9dc5; for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h.toString(36); }
/** Arbeitsstopps (ohne Depot) mit ihrer Stelle in tour.stops */
export const workStops = (tour) => tour.stops.map((s, i) => ({ ...s, i })).filter(s => s.type !== 'depot');
/** Fortschritt aus dem Gerätespeicher { done: { i: ms }, issue: { i: 'missing'|'broken' } } */
export function progress(tour, st = {}) {
  const w = workStops(tour), done = w.filter(s => st.done?.[s.i]).length, issues = w.filter(s => st.issue?.[s.i]).length;
  const next = w.find(s => !st.done?.[s.i] && !st.issue?.[s.i]) || null;
  return { total: w.length, done, issues, open: w.length - done - issues, next, complete: w.length > 0 && done + issues === w.length };
}
const hm = (min) => (min == null ? '' : `${String(Math.floor(min / 60) % 24).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`);
/** Rückmeldung an die Disposition als Text (Teilen/Kopieren): Kopf, Zählung, je Problem eine Zeile mit Lage */
export function feedbackText(tour, st = {}, { lang = 'de', now = Date.now() } = {}) {
  const en = lang === 'en', p = progress(tour, st), T = { missing: en ? 'not found' : 'nicht gefunden', broken: en ? 'damaged' : 'defekt' };
  const head = `${en ? 'Tour' : 'Tour'} ${tour.id}${tour.title ? ` (${tour.title})` : ''}: ${p.done}/${p.total} ${en ? 'done' : 'erledigt'}, ${p.issues} ${en ? 'with problem' : 'mit Problem'}, ${p.open} ${en ? 'open' : 'offen'}`;
  const lines = workStops(tour).filter(s => st.issue?.[s.i]).map(s => `${en ? 'Stop' : 'Stopp'} ${s.i}${s.eta != null ? ` (${hm(s.eta)})` : ''}: ${T[st.issue[s.i]] || st.issue[s.i]} – ${s.lat.toFixed(5)}, ${s.lon.toFixed(5)}${s.note ? ` – ${s.note}` : ''}`);
  return [head, ...lines, `${en ? 'As of' : 'Stand'} ${new Date(now).toISOString().slice(0, 16).replace('T', ' ')} UTC`].join('\n');
}
/** Navigation je Stopp (Google Maps, öffnet die App; ohne Netz zeigt das Handy den Ort aus dem Link) */
export const navUrl = (s) => `https://www.google.com/maps/dir/?api=1&destination=${s.lat.toFixed(6)},${s.lon.toFixed(6)}&travelmode=driving`;
export const timeText = hm;
