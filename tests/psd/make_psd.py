# SPDX-FileCopyrightText: 2026 U5143
# SPDX-License-Identifier: MIT
# Makes tests/psd/face.psd with psd-tools (an independent PSD writer), so the reader in
# tools/import_psd.mjs is checked against a file it did not write itself.
#   pip install psd-tools==1.26.0 && python3 tests/psd/make_psd.py
# Also writes face_layers.json: each layer's name, group path, box and the RGBA bytes' hash
# (with the layer mask applied, as Photoshop shows it).
import hashlib, json, os
from PIL import Image, ImageDraw
from psd_tools import PSDImage
from psd_tools.api.layers import PixelLayer, Group
from psd_tools.constants import BlendMode, Compression

here = os.path.dirname(os.path.abspath(__file__))
W, H = 320, 400

def shape(size, draw):
    im = Image.new('RGBA', size, (0, 0, 0, 0))
    draw(ImageDraw.Draw(im))
    return im

# PixelLayer.frompil(image, psd, name, top, left, compression)
psd = PSDImage.new('RGB', (W, H), depth=8)
body = PixelLayer.frompil(shape((200, 160), lambda d: d.rounded_rectangle((0, 0, 199, 159), 40, fill=(70, 110, 200, 255))), psd, 'body', 240, 60, Compression.RLE)
face = PixelLayer.frompil(shape((180, 190), lambda d: d.ellipse((0, 0, 179, 189), fill=(250, 220, 200, 255))), psd, 'face', 60, 70, Compression.RLE)
eyes = Group.new(psd, 'eyes')
eye_l = PixelLayer.frompil(shape((30, 40), lambda d: d.ellipse((0, 0, 29, 39), fill=(40, 40, 60, 255))), psd, 'eye', 130, 110, Compression.RLE)
eye_r = PixelLayer.frompil(shape((30, 40), lambda d: d.ellipse((0, 0, 29, 39), fill=(40, 40, 60, 255))), psd, 'eye', 130, 180, Compression.ZIP)
blush = PixelLayer.frompil(shape((60, 20), lambda d: d.ellipse((0, 0, 59, 19), fill=(255, 120, 120, 128))), psd, 'blush', 185, 130, Compression.ZIP_WITH_PREDICTION)
hidden = PixelLayer.frompil(shape((40, 40), lambda d: d.rectangle((0, 0, 39, 39), fill=(0, 255, 0, 255))), psd, 'hidden', 10, 10, Compression.RAW)
hidden.visible = False
shade = PixelLayer.frompil(shape((180, 40), lambda d: d.rectangle((0, 0, 179, 39), fill=(120, 80, 80, 255))), psd, 'shade', 60, 70, Compression.RLE)
shade.blend_mode = BlendMode.MULTIPLY
shade.opacity = 128
eyes.append(eye_l); eyes.append(eye_r)
for layer in (body, face, eyes, blush, shade, hidden):
    psd.append(layer)
psd.save(os.path.join(here, 'face.psd'))

