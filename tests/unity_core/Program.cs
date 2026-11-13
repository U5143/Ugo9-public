// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// Checks the Unity package's core wrapper (engines/unity/com.ugo9.runtime/Runtime/Core)
// against the real C core: loading, names, the GPU tables, instances, frame blocks.
using System;
using System.IO;
using System.Linq;
using Ugo9.Core;

int failures = 0;
// the sample's look parameters: the standard names (docs/パラメータの名前.md) where it has them, else the older ones
string N(UgoModelData m, string older)
{
    foreach (var kv in UgoHelpers.OlderNames) if (kv.Value == older && m.FindParameter(kv.Key) >= 0) return kv.Key;
    return older;
}
void Check(bool ok, string msg) { Console.WriteLine($"{(ok ? "ok  " : "FAIL")} {msg}"); if (!ok) failures++; }

string root = args.Length > 0 ? args[0] : "../..";
using (var basic = new UgoModelData(File.ReadAllBytes(Path.Combine(root, "samples/basic/model.ug9"))))
{
    Check(basic.ParameterNames.Contains(N(basic, "AngleX")) && basic.AnimationNames.Contains("idle"), $"names ({basic.ParameterCount} parameters, animations {string.Join(",", basic.AnimationNames)})");
    Check(basic.CanvasWidth == 420 && basic.CanvasHeight == 600, $"canvas {basic.CanvasWidth}x{basic.CanvasHeight}");
    Check(Math.Abs(basic.AnimationDuration(basic.FindAnimation("idle")) - 6) < 1e-6 && basic.AnimationLoops(basic.FindAnimation("idle")), "idle lasts 6 s and loops");
    var t = basic.Tables;
    int drawn = t.Runs.Sum(r => r.Indices.Length);
    Check(t.Vertices.Length == 16 * basic.VertexCount && t.Parts.Length == 8 * basic.PartCount, "vertex and part tables");
    Check(drawn > 0 && drawn <= basic.IndexCount && drawn % 3 == 0, $"drawn triangles {drawn / 3} in {t.Runs.Count} run(s)");
    Check(t.MaskChannels > 0 && t.MaskIndices.Length > 0, $"masks: {t.MaskChannels} channel(s), {t.MaskIndices.Length / 3} mask triangles");
    Check(t.Entries.All(float.IsFinite) && t.Entries.Where((v, i) => i % 4 == 0).All(m => m >= 0 && m < basic.MorphCount), "morph entries (morph numbers in range)");

    using var a = new UgoInstanceData(basic);
    using var b = new UgoInstanceData(basic);
    var fa = new float[basic.FrameFloats];
    var fb = new float[basic.FrameFloats];
    a.ResetParams(); a.Update(0); a.CopyFrame(fa, 0);
    Check(fa[0] == 1 && fa[3] == 1 && fa[4] == 0, "a new instance is placed with the identity");
    b.ResetParams(); b.SetParam(basic.FindParameter(N(basic, "AngleX")), 25); b.Update(0); b.CopyFrame(fb, 0);
    Check(!fa.SequenceEqual(fb), "a parameter changes the frame block");
    Check(Math.Abs(b.GetParam(basic.FindParameter(N(basic, "AngleX"))) - 25) < 1e-6, "get_param reads the value back");
    b.SetTransform(2, 0, 0, 2, 10, 20); b.CopyFrame(fb, 0);
    Check(fb[0] == 2 && fb[4] == 10 && fb[5] == 20, "placement goes into the frame block");

    // picking and bounds (1.1): the face at its middle, nothing far away, the whole box around the canvas' drawing
    using (var pk = new UgoInstanceData(basic))
    {
        pk.ResetParams(); pk.Update(0);
        int mid = pk.PickPart(0, -330), none = pk.PickPart(5000, 5000);
        Check(mid >= 0 && none == -1, $"pick: at the face {(mid >= 0 ? basic.PartNames[mid] : "-")}, far away {none}");
        bool any = pk.Bounds(-1, out float x0, out float y0, out float x1, out float y1);
        Check(any && x0 < -50 && x1 > 50 && y0 < -500 && y1 > -50 && x1 - x0 < 420 && y1 - y0 <= 600, $"bounds of the whole character ({x0:0},{y0:0})-({x1:0},{y1:0})");
        int face = basic.PartNames.ToList().IndexOf("face");
        bool fok = pk.Bounds(face, out float fx0, out float fy0, out float fx1, out float fy1);
        Check(fok && fx0 > x0 - 1e-3 && fx1 < x1 + 1e-3 && fy0 > y0 - 1e-3 && fy1 < y1 + 1e-3 && fx1 > fx0, $"bounds of the face inside the whole ({fx0:0},{fy0:0})-({fx1:0},{fy1:0})");
        bool est = pk.BoundsEstimate(out float ex0, out float ey0, out float ex1, out float ey1);
        Check(est && ex0 <= x0 + 1e-3 && ey0 <= y0 + 1e-3 && ex1 >= x1 - 1e-3 && ey1 >= y1 - 1e-3, $"bounds estimate holds the real box ({ex0:0},{ey0:0})-({ex1:0},{ey1:0})");
        pk.SetParam(basic.FindParameter(N(basic, "AngleX")), 30); pk.Update(0);
        pk.Bounds(face, out float gx0, out _, out float gx1, out _);
        Check(Math.Abs(gx0 - fx0) + Math.Abs(gx1 - fx1) > 1, $"bounds follow the pose after Update (face x {fx0:0}..{fx1:0} -> {gx0:0}..{gx1:0})");
    }

    // the Conversation sample's preset fits this model: no missing names, smile narrows the eyes
    var preset = new UgoExpressionPreset(File.ReadAllText(Path.Combine(root, "engines/unity/com.ugo9.runtime/Samples~/Conversation/basic.ug9x")), basic);
    Check(preset.Missing.Count == 0 && preset.Expressions.Count == 4, $"sample preset: {preset.Expressions.Count} expressions, missing [{string.Join(",", preset.Missing)}]");
    Check(File.ReadAllText(Path.Combine(root, "engines/godot/project/demo/basic.ug9x")) == File.ReadAllText(Path.Combine(root, "engines/unity/com.ugo9.runtime/Samples~/Conversation/basic.ug9x")), "the Godot demo's preset is the same as the Unity sample's");
    using (var s = new UgoInstanceData(basic))
    {
        var mx = new UgoExpressionMixer();
        mx.Bind(basic);
        mx.Load(File.ReadAllText(Path.Combine(root, "engines/unity/com.ugo9.runtime/Samples~/Conversation/basic.ug9x")));
        mx.Show("smile", 0); mx.Update(0.016f);
        s.ResetParams(); mx.Apply(s);
        Check(Math.Abs(s.GetParam(basic.FindParameter("EyeOpenL")) - 0.55f) < 1e-5, "sample preset: smile sets EyeOpenL to 0.55");
    }
}

