# SPDX-FileCopyrightText: 2026 U5143
# SPDX-License-Identifier: MIT
# Small .procreate files for tests/procreate_test.mjs, laid out as the public descriptions of the
# format give it (the silicate and mica projects' notes): a ZIP with Document.archive (an
# NSKeyedArchiver binary plist: size "{w, h}", tileSize, unwrappedLayers top first, SilicaLayer /
# SilicaGroup, UUID, name, opacity, hidden, blend, clipped, mask), each layer's tiles in
# {UUID}/{col}~{row}.chunk (LZO1X of premultiplied RGBA; a mask's tiles: one grey channel) or
# .lz4 (Apple's "bv41" LZ4 blocks), and QuickLook/Thumbnail.png. The tiles are compressed by the
# system's own liblzo2 and liblz4 (through ctypes): the reader is tested against them, not
# against a compressor of our own. The truth (each layer's straight RGBA) goes to a .json.
#   python3 tests/procreate/make_procreate.py
import ctypes, ctypes.util, io, json, os, plistlib, struct, zipfile, hashlib
from PIL import Image

here = os.path.dirname(os.path.abspath(__file__))
lzo = ctypes.CDLL(ctypes.util.find_library('lzo2') or 'liblzo2.so.2')
lz4 = ctypes.CDLL(ctypes.util.find_library('lz4') or 'liblz4.so.1')

