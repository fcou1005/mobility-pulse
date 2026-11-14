#!/usr/bin/env node
// Sammler: ruft alle Quellen ab, normalisiert, ordnet Gemeinden zu, dedupliziert, aggregiert.
// Schreibt data/latest.json, data/status.json, data/history/YYYY-MM-DD.json, data/snapshot/*.json, data/boundaries-active.json
// S3.9: die Arbeit steckt in scripts/collect/NN-<phase>.mjs (je Phase eine Funktion run(ctx)); diese Datei ruft sie nacheinander auf und
// misst je Phase die Zeit (status.json → phases). ctx: was Phasen voneinander brauchen (Konstanten, Zwischenergebnisse, let-Werte).
import { run as p00 } from './collect/00-start.mjs';
import { run as p01 } from './collect/01-abruf.mjs';
import { run as p02 } from './collect/02-auswertung.mjs';
import { run as p03 } from './collect/03-preise-zonen.mjs';
import { run as p04 } from './collect/04-konsistenz.mjs';
import { run as p05 } from './collect/05-dubletten.mjs';
import { run as p06 } from './collect/06-betriebsgebiete.mjs';
import { run as p07 } from './collect/07-messbasis.mjs';
import { run as p08 } from './collect/08-obergrenzen.mjs';
import { run as p09 } from './collect/09-zonen-beobachtung.mjs';
import { run as p10 } from './collect/10-kalender-wetter.mjs';
import { run as p11 } from './collect/11-verkehr.mjs';
import { run as p12 } from './collect/12-baustellen.mjs';
import { run as p13 } from './collect/13-oepnv.mjs';
import { run as p14 } from './collect/14-verfolgung.mjs';
import { run as p15 } from './collect/15-abdeckung.mjs';
import { run as p16 } from './collect/16-ereignisse.mjs';
import { run as p17 } from './collect/17-sport-termine.mjs';
import { run as p18 } from './collect/18-streiks.mjs';
import { run as p19 } from './collect/19-prognose.mjs';
import { run as p20 } from './collect/20-training.mjs';
import { run as p21 } from './collect/21-kalibrierung.mjs';
import { run as p22 } from './collect/22-grenzen.mjs';
import { run as p23 } from './collect/23-gebiet.mjs';
import { run as p24 } from './collect/24-alarme.mjs';
import { run as p27 } from './collect/27-markt.mjs';
import { run as p25 } from './collect/25-datenvertraege.mjs';
import { run as p26 } from './collect/26-abschluss.mjs';

/** @type {Array<[string, (ctx: any) => Promise<void>]>} */
const PHASES = [['abruf', p01], ['auswertung', p02], ['preise-zonen', p03], ['konsistenz', p04], ['dubletten', p05], ['betriebsgebiete', p06], ['messbasis', p07], ['obergrenzen', p08], ['zonen-beobachtung', p09], ['kalender-wetter', p10], ['verkehr', p11], ['baustellen', p12], ['oepnv', p13], ['verfolgung', p14], ['abdeckung', p15], ['ereignisse', p16], ['sport-termine', p17], ['streiks', p18], ['prognose', p19], ['training', p20], ['kalibrierung', p21], ['grenzen', p22], ['gebiet', p23], ['alarme', p24], ['markt', p27], ['datenvertraege', p25], ['abschluss', p26]];
const ctx = {};
await p00(ctx); // Phase „start“: Umgebung, Katalog, Vorlauf (ctx.PH misst ab hier)
for (const [name, run] of PHASES) { ctx.PH.phase(name); await run(ctx); }
