// Mobility Pulse — Wörterbuch (de, en). Quelle für scripts/build-web.mjs, das daraus docs/i18n/<Sprache>/<Bereich>.json schneidet
// (S3.5); der Browser lädt nur die Bereiche, die eine Ansicht braucht. Node (Tests, Sammler) liest diese Datei direkt (web/i18n.js).
// Die Einträge stehen in web/i18n-de-*.js und web/i18n-en-*.js (je höchstens 580 Zeilen), hier in der ursprünglichen Reihenfolge zusammengefügt.
import de1 from './i18n-de-1.js';
import de2 from './i18n-de-2.js';
import de3 from './i18n-de-3.js';
import de4 from './i18n-de-4.js';
import de5 from './i18n-de-5.js';
import de6 from './i18n-de-6.js';
import de7 from './i18n-de-7.js';
import de8 from './i18n-de-8.js';
import de9 from './i18n-de-9.js';
import de10 from './i18n-de-10.js';
import de11 from './i18n-de-11.js';
import en1 from './i18n-en-1.js';
import en2 from './i18n-en-2.js';
import en3 from './i18n-en-3.js';
import en4 from './i18n-en-4.js';
import en5 from './i18n-en-5.js';
import en6 from './i18n-en-6.js';
import en7 from './i18n-en-7.js';
import en8 from './i18n-en-8.js';
import en9 from './i18n-en-9.js';
import en10 from './i18n-en-10.js';
import en11 from './i18n-en-11.js';
export const DE = { ...de1, ...de2, ...de3, ...de4, ...de5, ...de6, ...de7, ...de8, ...de9, ...de10, ...de11 };
export const EN = { ...en1, ...en2, ...en3, ...en4, ...en5, ...en6, ...en7, ...en8, ...en9, ...en10, ...en11 };
