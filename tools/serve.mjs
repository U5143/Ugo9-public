// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// Tiny static file server for the demo: node tools/serve.mjs [port]
// Serves the repository folder; open the printed URL.
// Also relays messages between pages over a WebSocket at /relay (localhost
// only): the VTuber page sends tracked parameters, the display page that OBS
// shows receives them. And keeps the model the VTuber page opened, in memory, at
// /vtuber/model (POST to set, GET to read, DELETE to forget; 64 MB at most), so
// the display page (another browser) can show it too.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.argv[2]) || 8099;
const types = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm', '.png': 'image/png', '.json': 'application/json', '.ug9': 'application/octet-stream', '.ugo': 'application/octet-stream', '.ug9x': 'application/json',
  '.css': 'text/css', '.gif': 'image/gif',
};

const MAX_MODEL = 64 * 1024 * 1024;
let sharedModel = null; // the VTuber page's model: one blob (its own small header, the .ug9, the images)

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/vtuber/model') {
    if (req.method === 'GET') {
      if (!sharedModel) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store' });
      return res.end(sharedModel);
    }
    if (req.method === 'DELETE') { sharedModel = null; res.writeHead(204); return res.end(); }
    if (req.method === 'POST') {
      const parts = [];
      let size = 0;
      req.on('data', (c) => { size += c.length; if (size > MAX_MODEL) { res.writeHead(413); res.end(); req.destroy(); } else parts.push(c); });
      req.on('end', () => { if (size <= MAX_MODEL) { sharedModel = Buffer.concat(parts); res.writeHead(204); res.end(); } });
      return;
    }
    res.writeHead(405); return res.end();
  }
  let file = path.join(root, decodeURIComponent(url.pathname));
  if (!file.startsWith(root)) { res.writeHead(403); return res.end(); }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': types[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

// ---- /relay: minimal WebSocket (RFC 6455) broadcast of small text messages ----
const MAX_MESSAGE = 64 * 1024;
const clients = new Set();

function frame(text) {
  const body = Buffer.from(text);
  const head = body.length < 126 ? Buffer.from([0x81, body.length])
    : Buffer.from([0x81, 126, body.length >> 8, body.length & 255]);
  return Buffer.concat([head, body]);
}

server.on('upgrade', (req, socket) => {
  const url = new URL(req.url, 'http://localhost');
  const key = req.headers['sec-websocket-key'];
  if (url.pathname !== '/relay' || !key) { socket.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  socket.setNoDelay(true);
  clients.add(socket);
  let buf = Buffer.alloc(0);
  const drop = () => { clients.delete(socket); socket.destroy(); };
  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 2) {
      const op = buf[0] & 0x0f, masked = buf[1] & 0x80;
      let len = buf[1] & 0x7f, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) return drop(); // messages here are small
      if (len > MAX_MESSAGE || !masked) return drop(); // browsers always mask
      if (buf.length < off + 4 + len) return;
      const mask = buf.subarray(off, off + 4);
      const data = Buffer.from(buf.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
      buf = buf.subarray(off + 4 + len);
      if (op === 0x8) return drop();
      if (op === 0x9) { socket.write(Buffer.concat([Buffer.from([0x8a, data.length]), data])); continue; }
      if (op !== 0x1) continue;
      const out = frame(data.toString());
      for (const c of clients) if (c !== socket) c.write(out);
    }
  });
  socket.on('close', () => clients.delete(socket));
  socket.on('error', () => clients.delete(socket));
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Ugo9 demo:   http://localhost:${port}/web/`);
  console.log(`Ugo9 VTuber: http://localhost:${port}/web/vtuber.html`);
  console.log(`Ugo9 editor: http://localhost:${port}/editor/`);
});
