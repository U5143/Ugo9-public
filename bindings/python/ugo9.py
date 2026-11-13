# SPDX-FileCopyrightText: 2026 U5143
# SPDX-License-Identifier: MIT
"""Ugo9's core from Python (ctypes, the standard library only): load a .ug9, set parameters, play
animations, update, read bones and the deformed mesh, and draw frames on the processor to PNG. For
exporting and batch work; the core itself is the same C as everywhere (docs/芯のAPI.md).

    import ugo9
    model = ugo9.Model.open("samples/basic/model.ug9")      # textures read from next to it
    inst = model.instance()
    inst.play("idle", 0.5); inst.update(1 / 30)
    model.save_png("frame.png", inst.render(420, 600))

The shared library: build it with CMake (-DUGO_SHARED=ON) or `cc -shared -fPIC`; it is found from
UGO9_LIB, next to this file, or in build/ of the repository.
"""
import ctypes
import os
import struct
import zlib

_here = os.path.dirname(os.path.abspath(__file__))


def _load_library():
    names = {"nt": ["ugo.dll"], "posix": ["libugo.so", "libugo.dylib"]}.get(os.name, ["libugo.so"])
    candidates = [os.environ.get("UGO9_LIB", "")]
    for d in (_here, os.path.join(_here, "..", "..", "build")):
        candidates += [os.path.join(d, n) for n in names]
    for c in candidates:
        if c and os.path.exists(c):
            return ctypes.CDLL(c)
    raise OSError("Ugo9: the core's shared library was not found (set UGO9_LIB, or build it with -DUGO_SHARED=ON)")


_lib = _load_library()
_u32, _f32, _p, _i32 = ctypes.c_uint32, ctypes.c_float, ctypes.c_void_p, ctypes.c_int


def _sig(name, res, *args):
    f = getattr(_lib, name)
    f.restype, f.argtypes = res, list(args)
    return f


_c = {n: _sig(n, r, *a) for n, r, a in [
    ("ugo_version", _u32, ()), ("ugo_last_error", _i32, ()),
    ("ugo_model_mem_size_for", _u32, (_p, _u32)), ("ugo_model_init_sized", _p, (_p, _u32, _p, _u32)),
    ("ugo_model_format", _u32, (_p,)), ("ugo_model_warnings", _u32, (_p,)),
    ("ugo_param_count", _u32, (_p,)), ("ugo_param_name", ctypes.c_char_p, (_p, _u32)),
    ("ugo_param_min", _f32, (_p, _u32)), ("ugo_param_max", _f32, (_p, _u32)), ("ugo_param_default", _f32, (_p, _u32)),
    ("ugo_find_param", _i32, (_p, ctypes.c_char_p)), ("ugo_find_animation", _i32, (_p, ctypes.c_char_p)),
    ("ugo_animation_count", _u32, (_p,)), ("ugo_animation_name", ctypes.c_char_p, (_p, _u32)),
    ("ugo_animation_duration", _f32, (_p, _u32)), ("ugo_animation_loop", _i32, (_p, _u32)),
    ("ugo_bone_count", _u32, (_p,)), ("ugo_bone_name", ctypes.c_char_p, (_p, _u32)),
    ("ugo_part_count", _u32, (_p,)), ("ugo_part_name", ctypes.c_char_p, (_p, _u32)),
    ("ugo_vertex_count", _u32, (_p,)), ("ugo_texture_count", _u32, (_p,)), ("ugo_texture_name", ctypes.c_char_p, (_p, _u32)),
    ("ugo_canvas", ctypes.POINTER(_f32), (_p,)), ("ugo_expression_count", _u32, (_p,)), ("ugo_expression_name", ctypes.c_char_p, (_p, _u32)),
    ("ugo_instance_mem_size", _u32, (_p,)), ("ugo_instance_init", _p, (_p, _p)),
    ("ugo_reset_params", None, (_p,)), ("ugo_set_param", None, (_p, _u32, _f32)), ("ugo_get_param", _f32, (_p, _u32)),
    ("ugo_apply_animation", None, (_p, _u32, _f32, _f32)), ("ugo_apply_expression", None, (_p, _u32, _f32)),
    ("ugo_set_transform", None, (_p, _f32, _f32, _f32, _f32, _f32, _f32)), ("ugo_set_wind", None, (_p, _f32, _f32, _f32)),
    ("ugo_update", None, (_p, _f32)), ("ugo_settle_physics", None, (_p, _f32)),
    ("ugo_bone_world", None, (_p, _u32, ctypes.POINTER(_f32))), ("ugo_deform_cpu", None, (_p, ctypes.POINTER(_f32))),
    ("ugo_raster_clear", None, (ctypes.POINTER(_f32), _u32, _u32, _f32, _f32, _f32, _f32)),
    ("ugo_raster_instance_ex", None, (_p, _p, _u32, ctypes.POINTER(_f32), _u32, _u32, ctypes.POINTER(_f32), ctypes.POINTER(_f32), ctypes.POINTER(_f32), _u32)),
    ("ugo_raster_resolve", None, (ctypes.POINTER(_f32), _u32, _u32, _u32, ctypes.POINTER(ctypes.c_uint8))),
]}