using (var rig = new UgoModelData(File.ReadAllBytes(Path.Combine(root, "tests/pose/rig.ug9"))))
{
    var t = rig.Tables;
    Check(t.Runs.Select(r => r.Blend).Distinct().Count() >= 2, $"rig: runs by blend class ({string.Join(",", t.Runs.Select(r => r.Blend))})");
    Check(t.XWeights.Length > 0, $"rig: extra bone weights ({t.XWeights.Length / 4})");
}
using (var warp = new UgoModelData(File.ReadAllBytes(Path.Combine(root, "tests/warp/model.ug9"))))
{
    var t = warp.Tables;
    bool hasWarp = Enumerable.Range(0, warp.PartCount).Any(i => t.Parts[8 * i + 4] > 0);
    Check(hasWarp, "warp: parts in warp grids point at their grid's points");

    // the texture's way up: Unity keeps a PNG's rows bottom first, so the mesh's UVs (TextureUvs)
    // must read there the colours the Web runtime reads at the .ug9 UVs (rows top first).
    // The warp atlas has four different checkers in its quarters, so a flip shows.
    var (w, h, png) = Png.Read(Path.Combine(root, "tests/warp/atlas.png"));
    // bilinear, like the GPU: texel centres at (i + 0.5) / size; row r counted from the top or from the bottom
    double[] Sample(float u, float v, bool bottomFirst)
    {
        double x = u * w - 0.5, y = v * h - 0.5;
        int x0 = (int)Math.Floor(x), y0 = (int)Math.Floor(y);
        double fx = x - x0, fy = y - y0;
        var c = new double[4];
        for (int k = 0; k < 4; k++)
        {
            int xi = Math.Clamp(x0 + (k & 1), 0, w - 1), yi = Math.Clamp(y0 + (k >> 1), 0, h - 1);
            uint p = png[(bottomFirst ? h - 1 - yi : yi) * w + xi];
            double wt = ((k & 1) != 0 ? fx : 1 - fx) * ((k >> 1) != 0 ? fy : 1 - fy);
            for (int j = 0; j < 4; j++) c[j] += wt * ((p >> (24 - 8 * j)) & 255);
        }
        return c;
    }
    bool Near(double[] a, double[] b) => Enumerable.Range(0, 4).All(j => Math.Abs(a[j] - b[j]) < 0.5);
    int nv = warp.VertexCount, same = 0, sameIfNotFlipped = 0;
    for (int i = 0; i < nv; i++)
    {
        var web = Sample(t.Uvs[2 * i], t.Uvs[2 * i + 1], false);
        if (Near(Sample(t.TextureUvs[2 * i], t.TextureUvs[2 * i + 1], true), web)) same++;
        if (Near(Sample(t.Uvs[2 * i], t.Uvs[2 * i + 1], true), web)) sameIfNotFlipped++;
    }
    Check(same == nv, $"warp: Unity's UVs read the same atlas colours as the Web runtime ({same} of {nv} vertices)");
    Check(sameIfNotFlipped < nv / 2, $"warp: (the check can see a flip: unflipped UVs match at {sameIfNotFlipped} of {nv})");
}

