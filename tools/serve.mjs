// Minimal static server for local testing (adds the cross-origin isolation headers GitHub Pages
// lacks; in production the service worker adds them).
import http from 'http';
import fs from 'fs';
import path from 'path';
const root = path.resolve(process.argv[2] || '.');
const port = Number(process.argv[3] || 8765);
const coi = process.argv[4] !== 'nocoi';
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.wasm': 'application/wasm', '.onnx': 'application/octet-stream', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.jpg': 'image/jpeg', '.mp4': 'video/mp4', '.webm': 'video/webm' };
http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.endsWith('/')) p += 'index.html';
  const f = path.join(root, p);
  if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
  const st = fs.statSync(f);
  const h = { 'Content-Type': types[path.extname(f)] || 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': 'no-store', 'Accept-Ranges': 'bytes' };
  if (coi) { h['Cross-Origin-Opener-Policy'] = 'same-origin'; h['Cross-Origin-Embedder-Policy'] = 'require-corp'; }
  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d+)-(\d*)/.exec(range);
    const start = Number(m[1]), end = m[2] ? Number(m[2]) : st.size - 1;
    h['Content-Range'] = `bytes ${start}-${end}/${st.size}`; h['Content-Length'] = end - start + 1;
    res.writeHead(206, h); fs.createReadStream(f, { start, end }).pipe(res); return;
  }
  res.writeHead(200, h); fs.createReadStream(f).pipe(res);
}).listen(port, () => console.log('serving', root, 'on', port, coi ? '(COI)' : ''));
