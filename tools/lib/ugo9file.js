// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// The .ugo9 working file (the user's decision): the working JSON and its pictures in one file, a plain zip. The
// editor's Save and Open use it by default; a model.json with its pictures beside it still opens and saves as before.
//
//   const bytes = await writeUgo9(text, [['atlas.png', blob], ...]);   // -> Uint8Array
//   const { text, files } = await readUgo9(bytes);                     // files: [File]
//
// Inside: model.json (deflated where the platform can: CompressionStream) and every picture as it is (PNG, JPEG and
// WebP are compressed already). Read back: stored and deflated entries. No zip64 (a file stays under 4 GB), names
// in UTF-8. No outside library.
//
// manifest.json (the box's own card): { format: 'ugo9-pack', version: 1, model: 'model.json', savedBy, files: [{ name,
// role }] }, role 'texture' or 'underlay' for the pictures this editor writes. A file this editor does not know (not in
// the card, or with a role it does not know) is written again as it was, with its card entry, when the file is saved.

const CRC = new Uint32Array(256);
for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; CRC[n] = c >>> 0; }
export function crc32(bytes) {
  let c = -1;
  for (let i = 0; i < bytes.length; i++) c = CRC[(c ^ bytes[i]) & 255] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

const MODEL = 'model.json', MANIFEST = 'manifest.json';
/** The roles of the files this editor writes itself (a file with another role is kept as it is). */
export const KNOWN_ROLES = new Set(['texture', 'underlay']);
const bytesOf = async (x) => (x instanceof Uint8Array ? x : x instanceof ArrayBuffer ? new Uint8Array(x) : new Uint8Array(await x.arrayBuffer()));
async function through(stream, bytes) {
  const out = new Blob([bytes]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(out).arrayBuffer());
}
const canDeflate = () => typeof CompressionStream === 'function';

// DOS time and date of now (zip keeps a time per entry; tools show it)
function dosTime(d = new Date()) {
  return { time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() };
}

const deflated = async (bytes) => {
  if (canDeflate()) { try { const z = await through(new CompressionStream('deflate-raw'), bytes); if (z.length < bytes.length) return { data: z, method: 8 }; } catch { /* stored */ } }
  return { data: bytes, method: 0 };
};

/**
 * A .ugo9: the JSON text and the pictures ([[name, Blob | bytes, role?]], role 'texture' by default) in one zip, with
 * its card (manifest.json). `extras` ([{ path, file, entry }], from readUgo9's) are the files this editor did not
 * know: written again under their own paths, their card entries as they were. -> Uint8Array
 */
export async function writeUgo9(text, pictures = [], { extras = [], savedBy = null } = {}) {
  const enc = new TextEncoder(), { time, date } = dosTime(), entries = [], card = [];
  const json = enc.encode(text);
  entries.push({ name: MODEL, ...(await deflated(json)), crc: crc32(json), size: json.length });
  const seen = new Set([MODEL, MANIFEST]);
  for (const [name, pic, role = 'texture'] of pictures) {
    const base = String(name).split(/[\\/]/).pop();
    if (!base || seen.has(base)) continue;
    seen.add(base);
    const data = await bytesOf(pic);
    entries.push({ name: base, data, method: 0, crc: crc32(data), size: data.length });
    card.push({ name: base, role });
  }
  for (const x of extras) {
    if (!x?.path || seen.has(x.path)) continue; // a picture of this editor's under the same name wins
    seen.add(x.path);
    const raw = await bytesOf(x.file), packed = /\.(png|jpe?g|webp|gif|zip|gz|mp3|ogg|m4a|mp4|webm)$/i.test(x.path) ? { data: raw, method: 0 } : await deflated(raw);
    entries.push({ name: x.path, ...packed, crc: crc32(raw), size: raw.length });
    card.push(x.entry && typeof x.entry === 'object' ? { ...x.entry, name: x.path } : { name: x.path });
  }
  const manifest = enc.encode(JSON.stringify({ format: 'ugo9-pack', version: 1, model: MODEL, ...(savedBy ? { savedBy } : {}), files: card }, null, 2));
  entries.splice(1, 0, { name: MANIFEST, ...(await deflated(manifest)), crc: crc32(manifest), size: manifest.length });
  const parts = [], central = [];
  let offset = 0;
  for (const e of entries) {
    const name = enc.encode(e.name), head = new DataView(new ArrayBuffer(30));
    head.setUint32(0, 0x04034b50, true); head.setUint16(4, 20, true); head.setUint16(6, 0x0800, true); head.setUint16(8, e.method, true);
    head.setUint16(10, time, true); head.setUint16(12, date, true); head.setUint32(14, e.crc, true);
    head.setUint32(18, e.data.length, true); head.setUint32(22, e.size, true); head.setUint16(26, name.length, true); head.setUint16(28, 0, true);
    parts.push(new Uint8Array(head.buffer), name, e.data);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true); c.setUint16(10, e.method, true);
    c.setUint16(12, time, true); c.setUint16(14, date, true); c.setUint32(16, e.crc, true); c.setUint32(20, e.data.length, true); c.setUint32(24, e.size, true);
    c.setUint16(28, name.length, true); c.setUint32(42, offset, true);
    central.push(new Uint8Array(c.buffer), name);
    offset += 30 + name.length + e.data.length;
  }
  const cdSize = central.reduce((s, p) => s + p.length, 0), end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, entries.length, true); end.setUint16(10, entries.length, true);
  end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(end.buffer)], out = new Uint8Array(all.reduce((s, p) => s + p.length, 0));
  let at = 0;
  for (const p of all) { out.set(p, at); at += p.length; }
  return out;
}