// draw order (format 0.8): tests/order's "Sw" parameter moves "sq" to the front and "arm" to the back
using (var order = new UgoModelData(File.ReadAllBytes(Path.Combine(root, "tests/order/model.ug9"))))
using (var inst = new UgoInstanceData(order))
{
    Check(order.HasDrawOrder, "order: the model has a draw order");
    var list = new uint[order.PartCount];
    inst.ResetParams(); inst.Update(0);
    uint key0 = inst.DrawOrderKey;
    inst.CopyDrawOrder(list);
    var before = list.Select(i => order.PartNames[i]).ToArray();
    inst.ResetParams(); inst.SetParam(order.FindParameter("Sw"), 1); inst.Update(0);
    uint key1 = inst.DrawOrderKey;
    inst.CopyDrawOrder(list);
    var after = list.Select(i => order.PartNames[i]).ToArray();
    Check(key1 != key0 && after[after.Length - 1] == "sq" && after[0] == "arm",
        $"order: a parameter changes the order ({string.Join(",", before)} -> {string.Join(",", after)}, keys {key0:x} -> {key1:x})");
    var runs = order.RunsFor(list);
    Check(runs.Sum(r => r.Indices.Length) == order.Tables.Runs.Sum(r => r.Indices.Length), "order: the runs for an order hold the same triangles");
}
using (var basic = new UgoModelData(File.ReadAllBytes(Path.Combine(root, "samples/basic/model.ug9"))))
    Check(!basic.HasDrawOrder, "basic: no draw order (drawn as before)");

