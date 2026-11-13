#!/usr/bin/env node
// Liefert docs/ und das Fixture (test/fixtures/web-data unter /d/) lokal aus – gemeinsam für test/browser.mjs, test/a11y.mjs und
// Lighthouse (lighthouserc.json). Antwortet gzip-komprimiert, wenn der Browser es anbietet, damit Größenmessungen den
// Übertragungsgrößen von GitHub Pages entsprechen.
//   node test/fixture-server.mjs [Port]   (Standard 8767; schreibt „bereit“, sobald er lauscht)
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import path from 'node:path';

export const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
export const FIX = path.join(ROOT, 'test/fixtures/web-data');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain', '.woff2': 'font/woff2', '.woff': 'font/woff' };
const PACK = new Set(['.html', '.js', '.css', '.json', '.svg', '.webmanifest', '.txt']);

/** Startet den Server. missing sammelt Fixture-Dateien, die die Seite anfragt und die fehlen (Hinweis, kein Fehler). */
export async function startFixtureServer(port, { missing = new Set(), bytes = null } = {}) {
  const server = http.createServer(async (req, res) => {
    const u = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const base = u.startsWith('/d/') ? FIX : u.startsWith('/data/') ? path.join(ROOT, 'data') : path.join(ROOT, 'docs');
    const rel = u.startsWith('/d/') ? u.slice(3) : u.startsWith('/data/') ? u.slice(6) : (u.endsWith('/') ? `${u}index.html` : u);
    const f = path.join(base, rel);
    if (!f.startsWith(base)) { res.writeHead(403).end(); return; }
    try {
      let b = await readFile(f); const ext = path.extname(f);
      const head = { 'content-type': TYPES[ext] || 'application/octet-stream', 'cache-control': 'no-store' };
      if (PACK.has(ext) && /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''))) { b = gzipSync(b, { level: 9 }); head['content-encoding'] = 'gzip'; }
      if (bytes) bytes.add(u, b.length);
      res.writeHead(200, head).end(b);
    } catch { if (u.startsWith('/d/')) missing.add(u.slice(3)); res.writeHead(404).end(); }
  });
  await new Promise(r => server.listen(port, '127.0.0.1', r));
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = +process.argv[2] || 8767;
  await startFixtureServer(port);
  console.log(`Fixture-Server bereit: http://127.0.0.1:${port}/?data=/d/`);
}
