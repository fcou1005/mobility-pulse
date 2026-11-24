// @ts-check
// Sonnenauf- und -untergang (NOAA-Näherung, Genauigkeit ±1–2 Minuten in Deutschland) und Dunkelanteil einer UTC-Stunde (24.11.2026, Prognose:
// Merkmal „Dunkelheit“). Untergang = Sonnenmittelpunkt 0,833° unter dem Horizont (Refraktion und Sonnenradius), wie in Kalendern üblich.

const RAD = Math.PI / 180;

/**
 * Sonnenaufgang und -untergang in Minuten nach 0 Uhr UTC des Tages day ('YYYY-MM-DD'); Polartag/-nacht: [0, 1440] bzw. [720, 720].
 * @returns {[number, number]}
 */
export function sunTimes(/** @type {number} */ lat, /** @type {number} */ lon, /** @type {string} */ day) {
  const t0 = Date.parse(`${day}T12:00:00Z`), n = Math.floor((t0 - Date.UTC(new Date(t0).getUTCFullYear(), 0, 1)) / 86400e3) + 1;
  const g = (2 * Math.PI / 365) * (n - 1);
  const eq = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
  const dec = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g) - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
  const x = Math.cos(90.833 * RAD) / (Math.cos(lat * RAD) * Math.cos(dec)) - Math.tan(lat * RAD) * Math.tan(dec);
  if (x <= -1) return [0, 1440];
  if (x >= 1) return [720, 720];
  const ha = Math.acos(x) / RAD;
  return [720 - 4 * (lon + ha) - eq, 720 - 4 * (lon - ha) - eq];
}

/** Anteil der UTC-Stunde hour (0–23) am Tag day, in dem die Sonne untergegangen ist (0 = ganz hell, 1 = ganz dunkel) */
export function darkShare(/** @type {number} */ lat, /** @type {number} */ lon, /** @type {string} */ day, /** @type {number} */ hour, times = sunTimes(lat, lon, day)) {
  const a = hour * 60, b = a + 60, light = Math.max(0, Math.min(b, times[1]) - Math.max(a, times[0]));
  return +(1 - light / 60).toFixed(3);
}