UGO_RASTER_NEAREST = 1


class _Image(ctypes.Structure):  # UgoImage
    _fields_ = [("rgba", _p), ("width", _u32), ("height", _u32)]


def _aligned(n):
    """A 16-byte aligned block of n bytes: (owner, address)."""
    buf = ctypes.create_string_buffer(n + 16)
    addr = (ctypes.addressof(buf) + 15) & ~15
    return buf, addr


def version():
    v = _c["ugo_version"]()
    return v >> 16, v & 0xFFFF


# ---- PNG (8-bit RGB / RGBA / grey, not interlaced) without anything outside the standard library ----

def read_png(path):
    """-> (width, height, bytes RGBA straight alpha)."""
    data = open(path, "rb").read()
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError(f"{path}: not a PNG")
    pos, idat, w = 8, b"", 0
    while pos < len(data):
        n, kind = struct.unpack(">I4s", data[pos:pos + 8])
        body = data[pos + 8:pos + 8 + n]
        if kind == b"IHDR":
            w, h, depth, ctype, _, _, inter = struct.unpack(">IIBBBBB", body)
            if depth != 8 or inter or ctype not in (0, 2, 4, 6):
                raise ValueError(f"{path}: only 8-bit, non-interlaced grey/RGB/RGBA PNGs are read here")
        elif kind == b"IDAT":
            idat += body
        pos += 12 + n
    ch = {0: 1, 2: 3, 4: 2, 6: 4}[ctype]
    raw, stride = zlib.decompress(idat), w * ch
    out, prev = bytearray(), bytearray(stride)
    for y in range(h):
        f, line = raw[y * (stride + 1)], bytearray(raw[y * (stride + 1) + 1:(y + 1) * (stride + 1)])
        for i in range(stride):
            a = line[i - ch] if i >= ch else 0
            b, c = prev[i], prev[i - ch] if i >= ch else 0
            if f == 1: line[i] = (line[i] + a) & 255
            elif f == 2: line[i] = (line[i] + b) & 255
            elif f == 3: line[i] = (line[i] + ((a + b) >> 1)) & 255
            elif f == 4:
                p = a + b - c; pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                line[i] = (line[i] + (a if pa <= pb and pa <= pc else b if pb <= pc else c)) & 255
        out += line
        prev = line
    if ch == 4:
        return w, h, bytes(out)
    rgba = bytearray(4 * w * h)
    for k in range(w * h):
        px = out[k * ch:(k + 1) * ch]
        r, g, b = (px[0], px[1], px[2]) if ch >= 3 else (px[0],) * 3
        rgba[4 * k:4 * k + 4] = bytes((r, g, b, px[1] if ch == 2 else 255))
    return w, h, bytes(rgba)


def write_png(path, width, height, rgba):
    def chunk(kind, body):
        return struct.pack(">I", len(body)) + kind + body + struct.pack(">I", zlib.crc32(kind + body) & 0xFFFFFFFF)
    rows = b"".join(b"\x00" + rgba[y * width * 4:(y + 1) * width * 4] for y in range(height))
    with open(path, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
                + chunk(b"IDAT", zlib.compress(rows, 9)) + chunk(b"IEND", b""))