/** True when the bytes look like a zip (a .ugo9). */
export const isZip = (bytes) => bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;

/**
 * Reads a .ugo9: { text (the model's JSON), files: [File] (every other file, named by its last part), entries: [{ path,
 * file }] (the same with their paths inside), manifest (the card, or null: a .ugo9 from before it) }. Throws
 * { code: 'notUgo9' } when it is not one.
 */
export async function readUgo9(input) {
  const bytes = await bytesOf(input), dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), dec = new TextDecoder();
  const bad = (why) => Object.assign(new Error(`not a .ugo9 (${why})`), { code: 'notUgo9', vars: { msg: why } });
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw bad('no zip directory');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true), text = null, manifest = null;
  const files = [], entries = [];
  for (let n = 0; n < count; n++) {
    if (p + 46 > bytes.length || dv.getUint32(p, true) !== 0x02014b50) throw bad('broken directory');
    const method = dv.getUint16(p + 10, true), crc = dv.getUint32(p + 16, true), csize = dv.getUint32(p + 20, true), size = dv.getUint32(p + 24, true);
    const nlen = dv.getUint16(p + 28, true), xlen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true), local = dv.getUint32(p + 42, true);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nlen));
    p += 46 + nlen + xlen + clen;
    if (name.endsWith('/')) continue; // a folder
    if (local + 30 > bytes.length || dv.getUint32(local, true) !== 0x04034b50) throw bad('broken entry');
    const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
    let data = bytes.subarray(start, start + csize);
    if (method === 8) { try { data = await through(new DecompressionStream('deflate-raw'), data); } catch { throw bad(`${name} is damaged`); } }
    else if (method !== 0) throw bad(`compression ${method}`);
    if (data.length !== size || crc32(data) !== crc) throw bad(`${name} is damaged`);
    const base = name.split('/').pop();
    if (base === MODEL && text === null) text = dec.decode(data);
    else if (name === MANIFEST && manifest === null) { try { manifest = JSON.parse(dec.decode(data)); } catch { manifest = {}; } }
    else {
      const file = new File([data], base, { type: /\.png$/i.test(base) ? 'image/png' : /\.jpe?g$/i.test(base) ? 'image/jpeg' : /\.webp$/i.test(base) ? 'image/webp' : '' });
      files.push(file); entries.push({ path: name, file });
    }
  }
  if (text === null) throw bad('no model.json inside');
  return { text, files, entries, manifest };
}

/**
 * The files in a read .ugo9 this editor does not know, to write again on saving: [{ path, file, entry }]. Known: in
 * the card with a known role, or (not in the card) a picture the model names now (`used`: last parts of the names).
 * A known picture the model no longer names is not kept (it was this editor's own and was let go).
 */
export function unknownEntries({ entries = [], manifest = null }, used = new Set()) {
  const card = new Map((Array.isArray(manifest?.files) ? manifest.files : []).filter((e) => e && typeof e.name === 'string').map((e) => [e.name, e]));
  return entries.filter(({ path }) => {
    const e = card.get(path);
    if (e) return !KNOWN_ROLES.has(e.role);
    return !used.has(path.split('/').pop());
  }).map(({ path, file }) => ({ path, file, entry: card.get(path) ?? null }));
}