def lzo1x(data, best=False):
    out = ctypes.create_string_buffer(len(data) + len(data) // 16 + 64 + 3)
    n = ctypes.c_size_t(len(out))
    work = ctypes.create_string_buffer(1 << 20)
    f = lzo.lzo1x_999_compress if best else lzo.lzo1x_1_compress
    r = f(data, ctypes.c_size_t(len(data)), out, ctypes.byref(n), work)
    assert r == 0, r
    return out.raw[:n.value]

def bv41(data, block=65536):
    # Apple's LZ4 framing: 'bv41' decoded size, encoded size, LZ4 block; 'bv4-' raw; 'bv4$' end
    parts = []
    for i in range(0, len(data), block):
        src = data[i:i + block]
        cap = lz4.LZ4_compressBound(len(src))
        dst = ctypes.create_string_buffer(cap)
        n = lz4.LZ4_compress_default(src, dst, len(src), cap)
        if 0 < n < len(src):
            parts.append(b'bv41' + struct.pack('<II', len(src), n) + dst.raw[:n])
        else:
            parts.append(b'bv4-' + struct.pack('<I', len(src)) + src)
    return b''.join(parts) + b'bv4$'

def premultiply(px):
    r, g, b, a = px
    return (r * a + 127) // 255, (g * a + 127) // 255, (b * a + 127) // 255, a

def archive(doc):
    # NSKeyedArchiver: $objects holds every value; dicts point at them with UIDs
    objects = ['$null']
    def add(v):
        objects.append(v); return plistlib.UID(len(objects) - 1)
    classes = {}
    def cls(name, parents):
        if name not in classes: classes[name] = add({'$classname': name, '$classes': [name] + parents})
        return classes[name]
    def enc(v):
        if v is None: return plistlib.UID(0)
        if isinstance(v, bool) or isinstance(v, (int, float)): return v
        if isinstance(v, str): return add(v)
        if isinstance(v, bytes): return add(v)
        if isinstance(v, list):
            d = {'NS.objects': [], '$class': cls('NSArray', ['NSObject'])}
            uid = add(d); d['NS.objects'] = [enc(x) for x in v]; return uid
        if isinstance(v, dict):
            d = {}
            uid = add(d)
            for k, x in v.items():
                if k == '$class': d['$class'] = cls(x, ['NSObject'])
                else: d[k] = enc(x)
            return uid
        raise TypeError(v)
    root = enc(doc)
    return plistlib.dumps({'$archiver': 'NSKeyedArchiver', '$version': 100000, '$top': {'root': root}, '$objects': objects}, fmt=plistlib.FMT_BINARY)

def picture(w, h, f):
    return [[f(x, y) for x in range(w)] for y in range(h)]

def make(name, W, H, tile, layers, flip_rows=False, compress='lzo', orientation=1, background=None):
    # layers: top first, each { name, uuid, px (H x W straight RGBA rows) | children, opacity, hidden, blend, clipped, mask (H x W grey) }
    zbuf = io.BytesIO(); z = zipfile.ZipFile(zbuf, 'w', zipfile.ZIP_STORED)
    cols, rows = -(-W // tile), -(-H // tile)
    def tiles(uuid, grid, grey):
        for row in range(rows):
            for col in range(cols):
                x0, y0 = col * tile, row * tile
                tw, th = min(tile, W - x0), min(tile, H - y0)
                buf = bytearray()
                for ty in range(th):
                    y = y0 + ty
                    sy = H - 1 - y if flip_rows else y
                    for tx in range(tw):
                        v = grid[sy][x0 + tx]
                        buf += bytes([v]) if grey else bytes(premultiply(v))
                if not grey and not any(buf[3::4]): continue  # an empty tile is not written
                data = bytes(buf)
                if compress == 'lz4': z.writestr(f'{uuid}/{col}~{row}.lz4', bv41(data))
                else: z.writestr(f'{uuid}/{col}~{row}.chunk', lzo1x(data, best=(col + row) % 2 == 1))
    def node(L):
        if 'children' in L:
            return {'$class': 'SilicaGroup', 'name': L['name'], 'isHidden': L.get('hidden', False), 'children': [node(c) for c in L['children']]}
        tiles(L['uuid'], L['px'], False)
        d = {'$class': 'SilicaLayer', 'UUID': L['uuid'], 'name': L['name'], 'opacity': float(L.get('opacity', 1.0)), 'hidden': L.get('hidden', False),
             'blend': L.get('blend', 0), 'clipped': L.get('clipped', False), 'version': 1, 'mask': None}
        if 'extendedBlend' in L: d['extendedBlend'] = L['extendedBlend']
        if 'mask' in L:
            tiles(L['uuid'] + 'm', L['mask'], True)
            d['mask'] = {'$class': 'SilicaLayer', 'UUID': L['uuid'] + 'm', 'name': None, 'opacity': 1.0, 'hidden': False, 'blend': 0, 'clipped': False, 'version': 1, 'mask': None}
        return d
    bg = background or (1.0, 1.0, 1.0, 1.0)
    doc = {'$class': 'SilicaDocument', 'size': f'{{{W}, {H}}}', 'tileSize': tile, 'orientation': orientation, 'flippedHorizontally': False, 'flippedVertically': False,
           'backgroundHidden': background is None, 'backgroundColor': struct.pack('<4f', *bg), 'name': name, 'authorName': None, 'strokeCount': 1,
           'unwrappedLayers': [node(L) for L in layers], 'composite': None}
    z.writestr('Document.archive', archive(doc))
    # the thumbnail: the visible layers over each other (normal), as Procreate shows the canvas
    im = Image.new('RGBA', (W, H), tuple(round(c * 255) for c in bg) if background else (0, 0, 0, 0))
    def draw(L):
        if L.get('hidden'): return
        if 'children' in L:
            for c in reversed(L['children']): draw(c)
            return
        pic = Image.new('RGBA', (W, H)); pic.putdata([tuple(p) for row in L['px'] for p in row])
        im.alpha_composite(pic)
    for L in reversed(layers): draw(L)
    th = im.copy(); th.thumbnail((W // 2, H // 2))
    b = io.BytesIO(); th.save(b, 'PNG'); z.writestr('QuickLook/Thumbnail.png', b.getvalue())
    z.close()
    with open(os.path.join(here, f'{name}.procreate'), 'wb') as f: f.write(zbuf.getvalue())

def flat(L):
    if 'children' in L: return [x for c in L['children'] for x in flat(c)]
    return [L]

W, H, T = 300, 200, 128
sky = picture(W, H, lambda x, y: (60 + y // 2, 120 + x // 4, 230, 255))
sun = picture(W, H, lambda x, y: (255, 210, 60, 255 if (x - 220) ** 2 + (y - 60) ** 2 < 900 else (120 if (x - 220) ** 2 + (y - 60) ** 2 < 1200 else 0)))
hill = picture(W, H, lambda x, y: (40 + x // 6, 150, 60, 255 if y > 140 + 20 * ((x // 30) % 2) else 0))
shade = picture(W, H, lambda x, y: (20, 20, 80, 200 if 100 < x < 250 and y > 120 else 0))
note = picture(W, H, lambda x, y: (255, 0, 0, 255 if 10 < x < 40 and 10 < y < 40 else 0))
mask = [[255 if x < 200 else (x - 200) * 2 if x < 300 else 0 for x in range(W)] for y in range(H)]
mask = [[max(0, 255 - v) for v in row] for row in mask]  # fades out to the right
layers = [
    {'name': 'メモ', 'uuid': 'A1B2-0005', 'px': note, 'hidden': True},
    {'name': '影', 'uuid': 'A1B2-0004', 'px': shade, 'blend': 1, 'clipped': True, 'opacity': 0.5},
    {'name': '景色', 'children': [
        {'name': '丘', 'uuid': 'A1B2-0003', 'px': hill, 'mask': mask},
        {'name': '太陽', 'uuid': 'A1B2-0002', 'px': sun, 'blend': 2, 'extendedBlend': 2}]},
    {'name': '空', 'uuid': 'A1B2-0001', 'px': sky},
]
make('scene', W, H, T, layers)
make('scene_lz4', W, H, T, layers, compress='lz4')
make('scene_flipped', W, H, T, layers, flip_rows=True)  # rows stored bottom up: the thumbnail tells
make('paper', 100, 80, 64, [{'name': 'ink', 'uuid': 'C0FF-0001', 'px': picture(100, 80, lambda x, y: (0, 0, 0, 255 if x == y else 0))}], background=(0.95, 0.9, 0.8, 1.0))
# the truth: each layer as a reader gives it back (premultiplied in the file, so the colours of
# half-transparent pixels round; the mask times the transparency), SHA-256 of the straight RGBA
def back(px, m=None):
    out = bytearray()
    for y, row in enumerate(px):
        for x, p in enumerate(row):
            r, g, b, a = premultiply(p)
            if 0 < a < 255: r, g, b = (min(255, int(c * 255 / a + 0.5)) for c in (r, g, b))
            if m is not None: a = int(a * m[y][x] / 255 + 0.5)
            out += bytes((r, g, b, a))
    return bytes(out)
truth = {}
for L in flat({'children': layers}):
    truth[L['name']] = hashlib.sha256(back(L['px'], L.get('mask'))).hexdigest()
with open(os.path.join(here, 'expected.json'), 'w') as f: json.dump(truth, f, ensure_ascii=False, indent=1, sort_keys=True)
print('ok', sorted(p for p in os.listdir(here) if p.endswith('.procreate')))

# LZO1X streams of the system's liblzo2 over data that takes every kind of instruction: long
# literal runs (noise), long matches (zeros), far matches (a block repeated after 20 KB: past the
# 16 KB of the near ones, and past 32 KB), text; with both compressors. lzo_cases.json: the
# compressed stream (base64), and the original's length and SHA-256 (it is made again here only)
import base64, random
rnd = random.Random(9)
noise = bytes(rnd.randrange(256) for _ in range(3000))
block = bytes(rnd.randrange(256) for _ in range(300))
cases = {
    'noise': noise, 'zeros': bytes(30000), 'far': block + bytes(20000) + block + bytes(40000) + block[::-1] + block,
    'text': (' '.join(f'layer {i} of {i * 7 % 13} tiles' for i in range(600))).encode(),
    'mixed': b''.join(noise[i:i + 37] + bytes(i % 300) + block[i % 200:i % 200 + 90] for i in range(0, 3000, 97)),
}
out = {}
for k, d in cases.items():
    for best in (False, True):
        out[f'{k}{"_999" if best else "_1"}'] = {'length': len(d), 'sha256': hashlib.sha256(d).hexdigest(), 'lzo': base64.b64encode(lzo1x(d, best)).decode()}
with open(os.path.join(here, 'lzo_cases.json'), 'w') as f: json.dump(out, f, indent=0)
print('lzo cases', len(out))
