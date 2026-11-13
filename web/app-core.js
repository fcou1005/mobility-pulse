// Dashboard: Grundlagen: Einstellungen, Formatierung, Farben, Glossar, Zustand (S3.9: aus web/app.js geschnitten, Einstieg bleibt web/app.js).
import * as C from './pulse-core.js';
import { t, tx, tMap, numFmt, dateFmt } from './i18n.js';

export const flagText = (f) => (f == null ? f : tx(f)); // Flags/Hinweise aus lib/* (deutsche Kennungstexte) in der Sprache der Seite

export const QS = new URLSearchParams(location.search);
export const DEMO = QS.get('demo') === '1'; // eingefrorener Demo-Stand (Branch demo), ohne Live-Abruf und ohne Nachladen
export const DATA_DEFAULT = DEMO ? 'https://raw.githubusercontent.com/fcou1005/mobility-pulse/demo/' : 'https://raw.githubusercontent.com/fcou1005/mobility-pulse/data/';
// ?data=… nur von erlaubter Herkunft: absoluter Pfad gleicher Herkunft, localhost/127.0.0.1 nur, wenn die Seite selbst lokal läuft (Tests),
// oder die Branches data/demo dieses Repos auf raw.githubusercontent.com (keine Commit-SHAs: GitHub liefert über den Repo-Pfad auch Commits aus Forks aus).
// Ein abweichender Datenstand steht dauerhaft als Hinweisband über den Ansichten (auch im Druck).
export const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])$/;
export function dataOrigin(d) {
  if (!d) return null;
  try {
    const u = new URL(d, location.href);
    if (/^\/[^/\\]/.test(d) && u.origin === location.origin) return d;
    if (/^https?:$/.test(u.protocol) && LOCAL_HOST.test(u.hostname) && LOCAL_HOST.test(location.hostname)) return d;
    if (u.origin === 'https://raw.githubusercontent.com' && /^\/fcou1005\/mobility-pulse\/(data|demo)\//.test(u.pathname) && !u.search && !u.hash) return u.href;
  } catch { /* keine URL */ }
  console.warn(`?data=${d} hat keine erlaubte Herkunft – Standard-Datenstand wird verwendet.`);
  return null;
}
export const DATA_PARAM = dataOrigin(QS.get('data'));
export const CFG = {
  DATA: DATA_PARAM || DATA_DEFAULT,
  DATA_OK: !!DATA_PARAM, // ?data= darf nur dann in Links bleiben
  // Repo-Dateien (sources.json, reference.json): bei lokalem ?data=/pfad/ aus dem ausgelieferten Repo (../data/), sonst vom Branch main
  MAIN: DATA_PARAM && !/^https?:/i.test(DATA_PARAM) ? new URL('../data/', location.href).href : 'https://raw.githubusercontent.com/fcou1005/mobility-pulse/main/data/',
  REPO: 'https://github.com/fcou1005/mobility-pulse',
  WFS: 'https://api.mobidata-bw.de/geoserver/MobiData-BW/ows',
  OVERPASS: ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter', 'https://overpass.private.coffee/api/interpreter'],
  OSRM_FOOT: 'https://routing.openstreetmap.de/routed-foot',
  VALHALLA: 'https://valhalla1.openstreetmap.de',
  MAX_POINTS: 6000,
};
export const $ = (s, el = document) => el.querySelector(s);
export const $$ = (s, el = document) => [...el.querySelectorAll(s)];
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// nur http(s)-Links aus Feeds werden zu Links; alles andere bleibt Text. label ist bereits escapetes HTML.
export const link = (url, label, cls = '') => /^https?:\/\//i.test(String(url || '').trim()) ? `<a href="${esc(String(url).trim())}" target="_blank" rel="noopener"${cls ? ` class="${cls}"` : ''}>${label}</a>` : String(label).replace(/<[^>]+>/g, '');
// Zahlen und Zeiten im Format der Sprache (de-DE / en-GB); Formatierer je Sprache gecacht (web/i18n.js)
export const fmt = (n, d = 0) => n == null || !Number.isFinite(n) ? '—' : numFmt(d).format(n);
export const pctf = (a, b) => b ? `${fmt((a / b) * 100, a / b < 0.1 ? 1 : 0)} %` : t('common.na');
export const ageText = (ms) => ms == null ? '–' : ms < 90e3 ? t('app.justNow') : ms < 3600e3 ? t('app.min', { v0: Math.round(ms / 60e3) }) : ms < 48 * 3600e3 ? t('app.h', { v0: fmt(ms / 3600e3, 1) }) : t('common.days', { n: Math.round(ms / 86400e3) });
// Uhrzeiten immer in Europe/Berlin (Sammler, Ereignistage und Tagesgang rechnen in Berliner Zeit), unabhängig von der Zeitzone des Browsers
export const BERLIN = 'Europe/Berlin';
export const timeText = (ms) => ms ? dateFmt({ hour: '2-digit', minute: '2-digit', timeZone: BERLIN }).format(new Date(ms)) : '–';
export const dateTimeText = (ms, opts = { dateStyle: 'medium', timeStyle: 'short' }) => dateFmt({ timeZone: BERLIN, ...opts }).format(new Date(ms));
// Beschriftungen aus lib/pulse-core.js je Code in der Sprache der Seite (Fahrzeugart, Frische)
export const TYPE = tMap('type', C.VEHICLE_TYPE_LABEL);
export const STATUS = tMap('fresh', { ...C.FRESHNESS_LABEL, collector: 1 });
export const DIRS = { get mobilitydata() { return t('app.mobilitydataOperators'); }, mobidata_bw: 'MobiData BW', mobidrom_nrw: 'MOBIDROM NRW', citybikes: 'CityBikes', get dott_direct() { return t('app.dottDirectFeed'); }, get lime_direct() { return t('app.limeDirectFeed'); }, get zeus_direct() { return t('app.zeusDirectFeed'); }, get bird_direct() { return t('app.birdDirectFeed'); }, db_api: 'DB API Marketplace' };
// Anbieterfarben [hell, dunkel], je Anbieter ein Farbton in beiden Themen. Auf Karten und im Streudiagramm stehen alle Anbieter einer Gemeinde
// nebeneinander, deshalb gilt dort „alle Paare“: Für jedes Paar, das in einer Gemeinde gemeinsam fährt (≥ 5 Fahrzeuge je Anbieter, latest.json
// vom 01.11.2026), besteht validate_palette.js --pairs all (Normalsicht ΔE ≥ 15, Protan/Deutan ΔE ≥ 8) hell und dunkel; Kontrast ≥ 3:1 gegen
// Fläche (#fff / #161d26) und entsättigten Kartengrund (#efefef / #1a1a1a). Anbieter, die nie zusammen fahren, dürfen sich eine Farbe teilen
// (Bolt/Zeus). Abstand zu den Statusfarben als Nebenbedingung. Suche: scratchpad pal/opt2.mjs. Unbekannte Anbieter: PAL_MORE (Hash).
export const OP_COLORS = { nextbike: ['#de5778', '#f4517e'], Dott: ['#9e3a93', '#ab46a0'], Voi: ['#5d1fbe', '#9a7bf9'], Lime: ['#5285f8', '#2b62ef'], Donkey: ['#1f600c', '#258101'], Bolt: ['#15959b', '#04a3aa'], 'DB Connect': ['#7a4306', '#a35e16'], Zeus: ['#15959b', '#04a3aa'], Yoio: ['#5633a3', '#795bce'], 'swabi - augsburg': ['#9b54b6', '#9654af'], 'RegioRad Stuttgart': ['#839007', '#869225'], 'Hopp Konstanz': ['#703485', '#9a4eb6'], 'LastenVelo Freiburg': ['#9c8a04', '#9c8a04'], zeo: ['#854494', '#9c4fae'], sigo: ['#978c0d', '#9d921a'], 'LaRa to go': ['#ab63c6', '#b367d1'], 'esel.ac': ['#9c8a04', '#7e6f08'], 'AB mit Lara': ['#c066c9', '#ad53b5'], 'ALF - das Affstätter Lastenfahrrad': ['#8c1060', '#ad4d83'], 'FaRe - das Bananologen Lastenrad': ['#6a9708', '#5e8221'], 'Gülf - das Gültsteiner Lastenrad': ['#4e4092', '#7260cb'], StadtRAD: ['#be5ebc', '#cb6ac9'] };
// Reihen ohne Anbieter (Fahrzeugarten im Deutschland-Verlauf): Nachbarpaare reichen; hell die Stufen ≥ 3:1 auf Weiß (Gelb, Aqua, Magenta, Orange dunkler)
export const PAL8 = { light: ['#2a78d6', '#d4572a', '#118a5f', '#a87200', '#c4517f', '#008300', '#6250d6', '#e34948'], dark: ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'] };
export const PAL_MORE = { light: ['#0f8fa8', '#a0652b', '#b05090', '#5b8f2b'], dark: ['#2aa3bd', '#c48244', '#cc6fae', '#6fa02a'] };
export const DISABLED_COL = '#7d8794'; // gesperrt: neutrales Grau statt Rot (Rot ist eine Anbieterfarbe)
export const isDark = () => document.documentElement.dataset.theme === 'dark' || (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
export const palette = (i) => PAL8[isDark() ? 'dark' : 'light'][i % 8];
export function opColor(op) {
  const m = isDark() ? 1 : 0;
  if (Object.hasOwn(OP_COLORS, op)) return OP_COLORS[op][m];
  const more = PAL_MORE[m ? 'dark' : 'light'];
  return more[parseInt(C.hashStr(String(op)), 36) % more.length];
}
// Rand der Kartenpunkte in der Hintergrundfarbe (1,5 px), damit sich Punkte voneinander absetzen
export const bgColor = () => getComputedStyle(document.documentElement).getPropertyValue('--panel').trim() || (isDark() ? '#161d26' : '#ffffff');
// Farbe aus einem Themen-Token (index.html :root), damit Kartenebenen hell und dunkel die passende Stufe tragen
export const tok = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888888';
// Begriffe, die eine kurze Erklärung brauchen (als <abbr title>)
export const GLOSS = {
  get rvd() { return t('app.tripsPerVehiclePerDayTvd'); },
  get util() { return t('app.shareOfTimeVehicleIsOnTrip'); },
  get real() { return t('app.shareOfListPriceThatIs'); },
  get rot() { return t('app.vehicleReappearsAtSameSpot40'); },
  get reloc() { return t('app.sameIdNeverDisappearedBut'); },
  get pickup() { return t('app.disabledOrNearlyEmpty'); },
  get cell() { return t('app.gridOfAbout250250MStarts'); },
  get calib() { return t('app.yourOwnFactorOnThisOperatorS'); },
  get empty() { return t('app.emptyNoBookableVehicleAnd'); },
  get score() { return t('app.equallyWeightedMeanOf'); },
  get fresh() { return t('app.dataAgeNowFeedAgeAt'); },
  get point() { return t('app.oneCollectorPointPerRunEvery'); },
  get gap() { return t('app.hourWithoutCollectorRunOr'); },
};
// Kundenansicht: Alltagsbegriffe statt Methodik (Sammler, Takt, Zellen, Kennungen)
export const GLOSS_CLIENT = {
  get fresh() { return t('app.howOldDataIsRightNowCurrent'); },
  get point() { return t('app.oneDataPointAboutEvery20'); },
  get empty() { return t('app.emptyNoVehicleAtStationAnd'); },
  get score() { return t('app.meanOfAvailabilityFew'); },
  get gap() { return t('app.timeWithoutMeasurement'); },
};
export const gl = (key) => (isClient() && GLOSS_CLIENT[key]) || GLOSS[key] || key;
export const abbr = (text, key) => `<abbr title="${esc(gl(key))}">${text}</abbr>`;
export const cl = (internal, client) => isClient() ? client : internal; // Text je Ansicht
// Leere Stationen: „effektiv leer“ = gemeldet leer und kein Fahrzeug ≤ 50 m; ältere Sammler-Stände kennen nur den gemeldeten Wert
export const emptyTip = (s) => { const rep = s.stationsEmptyReported || s.stationsEmpty || 0, near = s.stationsEmptyNearby || 0; return near ? t('app.reportedEmptyOfWhichWith', { rep: fmt(rep), near: fmt(near), v2: C.STATION_NEAR_M ?? 50 }) : t('app.reportedEmpty', { rep: fmt(rep) }); };
export const isClient = () => document.body.classList.contains('mode-client');
export const sig2 = (x) => { const p = 10 ** Math.max(0, Math.floor(Math.log10(Math.abs(x) || 1)) - 1); return Math.round(x / p) * p; };

export const state = {
  latest: null, catalog: null, status: null, histIndex: null, hist: {}, boundaries: null, bIndex: null,
  scope: 'DE', operator: 'all', type: 'all', mode: 'collector',
  live: null, // {at, systems: Map(id→sys), groups, vehicles, stations, recs: Map}
  thresholds: { charge: 20, range: 5 },
  map: null, layers: {}, supply: null, histDay: null,
};