// expressions (format 0.8): tests/order has "puffed" (Puff set 1, Pull multiply 0.5) and "swapped" (Sw add 0.75)
using (var m = new UgoModelData(File.ReadAllBytes(Path.Combine(root, "tests/order/model.ug9"))))
using (var inst = new UgoInstanceData(m))
{
    Check(string.Join(",", m.ExpressionNames) == "puffed,swapped", $"expressions: names ({string.Join(",", m.ExpressionNames)})");
    int sw = m.FindParameter("Sw"), puff = m.FindParameter("Puff");
    inst.ResetParams(); inst.ApplyExpression(m.FindExpression("swapped"), 1); inst.Update(0);
    Check(Math.Abs(inst.GetParam(sw) - 0.75f) < 1e-5, $"expressions: the model's own one, weight 1 (Sw {inst.GetParam(sw)})");
    inst.ResetParams(); inst.ApplyExpression(m.FindExpression("swapped"), 0.5f); inst.Update(0);
    Check(Math.Abs(inst.GetParam(sw) - 0.375f) < 1e-5, $"expressions: weight 0.5 (Sw {inst.GetParam(sw)})");

    // a preset written for another model: one name this model lacks
    const string preset = "{ \"format\": \"ugo9-expressions\", \"version\": 1, \"expressions\": [" +
        "{ \"id\": \"wide\", \"fadeIn\": 0.2, \"fadeOut\": 0.4, \"params\": { \"Puff\": [\"set\", 0.8], \"MouthSmile\": [\"add\", 1] } }," +
        "{ \"id\": \"swapped\", \"params\": { \"Sw\": [\"set\", 0.25] } } ] }";
    var mixer = new UgoExpressionMixer();
    mixer.Bind(m);
    var missing = mixer.Load(preset);
    Check(missing.Count == 1 && missing[0] == "MouthSmile", $"presets: names the model lacks are reported ({string.Join(",", missing)})");
    mixer.Show("wide"); // fade-in 0.2 s
    mixer.Update(0.1f);
    inst.ResetParams(); mixer.Apply(inst); inst.Update(0);
    Check(Math.Abs(mixer.Weight("wide") - 0.5f) < 1e-5 && Math.Abs(inst.GetParam(puff) - 0.4f) < 1e-5,
        $"mixer: half way through the fade-in (weight {mixer.Weight("wide")}, Puff {inst.GetParam(puff)})");
    mixer.Update(0.5f);
    mixer.Hide("wide"); // fade-out 0.4 s
    mixer.Update(0.4f);
    Check(mixer.Weight("wide") == 0, "mixer: faded out and forgotten");
    mixer.Show("swapped", 0); mixer.Update(0); // the preset's "swapped" overrides the model's
    inst.ResetParams(); mixer.Apply(inst); inst.Update(0);
    Check(Math.Abs(inst.GetParam(sw) - 0.25f) < 1e-5, $"mixer: a preset's expression overrides the model's of the same name (Sw {inst.GetParam(sw)})");
    try { mixer.Load("{\"format\": \"other\"}"); Check(false, "presets: another format is rejected"); }
    catch (FormatException) { Check(true, "presets: another format is rejected"); }
}

// format 1.0: a later 1.x file (tests/future) loads with warnings; another major says what to do
using (var future = new UgoModelData(File.ReadAllBytes(Path.Combine(root, "tests/future/model.ug9"))))
    Check(future.Warnings == 3 && future.WarningText != null && future.WarningText.Contains("tables and animation tracks"),
        $"a later 1.x file: warnings {future.Warnings} ({future.WarningText})");
using (var basic = new UgoModelData(File.ReadAllBytes(Path.Combine(root, "samples/basic/model.ug9"))))
    Check(basic.Warnings == 0 && basic.WarningText == null && basic.FormatMajor == 1, $"this version's file: no warnings, format {basic.FormatMajor}.{basic.FormatMinor}");
{
    var b = File.ReadAllBytes(Path.Combine(root, "samples/basic/model.ug9"));
    b[4] = 0; b[5] = 0; // major 0: an old file
    try { new UgoModelData(b); Check(false, "an old major is rejected"); }
    catch (FormatException e) { Check(e.Message.Contains("compile it again"), $"an old major is rejected with what to do ({e.Message})"); }
    b[4] = 2; // major 2: newer than this core
    try { new UgoModelData(b); Check(false, "a newer major is rejected"); }
    catch (FormatException e) { Check(e.Message.Contains("update the Ugo9 plugin"), $"a newer major is rejected with what to do ({e.Message})"); }
}