class Model:
    """A loaded .ug9 (keeps its bytes and memory alive). textures: [(width, height, rgba bytes)]."""

    def __init__(self, data, textures=()):
        n = len(data)
        self._file, faddr = _aligned(n)
        ctypes.memmove(faddr, data, n)
        need = _c["ugo_model_mem_size_for"](faddr, n)
        if not need:
            raise ValueError(f"Ugo9: not a .ug9 this core reads (error {_c['ugo_last_error']()})")
        self._mem, maddr = _aligned(need)
        self.ptr = _c["ugo_model_init_sized"](maddr, need, faddr, n)
        if not self.ptr:
            raise ValueError(f"Ugo9: not a .ug9 this core reads (error {_c['ugo_last_error']()})")
        f = _c["ugo_model_format"](self.ptr)
        self.format, self.warnings = (f >> 16, f & 0xFFFF), _c["ugo_model_warnings"](self.ptr)
        name = lambda fn, i: _c[fn](self.ptr, i).decode("utf-8")
        self.params = [{"name": name("ugo_param_name", i), "min": _c["ugo_param_min"](self.ptr, i), "default": _c["ugo_param_default"](self.ptr, i),
                        "max": _c["ugo_param_max"](self.ptr, i)} for i in range(_c["ugo_param_count"](self.ptr))]
        self.animations = [{"name": name("ugo_animation_name", i), "duration": _c["ugo_animation_duration"](self.ptr, i),
                            "loop": bool(_c["ugo_animation_loop"](self.ptr, i))} for i in range(_c["ugo_animation_count"](self.ptr))]
        self.bones = [name("ugo_bone_name", i) for i in range(_c["ugo_bone_count"](self.ptr))]
        self.parts = [name("ugo_part_name", i) for i in range(_c["ugo_part_count"](self.ptr))]
        self.expressions = [name("ugo_expression_name", i) for i in range(_c["ugo_expression_count"](self.ptr))]
        self.textures = [name("ugo_texture_name", i) for i in range(_c["ugo_texture_count"](self.ptr))]
        c = _c["ugo_canvas"](self.ptr)
        self.canvas = (c[0], c[1], c[2], c[3])  # width, height, origin x, origin y
        self.vertex_count = _c["ugo_vertex_count"](self.ptr)
        self._images = []
        self.set_textures(textures)

    @classmethod
    def open(cls, path):
        """A .ug9 file and its PNG textures (named in the model, next to the file)."""
        d = os.path.dirname(os.path.abspath(path))
        m = cls(open(path, "rb").read())
        m.set_textures([read_png(os.path.join(d, t)) for t in m.textures])
        return m

    def set_textures(self, textures):
        self._images = [ctypes.create_string_buffer(bytes(rgba), len(rgba)) for (_, _, rgba) in textures]
        self._image_array = (_Image * max(1, len(textures)))()
        for k, (w, h, _) in enumerate(textures):
            self._image_array[k] = _Image(ctypes.addressof(self._images[k]), w, h)
        self._texture_count = len(textures)

    def instance(self):
        return Instance(self)

    def index(self, kind, name):
        if isinstance(name, int):
            return name
        i = _c["ugo_find_param" if kind == "param" else "ugo_find_animation"](self.ptr, name.encode("utf-8"))
        if i < 0:
            raise KeyError(f"Ugo9: no {kind} {name!r}")
        return i

    @staticmethod
    def save_png(path, image):
        width, height, rgba = image
        write_png(path, width, height, rgba)


class Instance:
    """One character: parameters, animations, update, bones, the deformed mesh, and drawing on the processor."""

    def __init__(self, model):
        self.model = model
        n = _c["ugo_instance_mem_size"](model.ptr)
        self._mem, addr = _aligned(n)
        self.ptr = _c["ugo_instance_init"](addr, model.ptr)

    def reset(self): _c["ugo_reset_params"](self.ptr); return self
    def set(self, name, value): _c["ugo_set_param"](self.ptr, self.model.index("param", name), value); return self
    def get(self, name): return _c["ugo_get_param"](self.ptr, self.model.index("param", name))
    def play(self, name, time, weight=1.0): _c["ugo_apply_animation"](self.ptr, self.model.index("animation", name), time, weight); return self
    def expression(self, i, weight=1.0): _c["ugo_apply_expression"](self.ptr, self.model.expressions.index(i) if isinstance(i, str) else i, weight); return self
    def set_wind(self, x, y, gust=0.0): _c["ugo_set_wind"](self.ptr, x, y, gust); return self
    def settle_physics(self, seconds=2.0): _c["ugo_settle_physics"](self.ptr, seconds); return self
    def update(self, dt): _c["ugo_update"](self.ptr, dt); return self

    def bone_world(self, bone):
        i = bone if isinstance(bone, int) else self.model.bones.index(bone)
        out = (_f32 * 6)()
        _c["ugo_bone_world"](self.ptr, i, out)
        return list(out)

    def deformed(self):
        """Every vertex after the last update, model space: [x0, y0, x1, y1, ...]."""
        out = (_f32 * (2 * self.model.vertex_count + 2))()
        _c["ugo_deform_cpu"](self.ptr, out)
        return list(out[:2 * self.model.vertex_count])

    def render(self, width, height, supersample=1, nearest=False, view=None):
        """Draws the character (fitted into the picture, or by view [a, b, c, d, tx, ty]) -> (w, h, RGBA bytes)."""
        if not self.model._texture_count:
            raise ValueError("Ugo9: the model has no textures set (Model.open reads them, or set_textures)")
        W, H, k = width * supersample, height * supersample, supersample
        if view is None:
            cw, ch, ox, oy = self.model.canvas
            s = min(W / cw, H / ch)
            view = [s, 0, 0, s, (W - cw * s) / 2 + ox * s, (H - ch * s) / 2 + oy * s]
        target = (_f32 * (4 * W * H))()
        scratch = (_f32 * (2 * self.model.vertex_count + 2))()
        mask = (_f32 * (W * H))()
        _c["ugo_raster_clear"](target, W, H, 0, 0, 0, 0)
        _c["ugo_raster_instance_ex"](self.ptr, ctypes.addressof(self.model._image_array), self.model._texture_count, target, W, H,
                                     (_f32 * 6)(*view), scratch, mask, UGO_RASTER_NEAREST if nearest else 0)
        out = (ctypes.c_uint8 * (4 * width * height))()
        _c["ugo_raster_resolve"](target, width, height, k, out)
        return width, height, bytes(out)
