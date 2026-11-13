// Datenverträge (S3.7): Formatversion „MAJOR.MINOR“ je Dateifamilie des Datenzweigs. Der Sammler stempelt schemaVersion in jede
// Datei dieser Familien (ohne Abhängigkeit), die Seite prüft beim Laden nur die MAJOR-Version und zeigt bei Abweichung einen Hinweis,
// und test/schema.mjs prüft Fixture und Datenstand mit ajv gegen schemas/<Familie>.schema.json. MAJOR steigt, wenn ein Feld
// wegfällt oder seine Bedeutung ändert (alte Seiten würden falsch rechnen), MINOR bei neuen Feldern.
// Ältere Dateien ohne schemaVersion gelten als verträglich (Übergang); bestehende Felder version/v bleiben unverändert.

export const SCHEMA = Object.freeze({
  status: '2.0', latest: '1.0', sources: '1.0', history: '1.0', events: '1.1',
  cells: '1.0', ops: '1.1', boundaries: '1.0', calib: '1.0', forecast: '1.0',
});

// Dateipfad (relativ zum Datenzweig) → [Familie, Teilschema in $defs; Zahl = Nummer der Gruppe im Muster, null = ganzes Schema]
/** @type {Array<[RegExp, string, string|number|null]>} */
const RULES = [
  [/^status\.json$/, 'status', null],
  [/^latest\.json$/, 'latest', null],
  [/^sources\.json$/, 'sources', null],
  [/^history\/index\.json$/, 'history', 'index'],
  [/^history\/\d{4}-\d{2}-\d{2}\.json$/, 'history', 'day'],
  [/^events\/index\.json$/, 'events', 'index'],
  [/^events\/\d{4}-\d{2}-\d{2}(?:\/[A-Z]{2})?\.json$/, 'events', 'day'], // 1.1: auch je Land (S3.8)
  [/^events\/hour-totals\.json$/, 'events', 'hourTotals'],
  [/^events\/daily-summary\.json$/, 'events', 'summary'],
  [/^cells\/\d{4}-\d{2}-\d{2}\/[A-Z]{2}\.json$/, 'cells', null],
  [/^ops\/[A-Z]{2}\.json$/, 'ops', 'state'],
  [/^ops-input\/\d{8}\.json$/, 'ops', 'input'], // 1.1: Nachfrage-Eingabe der Disposition je Gemeinde (S3.8)
  [/^ops-input\/index\.json$/, 'ops', 'inputIndex'],
  [/^boundaries\/index\.json$/, 'boundaries', 'index'],
  [/^boundaries\/[A-Z]{2}\.json$/, 'boundaries', 'state'],
  [/^calib\.json$/, 'calib', null],
  [/^forecast\/(?:(?:moped|car)\/)?(latest|log|series)\.json$/, 'forecast', 1],
];

/** @param {string} file Pfad relativ zum Datenzweig (ohne ?Parameter) @returns {{ family: string, def: string|null } | null} */
export function familyOf(file) {
  const f = String(file || '').replace(/[?#].*$/, '').replace(/^\.?\//, '');
  for (const [re, family, def] of RULES) { const m = re.exec(f); if (m) return { family, def: typeof def === 'number' ? m[def] : def }; }
  return null;
}

/** Dokument mit Formatversion der Familie (schemaVersion steht vorn, damit sie beim Lesen der Datei auffällt) */
export const withSchema = (family, doc) => { const { schemaVersion: _old, ...rest } = doc || {}; return { schemaVersion: SCHEMA[family], ...rest }; };

export const majorOf = (v) => { const m = /^(\d+)\.\d+$/.exec(String(v ?? '')); return m ? +m[1] : null; };

/**
 * MAJOR-Version prüfen. null = passt oder nicht prüfbar (fremde Datei, kein Objekt, ohne schemaVersion);
 * sonst { family, expected, got } für den Hinweis der Seite.
 * @param {string} file @param {any} doc
 */
export function checkMajor(file, doc) {
  const fam = familyOf(file);
  if (!fam || !doc || typeof doc !== 'object' || Array.isArray(doc) || doc.schemaVersion == null) return null;
  const want = SCHEMA[fam.family], got = String(doc.schemaVersion);
  return majorOf(got) === majorOf(want) ? null : { family: fam.family, expected: want, got };
}