// format 1.1: curve keys (tests/v11). The model's memory is asked for the file (ugo_model_mem_size_for).
using (var v11 = new UgoModelData(File.ReadAllBytes(Path.Combine(root, "tests/v11/model.ug9"))))
using (var inst = new UgoInstanceData(v11))
{
    Check(v11.FormatMajor == 1 && v11.FormatMinor == 1 && v11.Warnings == 0, $"1.1: loads (format {v11.FormatMajor}.{v11.FormatMinor}, warnings {v11.Warnings})");
    int a = v11.FindParameter("A");
    float At(float t) { inst.ResetParams(); inst.ApplyAnimation(v11.FindAnimation("wave"), t, 1); inst.Update(0); return inst.GetParam(a); }
    // A eases in and out from 0 to 1 over the first second: below the straight line early, above it late
    float early = At(0.25f), mid = At(0.5f), late = At(0.75f);
    Check(early < 0.25f && late > 0.75f && Math.Abs(mid - 0.5f) < 0.05f && Math.Abs(At(1) - 1) < 1e-4,
        $"1.1: a curve key eases (A at 0.25/0.5/0.75/1 s: {early:0.###}/{mid:0.###}/{late:0.###}/{At(1):0.###})");
}

// helpers (looking, blinking, the mouth) on the sample: AngleX -30..30, EyeBallX -1..1, BodyAngleX -10..10, EyeOpenL 0..1, MouthOpen 0..1
using (var m = new UgoModelData(File.ReadAllBytes(Path.Combine(root, "samples/basic/model.ug9"))))
using (var inst = new UgoInstanceData(m))
{
    var h = new UgoHelpers { LookSmoothing = 0, Looking = true, LookX = 400, LookY = -200 };
    float P(string n) => inst.GetParam(m.FindParameter(N(m, n)));
    void Frame(float dt) { inst.ResetParams(); h.Apply(m, inst, dt); inst.Update(0); }
    Frame(0.016f);
    Check(Math.Abs(P("AngleX") - 30) < 1e-3 && Math.Abs(P("EyeBallX") - 1) < 1e-4 && Math.Abs(P("BodyAngleX") - 3) < 1e-3 && Math.Abs(P("AngleY") - 15) < 1e-3,
        $"looking right and up turns face, eyes and a little of the body (AngleX {P("AngleX")}, EyeBallX {P("EyeBallX")}, BodyAngleX {P("BodyAngleX")}, AngleY {P("AngleY")})");
    h.Looking = false; Frame(0.016f);
    Check(Math.Abs(P("AngleX")) < 1e-3, $"looking away lets the animation have the face (AngleX {P("AngleX")})");

    h.AutoBlink = true; h.SetSeed(7);
    float least = 1, last = 1; int blinks = 0; bool shut = false;
    for (int k = 0; k < 1500; k++) // 15 s
    {
        Frame(0.01f);
        float e = P("EyeOpenL");
        least = Math.Min(least, e);
        if (e < 0.1f && !shut) { blinks++; shut = true; }
        if (e > 0.9f) shut = false;
        last = e;
    }
    Check(least < 0.1f && blinks >= 2 && blinks <= 8, $"blinks on its own ({blinks} blinks in 15 s, eyes down to {least:0.##})");
    h.AutoBlink = false;

    h.MouthLevel = 1;
    for (int k = 0; k < 30; k++) Frame(0.01f);
    Check(P("MouthOpen") > 0.95f, $"the mouth follows the level (MouthOpen {P("MouthOpen")})");
    h.MouthLevel = 0;
    for (int k = 0; k < 60; k++) Frame(0.01f);
    Check(P("MouthOpen") < 0.05f, $"and closes when it falls (MouthOpen {P("MouthOpen")})");
}

try { new UgoModelData(new byte[] { 1, 2, 3, 4, 5, 6, 7, 8 }); Check(false, "a broken file is rejected"); }
catch (FormatException) { Check(true, "a broken file is rejected"); }

