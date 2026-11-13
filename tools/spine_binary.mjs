// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// Spine binary skeleton (.skel / .skel.bytes) -> the same object shape as
// Spine's JSON export, so tools/import_spine.mjs can take either file.
//
// Written from Esoteric Software's published description of the binary
// format (esotericsoftware.com/spine-binary-format, the 3.8 layout) without
// using or reading the Spine Runtimes. Where that page is unclear, the reading
// was settled against real 3.8.95 exports (see docs/Spine.md):
//   - a weighted vertex is varint+ bone count, then per bone varint+ index and
//     float x, y, weight (the page swaps the weighted / unweighted cases)
//   - an animation starts with its name (string)
//   - a deform key's first varint+ is the value count; values start at "start"
//   - a draw order "amount" is a plain varint holding a signed int (negative
//     offsets take 5 bytes)
// Only 3.8 files are read; 4.x binaries are rejected with a clear message.

const BLEND = ['normal', 'additive', 'multiply', 'screen'];
const INHERIT = ['normal', 'onlyTranslation', 'noRotationOrReflection', 'noScale', 'noScaleOrReflection'];
const POSITION = ['fixed', 'percent'];
const SPACING = ['length', 'fixed', 'percent'];
const ROTATE = ['tangent', 'chain', 'chainScale'];
const ATTACHMENT = ['region', 'boundingbox', 'mesh', 'linkedmesh', 'path', 'point', 'clipping'];

class Reader {
  constructor(bytes) {
    this.b = bytes;
    this.v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.p = 0;
    this.text = new TextDecoder('utf-8');
    this.strings = [];
  }
  need(n) { if (this.p + n > this.b.length) throw new Error(`unexpected end of file at byte ${this.p}`); }
  byte() { this.need(1); return this.b[this.p++]; }
  sbyte() { const v = this.byte(); return v > 127 ? v - 256 : v; }
  bool() { return this.byte() !== 0; }
  short() { this.need(2); const v = this.v.getInt16(this.p); this.p += 2; return v; }
  int() { this.need(4); const v = this.v.getInt32(this.p); this.p += 4; return v; }
  float() { this.need(4); const v = this.v.getFloat32(this.p); this.p += 4; return v; }
  varint(positive = true) {
    let value = 0, shift = 0, b;
    do {
      b = this.byte();
      value |= (b & 0x7f) << shift;
      shift += 7;
    } while ((b & 0x80) && shift < 35);
    return positive ? value >>> 0 : (value >>> 1) ^ -(value & 1);
  }
  count(limit = 1 << 24) {
    const n = this.varint();
    if (n > limit || n > this.b.length - this.p + 1) throw new Error(`count ${n} too large at byte ${this.p}`);
    return n;
  }
  string() {
    const n = this.count();
    if (n === 0) return null;
    if (n === 1) return '';
    this.need(n - 1);
    const s = this.text.decode(this.b.subarray(this.p, this.p + n - 1));
    this.p += n - 1;
    return s;
  }
  ref() {
    const i = this.varint();
    if (i === 0) return null;
    if (i - 1 >= this.strings.length) throw new Error(`shared string ${i - 1} out of range at byte ${this.p}`);
    return this.strings[i - 1];
  }
  color() { return (this.int() >>> 0).toString(16).padStart(8, '0'); }
  floats(n) { const a = new Array(n); for (let i = 0; i < n; i++) a[i] = this.float(); return a; }
}

const pick = (list, i, what) => {
  if (i < 0 || i >= list.length) throw new Error(`${what} ${i} out of range`);
  return list[i];
};