# what an independent reader sees
back = PSDImage.open(os.path.join(here, 'face.psd'))
out = []
def walk(group, path):
    for layer in group:
        if layer.is_group():
            walk(layer, path + [layer.name])
            continue
        im = layer.topil().convert('RGBA')
        if layer.mask is not None and not layer.mask.disabled:
            # psd-tools keeps the picture's transparency in the layer mask; topil() leaves the
            # mask out, so apply it here (alpha x mask, in the mask's own box)
            mask = Image.new('L', im.size, layer.mask.background_color)
            mask.paste(layer.mask.topil(), (layer.mask.left - layer.left, layer.mask.top - layer.top))
            px, mp = im.load(), mask.load()
            for y in range(im.height):
                for x in range(im.width):
                    r, g, b, a = px[x, y]
                    px[x, y] = (r, g, b, (a * mp[x, y] + 127) // 255)
        out.append({'name': layer.name, 'groups': path, 'left': layer.left, 'top': layer.top, 'width': im.width, 'height': im.height,
                    'visible': layer.visible, 'opacity': layer.opacity, 'blend': str(layer.blend_mode), 'rgbaSha1': hashlib.sha1(im.tobytes()).hexdigest()})
walk(back, [])
json.dump({'width': W, 'height': H, 'layers': out}, open(os.path.join(here, 'face_layers.json'), 'w'), indent=1)
print(json.dumps(out, indent=1)[:800])

# face_v2.psd: the same picture after some changes, for reimportPsd: the face repainted and moved
# 3 px right, the blush layer removed, a mouth layer added; everything else as before
psd2 = PSDImage.new('RGB', (W, H), depth=8)
body2 = PixelLayer.frompil(shape((200, 160), lambda d: d.rounded_rectangle((0, 0, 199, 159), 40, fill=(70, 110, 200, 255))), psd2, 'body', 240, 60, Compression.RLE)
face2 = PixelLayer.frompil(shape((180, 190), lambda d: d.ellipse((0, 0, 179, 189), fill=(240, 200, 180, 255))), psd2, 'face', 60, 73, Compression.RLE)
eyes2 = Group.new(psd2, 'eyes')
eyes2.append(PixelLayer.frompil(shape((30, 40), lambda d: d.ellipse((0, 0, 29, 39), fill=(40, 40, 60, 255))), psd2, 'eye', 130, 110, Compression.RLE))
eyes2.append(PixelLayer.frompil(shape((30, 40), lambda d: d.ellipse((0, 0, 29, 39), fill=(40, 40, 60, 255))), psd2, 'eye', 130, 180, Compression.RLE))
mouth2 = PixelLayer.frompil(shape((40, 12), lambda d: d.rounded_rectangle((0, 0, 39, 11), 5, fill=(180, 60, 70, 255))), psd2, 'mouth', 200, 140, Compression.RLE)
for layer in (body2, face2, eyes2, mouth2):
    psd2.append(layer)
psd2.save(os.path.join(here, 'face_v2.psd'))

# clip.psd: clipping and blend modes (small). Bottom to top: skin (base), shadow (clipped to
# skin, multiply), light (clipped to skin, screen), glow (add), and in a folder "hat": brim
# (base) and band (clipped to brim). "stray" is clipped with nothing under it in its folder.
psd3 = PSDImage.new('RGB', (64, 64), depth=8)
skin = PixelLayer.frompil(shape((40, 40), lambda d: d.ellipse((0, 0, 39, 39), fill=(240, 200, 170, 255))), psd3, 'skin', 12, 12, Compression.RLE)
shadow = PixelLayer.frompil(shape((64, 20), lambda d: d.rectangle((0, 0, 63, 19), fill=(120, 80, 160, 255))), psd3, 'shadow', 30, 0, Compression.RLE)
shadow.clipping = True; shadow.blend_mode = BlendMode.MULTIPLY
light = PixelLayer.frompil(shape((20, 64), lambda d: d.rectangle((0, 0, 19, 63), fill=(90, 90, 40, 255))), psd3, 'light', 0, 30, Compression.RLE)
light.clipping = True; light.blend_mode = BlendMode.SCREEN
glow = PixelLayer.frompil(shape((16, 16), lambda d: d.ellipse((0, 0, 15, 15), fill=(60, 30, 0, 255))), psd3, 'glow', 4, 4, Compression.RLE)
glow.blend_mode = BlendMode.LINEAR_DODGE
hat = Group.new(psd3, 'hat')
stray = PixelLayer.frompil(shape((10, 10), lambda d: d.rectangle((0, 0, 9, 9), fill=(0, 0, 0, 255))), psd3, 'stray', 50, 50, Compression.RLE)
stray.clipping = True
brim = PixelLayer.frompil(shape((40, 8), lambda d: d.rectangle((0, 0, 39, 7), fill=(60, 60, 90, 255))), psd3, 'brim', 8, 12, Compression.RLE)
band = PixelLayer.frompil(shape((64, 4), lambda d: d.rectangle((0, 0, 63, 3), fill=(200, 40, 40, 255))), psd3, 'band', 10, 0, Compression.RLE)
band.clipping = True
for layer in (stray, brim, band):
    hat.append(layer)
for layer in (skin, shadow, light, glow, hat):
    psd3.append(layer)
psd3.save(os.path.join(here, 'clip.psd'))
back = PSDImage.open(os.path.join(here, 'clip.psd'))
print('clip.psd:', [(l.name, l.clipping, str(l.blend_mode)) for l in back.descendants()])

# nested.psd: folders in folders, for groupBones: body > (arm > hand), body > chest
psd4 = PSDImage.new('RGB', (64, 64), depth=8)
body4 = Group.new(psd4, 'body'); arm4 = Group.new(psd4, 'arm')
chest = PixelLayer.frompil(shape((20, 24), lambda d: d.rectangle((0, 0, 19, 23), fill=(90, 120, 200, 255))), psd4, 'chest', 30, 22, Compression.RLE)
upper = PixelLayer.frompil(shape((8, 16), lambda d: d.rectangle((0, 0, 7, 15), fill=(200, 160, 140, 255))), psd4, 'upper', 28, 44, Compression.RLE)
hand = PixelLayer.frompil(shape((8, 8), lambda d: d.ellipse((0, 0, 7, 7), fill=(240, 200, 180, 255))), psd4, 'hand', 44, 44, Compression.RLE)
arm4.append(upper); arm4.append(hand)
body4.append(chest); body4.append(arm4)
psd4.append(body4)
psd4.save(os.path.join(here, 'nested.psd'))


# vector.psd: a red square with a vector mask (a circle of 4 Bézier knots), written byte by byte
# here since psd-tools does not write vector masks (Photoshop File Formats Specification: 'vmsk').
# psd-tools reads the path back, but fills a rougher shape, so the test compares with the true disc.
import struct
def _vector_psd():
    W,H=64,64
    def fixed(v): return struct.pack('>i', int(round(v*2**24)))
    def knot(px,py,bx,by,ax,ay):  # before, anchor, after (canvas px)
        return struct.pack('>H',2)+fixed(by/H)+fixed(bx/W)+fixed(py/H)+fixed(px/W)+fixed(ay/H)+fixed(ax/W)
    # circle centre (32,32) r 20 with 4 Bézier knots
    cx,cy,R=32,32,20; k=0.5523*R
    pts=[(cx+R,cy,(cx+R,cy-k),(cx+R,cy+k)),(cx,cy+R,(cx+k,cy+R),(cx-k,cy+R)),(cx-R,cy,(cx-R,cy+k),(cx-R,cy-k)),(cx,cy-R,(cx-k,cy-R),(cx+k,cy-R))]
    recs=struct.pack('>H',6)+b'\0'*24  # fill rule record
    recs+=struct.pack('>H',8)+struct.pack('>H',0)+b'\0'*22  # initial fill: 0
    recs+=struct.pack('>HH',0,4)+b'\0'*22  # closed subpath, 4 knots
    for (ax,ay,b,a) in pts: recs+=knot(ax,ay,b[0],b[1],a[0],a[1])
    vmsk=struct.pack('>II',3,0)+recs
    def block(key,data):
        if len(data)%2: data+=b'\0'
        return b'8BIM'+key+struct.pack('>I',len(data))+data
    name=b'disc'; pas=bytes([len(name)])+name; pas+=b'\0'*((4-len(pas)%4)%4)
    extra=struct.pack('>I',0)+struct.pack('>I',0)+pas+block(b'vmsk',vmsk)
    lt,ll,lb,lr=4,4,60,60; w,h=lr-ll,lb-lt
    chans=[(-1,bytes([255])*(w*h)),(0,bytes([220])*(w*h)),(1,bytes([60])*(w*h)),(2,bytes([40])*(w*h))]
    rec=struct.pack('>iiiiH',lt,ll,lb,lr,4)+b''.join(struct.pack('>hI',cid,2+len(d)) for cid,d in chans)+b'8BIMnorm'+bytes([255,0,0,0])+struct.pack('>I',len(extra))+extra
    chdata=b''.join(struct.pack('>H',0)+d for cid,d in chans)
    li=struct.pack('>h',1)+rec+chdata
    if len(li)%2: li+=b'\0'
    lm=struct.pack('>I',len(li))+li+struct.pack('>I',0)
    psd=b'8BPS'+struct.pack('>H',1)+b'\0'*6+struct.pack('>HIIHH',3,H,W,8,3)+struct.pack('>I',0)+struct.pack('>I',0)+struct.pack('>I',len(lm))+lm+struct.pack('>H',0)+b'\0'*(3*W*H)
    open('tests/psd/vector.psd','wb').write(psd)
_vector_psd()
assert PSDImage.open(os.path.join(here, 'vector.psd'))[0].has_vector_mask()

# face16.psd: 16-bit, a layer with a gradient and one with a layer mask; face16_expected.png holds
# what psd-tools reads for each layer (8-bit RGBA, layers side by side, masks applied)
psd5 = PSDImage.new('RGB', (48, 32), depth=16)
grad = Image.new('RGBA', (24, 16)); gp = grad.load()
for y in range(16):
    for x in range(24): gp[x, y] = (x * 10, y * 15, 128, 255 if x < 20 else 120)
psd5.append(PixelLayer.frompil(grad, psd5, 'gradient', 4, 2, Compression.RLE))
psd5.append(PixelLayer.frompil(shape((16, 16), lambda d: d.ellipse((0, 0, 15, 15), fill=(30, 200, 90, 255))), psd5, 'dot', 10, 28, Compression.ZIP))
psd5.save(os.path.join(here, 'face16.psd'))
back16 = PSDImage.open(os.path.join(here, 'face16.psd'))
sheet = Image.new('RGBA', (sum(l.width for l in back16), max(l.height for l in back16)))
x0 = 0
for l in back16:
    im = l.topil().convert('RGBA')
    if l.mask is not None and not l.mask.disabled:
        m = Image.new('L', im.size, l.mask.background_color); m.paste(l.mask.topil(), (l.mask.left - l.left, l.mask.top - l.top))
        px, mp = im.load(), m.load()
        for yy in range(im.height):
            for xx in range(im.width):
                r_, g_, b_, a_ = px[xx, yy]; px[xx, yy] = (r_, g_, b_, (a_ * mp[xx, yy] + 127) // 255)
    sheet.paste(im, (x0, 0)); x0 += l.width
sheet.save(os.path.join(here, 'face16_expected.png'))

# folder_mask.psd: a folder with a layer mask (left half white, right half black) holding a blue
# square that fills the canvas: the square must show only on the left. Written byte by byte (psd-tools
# does not make folder masks); psd-tools reads it back as a group with a mask.
def _folder_mask_psd():
    W, H = 32, 32
    def block(key, data):
        return b'8BIM' + key + struct.pack('>I', len(data)) + data
    def record(name, rect, chans, blocks, mask=None):
        nm = name.encode('latin1'); pas = bytes([len(nm)]) + nm; pas += b'\0' * ((4 - len(pas) % 4) % 4)
        md = struct.pack('>iiiiBB', *mask, 0, 0) + b'\0\0' if mask else b''
        extra = struct.pack('>I', len(md)) + md + struct.pack('>I', 0) + pas + b''.join(blocks)
        return (struct.pack('>iiiiH', *rect, len(chans)) + b''.join(struct.pack('>hI', cid, 2 + len(d)) for cid, d in chans)
                + b'8BIMnorm' + bytes([255, 0, 0, 0]) + struct.pack('>I', len(extra)) + extra)
    empty = [(c, b'') for c in (-1, 0, 1, 2)]
    square = [(-1, bytes([255]) * (W * H)), (0, bytes([40]) * (W * H)), (1, bytes([80]) * (W * H)), (2, bytes([220]) * (W * H))]
    half = bytes(([255] * (W // 2) + [0] * (W // 2)) * H)
    recs = [record('</Layer group>', (0, 0, 0, 0), empty, [block(b'lsct', struct.pack('>I', 3))]),
            record('square', (0, 0, H, W), square, []),
            record('masked', (0, 0, 0, 0), empty + [(-2, half)], [block(b'lsct', struct.pack('>I', 1))], mask=(0, 0, H, W))]
    chans = [empty, square, empty + [(-2, half)]]
    data = b''.join(struct.pack('>H', 0) + d for cs in chans for _, d in cs)
    li = struct.pack('>h', 3) + b''.join(recs) + data
    if len(li) % 2: li += b'\0'
    lm = struct.pack('>I', len(li)) + li + struct.pack('>I', 0)
    psd = b'8BPS' + struct.pack('>H', 1) + b'\0' * 6 + struct.pack('>HIIHH', 3, H, W, 8, 3) + struct.pack('>I', 0) * 2 + struct.pack('>I', len(lm)) + lm + struct.pack('>H', 0) + b'\0' * (3 * W * H)
    open(os.path.join(here, 'folder_mask.psd'), 'wb').write(psd)
_folder_mask_psd()
_fm = PSDImage.open(os.path.join(here, 'folder_mask.psd'))
assert _fm[0].is_group() and _fm[0].mask is not None and _fm[0][0].name == 'square'