// the lip-sync noise gate (the Web's VoiceLevel numbers): a click stays shut, a voice opens, a short pause holds
{
    var g = new UgoVoiceGate();
    float dt = 0.01f, peak = 0;
    for (int k = 0; k < 3; k++) peak = Math.Max(peak, g.Update(-20, dt)); // a 0.03 s click, loud
    for (int k = 0; k < 20; k++) peak = Math.Max(peak, g.Update(-80, dt));
    bool clickShut = peak == 0;
    for (int k = 0; k < 10; k++) g.Update(-32.5f, dt); // a voice for 0.1 s: half way up the 25 dB range
    float voice = g.Level;
    for (int k = 0; k < 8; k++) g.Update(-80, dt); // a 0.08 s pause: still open (level 0 below the gate)
    bool held = g.Open;
    for (int k = 0; k < 10; k++) g.Update(-80, dt); // longer than 0.12 s: shut
    Check(clickShut && Math.Abs(voice - 0.5f) < 1e-4 && held && !g.Open, $"voice gate: a click stays shut, a voice opens ({voice:0.###}), a short pause holds, silence shuts");
}

if (failures > 0) { Console.WriteLine($"{failures} check(s) failed"); return 1; }
Console.WriteLine("all Unity core checks passed");
return 0;

// a small PNG reader (8-bit RGBA or RGB, not interlaced): pixels as 0xRRGGBBAA, top row first
static class Png
{
    public static (int w, int h, uint[] px) Read(string path)
    {
        var b = File.ReadAllBytes(path);
        int pos = 8, w = 0, h = 0, channels = 4;
        var idat = new MemoryStream();
        while (pos < b.Length)
        {
            int len = (b[pos] << 24) | (b[pos + 1] << 16) | (b[pos + 2] << 8) | b[pos + 3];
            string type = System.Text.Encoding.ASCII.GetString(b, pos + 4, 4);
            if (type == "IHDR")
            {
                w = (b[pos + 8] << 24) | (b[pos + 9] << 16) | (b[pos + 10] << 8) | b[pos + 11];
                h = (b[pos + 12] << 24) | (b[pos + 13] << 16) | (b[pos + 14] << 8) | b[pos + 15];
                if (b[pos + 16] != 8 || b[pos + 20] != 0) throw new NotSupportedException("8-bit, not interlaced");
                channels = b[pos + 17] == 6 ? 4 : b[pos + 17] == 2 ? 3 : throw new NotSupportedException("RGBA or RGB");
            }
            else if (type == "IDAT") idat.Write(b, pos + 8, len);
            pos += 12 + len;
        }
        idat.Position = 0;
        var raw = new MemoryStream();
        using (var z = new System.IO.Compression.ZLibStream(idat, System.IO.Compression.CompressionMode.Decompress)) z.CopyTo(raw);
        var d = raw.ToArray();
        int stride = w * channels;
        var img = new byte[h * stride];
        for (int y = 0; y < h; y++)
        {
            int f = d[y * (stride + 1)], src = y * (stride + 1) + 1, dst = y * stride;
            for (int x = 0; x < stride; x++)
            {
                int a = x >= channels ? img[dst + x - channels] : 0, up = y > 0 ? img[dst - stride + x] : 0;
                int c = x >= channels && y > 0 ? img[dst - stride + x - channels] : 0;
                int p = a + up - c, pa = Math.Abs(p - a), pb = Math.Abs(p - up), pc = Math.Abs(p - c);
                int pred = f == 1 ? a : f == 2 ? up : f == 3 ? (a + up) / 2 : f == 4 ? (pa <= pb && pa <= pc ? a : pb <= pc ? up : c) : 0;
                img[dst + x] = (byte)(d[src + x] + pred);
            }
        }
        var px = new uint[w * h];
        for (int i = 0; i < w * h; i++)
        {
            int o = i * channels;
            px[i] = (uint)(img[o] << 24 | img[o + 1] << 16 | img[o + 2] << 8 | (channels == 4 ? img[o + 3] : 255));
        }
        return (w, h, px);
    }
}