/** Reads a Spine 3.8 binary skeleton into Spine-JSON-shaped data. */
export function readSpineBinary(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const r = new Reader(bytes);
  const skeleton = {};
  skeleton.hash = r.string();
  skeleton.spine = r.string() || '';
  const major = Number(skeleton.spine.split('.')[0]), minor = Number(skeleton.spine.split('.')[1]);
  if (!(major === 3 && minor === 8)) {
    throw new Error(`Spine binary ${skeleton.spine || '(unknown version)'} is not supported; only 3.8 binaries can be read (export JSON instead)`);
  }
  skeleton.x = r.float(); skeleton.y = r.float(); skeleton.width = r.float(); skeleton.height = r.float();
  const nonessential = r.bool();
  if (nonessential) { skeleton.fps = r.float(); skeleton.images = r.string(); skeleton.audio = r.string(); }
  const nStrings = r.count();
  for (let i = 0; i < nStrings; i++) r.strings.push(r.string());

  const bones = [];
  const nBones = r.count();
  for (let i = 0; i < nBones; i++) {
    const b = { name: r.string() };
    if (i > 0) b.parent = pick(bones, r.varint(), 'parent bone').name;
    b.rotation = r.float(); b.x = r.float(); b.y = r.float();
    b.scaleX = r.float(); b.scaleY = r.float(); b.shearX = r.float(); b.shearY = r.float();
    b.length = r.float();
    b.transform = pick(INHERIT, r.varint(), 'inherit mode');
    b.skin = r.bool();
    if (nonessential) b.color = r.color();
    bones.push(b);
  }

  const slots = [];
  const nSlots = r.count();
  for (let i = 0; i < nSlots; i++) {
    const s = { name: r.string() };
    s.bone = pick(bones, r.varint(), 'slot bone').name;
    s.color = r.color();
    const dark = r.int();
    if (dark !== -1) s.dark = (dark >>> 0).toString(16).padStart(8, '0').slice(2);
    const att = r.ref();
    if (att != null) s.attachment = att;
    s.blend = pick(BLEND, r.varint(), 'blend mode');
    slots.push(s);
  }

  const ik = [];
  for (let i = 0, n = r.count(); i < n; i++) {
    const c = { name: r.string(), order: r.varint(), skin: r.bool(), bones: [] };
    for (let j = 0, m = r.count(); j < m; j++) c.bones.push(pick(bones, r.varint(), 'ik bone').name);
    c.target = pick(bones, r.varint(), 'ik target').name;
    c.mix = r.float(); c.softness = r.float(); c.bendPositive = r.sbyte() > 0;
    c.compress = r.bool(); c.stretch = r.bool(); c.uniform = r.bool();
    ik.push(c);
  }
  const transform = [];
  for (let i = 0, n = r.count(); i < n; i++) {
    const c = { name: r.string(), order: r.varint(), skin: r.bool(), bones: [] };
    for (let j = 0, m = r.count(); j < m; j++) c.bones.push(pick(bones, r.varint(), 'transform bone').name);
    c.target = pick(bones, r.varint(), 'transform target').name;
    c.local = r.bool(); c.relative = r.bool();
    c.rotation = r.float(); c.x = r.float(); c.y = r.float(); c.scaleX = r.float(); c.scaleY = r.float(); c.shearY = r.float();
    c.rotateMix = r.float(); c.translateMix = r.float(); c.scaleMix = r.float(); c.shearMix = r.float();
    transform.push(c);
  }
  const path = [];
  for (let i = 0, n = r.count(); i < n; i++) {
    const c = { name: r.string(), order: r.varint(), skin: r.bool(), bones: [] };
    for (let j = 0, m = r.count(); j < m; j++) c.bones.push(pick(bones, r.varint(), 'path bone').name);
    c.target = pick(slots, r.varint(), 'path target slot').name;
    c.positionMode = pick(POSITION, r.varint(), 'position mode');
    c.spacingMode = pick(SPACING, r.varint(), 'spacing mode');
    c.rotateMode = pick(ROTATE, r.varint(), 'rotate mode');
    c.rotation = r.float(); c.position = r.float(); c.spacing = r.float();
    c.rotateMix = r.float(); c.translateMix = r.float();
    path.push(c);
  }

  const readVertices = (count) => {
    if (!r.bool()) return r.floats(count * 2);
    const out = [];
    for (let i = 0; i < count; i++) {
      const n = r.count(64);
      out.push(n);
      for (let j = 0; j < n; j++) {
        const bi = r.varint();
        if (bi >= bones.length) throw new Error(`vertex bone ${bi} out of range`);
        out.push(bi, r.float(), r.float(), r.float());
      }
    }
    return out;
  };

  const readSkin = (name, isDefault) => {
    const skin = { name, attachments: {} };
    if (!isDefault) {
      const lists = { bones: bones, ik, transform, path };
      for (const [key, list] of Object.entries(lists)) {
        const n = r.count();
        if (n) skin[key] = [];
        for (let j = 0; j < n; j++) skin[key].push(pick(list, r.varint(), `skin ${key}`).name);
      }
    }
    for (let i = 0, n = r.count(); i < n; i++) {
      const slot = pick(slots, r.varint(), 'skin slot').name;
      const atts = skin.attachments[slot] = {};
      for (let j = 0, m = r.count(); j < m; j++) {
        const placeholder = r.ref();
        const actual = r.ref();
        const type = pick(ATTACHMENT, r.byte(), 'attachment type');
        const a = { type };
        if (actual != null && actual !== placeholder) a.name = actual;
        if (type === 'region') {
          const p = r.ref(); if (p != null) a.path = p;
          a.rotation = r.float(); a.x = r.float(); a.y = r.float(); a.scaleX = r.float(); a.scaleY = r.float();
          a.width = r.float(); a.height = r.float(); a.color = r.color();
        } else if (type === 'boundingbox') {
          a.vertexCount = r.count(); a.vertices = readVertices(a.vertexCount);
          if (nonessential) a.color = r.color();
        } else if (type === 'mesh') {
          const p = r.ref(); if (p != null) a.path = p;
          a.color = r.color();
          const n2 = r.count();
          a.uvs = r.floats(n2 * 2);
          const nt = r.count();
          a.triangles = []; for (let k = 0; k < nt; k++) a.triangles.push(r.short() & 0xffff);
          a.vertices = readVertices(n2);
          a.hull = r.varint();
          if (nonessential) {
            const ne = r.count(); a.edges = []; for (let k = 0; k < ne; k++) a.edges.push(r.short() & 0xffff);
            a.width = r.float(); a.height = r.float();
          }
        } else if (type === 'linkedmesh') {
          const p = r.ref(); if (p != null) a.path = p;
          a.color = r.color();
          const sk = r.ref(); if (sk != null) a.skin = sk;
          a.parent = r.ref();
          a.deform = r.bool();
          if (nonessential) { a.width = r.float(); a.height = r.float(); }
        } else if (type === 'path') {
          a.closed = r.bool(); a.constantSpeed = r.bool();
          a.vertexCount = r.count(); a.vertices = readVertices(a.vertexCount);
          a.lengths = r.floats(Math.floor(a.vertexCount / 3));
          if (nonessential) a.color = r.color();
        } else if (type === 'point') {
          a.rotation = r.float(); a.x = r.float(); a.y = r.float();
          if (nonessential) a.color = r.color();
        } else if (type === 'clipping') {
          a.end = pick(slots, r.varint(), 'clipping end slot').name;
          a.vertexCount = r.count(); a.vertices = readVertices(a.vertexCount);
          if (nonessential) a.color = r.color();
        }
        atts[placeholder] = a;
      }
    }
    return skin;
  };

  const skins = [];
  const def = readSkin('default', true);
  if (Object.keys(def.attachments).length) skins.push(def);
  for (let i = 0, n = r.count(); i < n; i++) skins.push(readSkin(r.ref(), false));

  const events = {};
  const eventNames = [];
  for (let i = 0, n = r.count(); i < n; i++) {
    const name = r.ref();
    const e = { int: r.varint(false), float: r.float() };
    const s = r.string(); if (s != null) e.string = s;
    const audio = r.string();
    if (audio != null) { e.audio = audio; e.volume = r.float(); e.balance = r.float(); }
    events[name] = e;
    eventNames.push(name);
  }

  // curve of a key (all but the last key of a timeline), in 3.8 JSON terms
  const curve = (k) => {
    const t = r.byte();
    if (t === 1) k.curve = 'stepped';
    else if (t === 2) { k.curve = r.float(); k.c2 = r.float(); k.c3 = r.float(); k.c4 = r.float(); }
    else if (t !== 0) throw new Error(`curve type ${t} at byte ${r.p - 1}`);
    return k;
  };
  const keys = (read) => {
    const n = r.count(), out = [];
    for (let i = 0; i < n; i++) { const k = read(); if (i < n - 1) curve(k); out.push(k); }
    return out;
  };

  const animations = {};
  for (let i = 0, n = r.count(); i < n; i++) {
    const name = r.string();
    const a = {};
    for (let s = 0, ns = r.count(); s < ns; s++) {
      const slot = pick(slots, r.varint(), 'animated slot').name;
      const tl = ((a.slots ||= {})[slot] = {});
      for (let t = 0, nt = r.count(); t < nt; t++) {
        const type = r.byte();
        if (type === 0) {
          tl.attachment = [];
          for (let k = 0, nk = r.count(); k < nk; k++) tl.attachment.push({ time: r.float(), name: r.ref() });
        } else if (type === 1) tl.color = keys(() => ({ time: r.float(), color: r.color() }));
        else if (type === 2) tl.twoColor = keys(() => ({ time: r.float(), light: r.color(), dark: r.color().slice(2) }));
        else throw new Error(`slot timeline type ${type} at byte ${r.p - 1}`);
      }
    }
    for (let b = 0, nb = r.count(); b < nb; b++) {
      const bone = pick(bones, r.varint(), 'animated bone').name;
      const tl = ((a.bones ||= {})[bone] = {});
      for (let t = 0, nt = r.count(); t < nt; t++) {
        const type = r.byte();
        if (type === 0) tl.rotate = keys(() => ({ time: r.float(), angle: r.float() }));
        else if (type <= 3) tl[['', 'translate', 'scale', 'shear'][type]] = keys(() => ({ time: r.float(), x: r.float(), y: r.float() }));
        else throw new Error(`bone timeline type ${type} at byte ${r.p - 1}`);
      }
    }
    for (let c = 0, nc = r.count(); c < nc; c++) {
      const cname = pick(ik, r.varint(), 'ik timeline').name;
      (a.ik ||= {})[cname] = keys(() => ({ time: r.float(), mix: r.float(), softness: r.float(), bendPositive: r.sbyte() > 0, compress: r.bool(), stretch: r.bool() }));
    }
    for (let c = 0, nc = r.count(); c < nc; c++) {
      const cname = pick(transform, r.varint(), 'transform timeline').name;
      (a.transform ||= {})[cname] = keys(() => ({ time: r.float(), rotateMix: r.float(), translateMix: r.float(), scaleMix: r.float(), shearMix: r.float() }));
    }
    for (let c = 0, nc = r.count(); c < nc; c++) {
      const cname = pick(path, r.varint(), 'path timeline').name;
      const tl = ((a.path ||= {})[cname] = {});
      for (let t = 0, nt = r.count(); t < nt; t++) {
        const type = r.byte();
        if (type === 0) tl.position = keys(() => ({ time: r.float(), position: r.float() }));
        else if (type === 1) tl.spacing = keys(() => ({ time: r.float(), spacing: r.float() }));
        else if (type === 2) tl.mix = keys(() => ({ time: r.float(), rotateMix: r.float(), translateMix: r.float() }));
        else throw new Error(`path timeline type ${type} at byte ${r.p - 1}`);
      }
    }
    for (let s = 0, ns = r.count(); s < ns; s++) {
      const skin = pick(skins, r.varint(), 'deform skin').name;
      for (let sl = 0, nsl = r.count(); sl < nsl; sl++) {
        const slot = pick(slots, r.varint(), 'deform slot').name;
        for (let t = 0, nt = r.count(); t < nt; t++) {
          const att = r.ref();
          (((a.deform ||= {})[skin] ||= {})[slot] ||= {})[att] = keys(() => {
            const k = { time: r.float() };
            const count = r.count();
            if (count) {
              k.offset = r.varint();
              k.vertices = r.floats(count);
            }
            return k;
          });
        }
      }
    }
    const nd = r.count();
    if (nd) {
      a.drawOrder = [];
      for (let d = 0; d < nd; d++) {
        const k = { time: r.float(), offsets: [] };
        for (let c = 0, nc = r.count(); c < nc; c++) k.offsets.push({ slot: pick(slots, r.varint(), 'draw order slot').name, offset: r.varint() | 0 }); // a plain varint of a signed int
        a.drawOrder.push(k);
      }
    }
    const ne = r.count();
    if (ne) {
      a.events = [];
      for (let e = 0; e < ne; e++) {
        const k = { time: r.float() };
        const ename = pick(eventNames, r.varint(), 'event');
        k.name = ename;
        k.int = r.varint(false); k.float = r.float();
        if (r.bool()) k.string = r.string();
        if (events[ename].audio != null) { k.volume = r.float(); k.balance = r.float(); }
        a.events.push(k);
      }
    }
    animations[name] = a;
  }
  if (r.p !== bytes.length) throw new Error(`${bytes.length - r.p} bytes left over after the last animation`);

  const out = { skeleton, bones, slots };
  if (ik.length) out.ik = ik;
  if (transform.length) out.transform = transform;
  if (path.length) out.path = path;
  out.skins = skins;
  if (eventNames.length) out.events = events;
  out.animations = animations;
  return out;
}

/** True when the bytes look like a binary skeleton rather than JSON text. */
export function isSpineBinary(bytes) {
  let i = 0;
  while (i < bytes.length && (bytes[i] === 0x20 || bytes[i] === 0x0a || bytes[i] === 0x0d || bytes[i] === 0x09 || bytes[i] === 0xef || bytes[i] === 0xbb || bytes[i] === 0xbf)) i++;
  return bytes[i] !== 0x7b; // '{'
}
