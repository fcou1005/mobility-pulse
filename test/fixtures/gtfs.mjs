// Test-Hilfen: GTFS-Realtime kodieren (nur die Felder, die lib/pulse-oepnv.js liest) und eine ZIP-Datei bauen (Deflate).
import { deflateRawSync } from 'node:zlib';

const varint = (n) => {
  let v = n < 0 ? BigInt.asUintN(64, BigInt(n)) : BigInt(Math.round(n)); const out = [];
  do { let b = Number(v & 127n); v >>= 7n; if (v > 0n) b |= 128; out.push(b); } while (v > 0n);
  return Buffer.from(out);
};
const key = (f, w) => varint(f * 8 + w);
export const pbInt = (f, n) => Buffer.concat([key(f, 0), varint(n)]);
export const pbMsg = (f, ...parts) => { const body = Buffer.concat(parts.map(p => (typeof p === 'string' ? Buffer.from(p) : p))); return Buffer.concat([key(f, 2), varint(body.length), body]); };
export const pbStr = (f, s) => pbMsg(f, s);

/**
 * Feed aus Fahrten: [{ id, startDate?, startTime?, canceled?, stops: [{ stop, t (ms) | null, delay?, skipped? }] }]; alerts = Anzahl leerer Meldungen
 */
export function encodeFeed(trips, { ts = Date.now(), alerts = 0 } = {}) {
  const head = pbMsg(1, pbStr(1, '2.0'), pbInt(2, 0), pbInt(3, Math.floor(ts / 1000)));
  const ents = trips.map((tr, k) => pbMsg(2, pbStr(1, `e${k}`), pbMsg(3,
    pbMsg(1, pbStr(1, tr.id || `t${k}`), ...(tr.startTime ? [pbStr(2, tr.startTime)] : []), ...(tr.startDate ? [pbStr(3, tr.startDate)] : []), ...(tr.canceled ? [pbInt(4, 3)] : [])),
    ...tr.stops.map((s, i) => pbMsg(2, pbInt(1, i + 1),
      ...(s.t != null ? [pbMsg(2, pbInt(1, s.delay ?? 0), pbInt(2, Math.floor(s.t / 1000))), pbMsg(3, pbInt(1, s.delay ?? 0), pbInt(2, Math.floor(s.t / 1000)))] : []),
      pbStr(4, String(s.stop)), ...(s.skipped ? [pbInt(5, 1)] : []))))));
  for (let i = 0; i < alerts; i++) ents.push(pbMsg(2, pbStr(1, `a${i}`), pbMsg(5, pbInt(6, 1), pbInt(7, 8))));
  return Buffer.concat([head, ...ents]);
}

/** ZIP mit Deflate: files = { name: Text } */
export function makeZip(files) {
  const locals = [], central = []; let off = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text), comp = deflateRawSync(data), nm = Buffer.from(name), extra = Buffer.from('xx');
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nm.length, 26); lh.writeUInt16LE(extra.length, 28);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(8, 10); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nm.length, 28); ch.writeUInt32LE(off, 42);
    locals.push(lh, nm, extra, comp); central.push(ch, nm); off += 30 + nm.length + extra.length + comp.length;
  }
  const cd = Buffer.concat(central), eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(Object.keys(files).length, 8); eocd.writeUInt16LE(Object.keys(files).length, 10); eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, eocd]);
}
