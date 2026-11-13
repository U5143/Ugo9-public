// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// UgoCharacter (the Unity package's component) gives the same frame block as the
// core driven by hand: parameters set before its first update stay, the animation
// plays at its time, and the order is reset -> animation -> parameters -> placement -> update.
//   LD_LIBRARY_PATH=build/native dotnet run --project tests/unity_logic -- <repository>
using System;
using System.IO;
using System.Linq;
using Ugo9;
using Ugo9.Core;

int failures = 0;
void Check(bool ok, string msg) { Console.WriteLine($"{(ok ? "ok  " : "FAIL")} {msg}"); if (!ok) failures++; }

string root = args.Length > 0 ? args[0] : "../..";
var bytes = File.ReadAllBytes(Path.Combine(root, "samples/basic/model.ug9"));
var model = UgoModel.FromBytes(bytes, null);
var data = model.Data;

// the pose scene of tests/engine_scenes.mjs
// (the look parameters under the standard names where the sample has them, else the older ones)
string N(string older)
{
    foreach (var kv in UgoHelpers.OlderNames) if (kv.Value == older && data.FindParameter(kv.Key) >= 0) return kv.Key;
    return older;
}
var pose = new (string name, float value)[] { (N("AngleX"), 22), (N("AngleY"), -12), ("EyeOpenL", 0.3f), ("MouthOpen", 0.7f), (N("EyeBallX"), -0.6f), (N("BodyAngleX"), 4) };

float[] ByHand(string anim, float time)
{
    using var inst = new UgoInstanceData(data);
    inst.ResetParams();
    int a = data.FindAnimation(anim);
    if (a >= 0) inst.ApplyAnimation(a, time, 1);
    foreach (var (n, v) in pose) inst.SetParam(data.FindParameter(n), v);
    inst.SetTransform(1, 0, 0, 1, 0, 0);
    inst.Update(0);
    var f = new float[data.FrameFloats];
    inst.CopyFrame(f, 0);
    return f;
}

foreach (var (anim, time) in new[] { ("", 0f), ("talk", 0.8f) })
{
    // as the render test makes it: parameters set right after the component is added, before any update
    var c = new UgoCharacter { model = model, manual = true, playing = false, animation = anim, time = time };
    foreach (var (n, v) in pose) c.SetParam(n, v);
    c.UpdateNow();
    var f = new float[data.FrameFloats];
    c.CopyFrame(f, 0);
    var want = ByHand(anim, time);
    float diff = f.Zip(want, (x, y) => Math.Abs(x - y)).Max();
    Check(diff < 1e-5f, $"animation '{anim}' at {time} with parameters set before the first update: the frame block matches the core (max difference {diff})");
    Check(Math.Abs(c.GetParam(N("AngleX")) - 22) < 1e-4f, $"GetParam reads the value set before the first update ({c.GetParam(N("AngleX"))})");
    c.ClearParams();
    c.UpdateNow();
    Check(Math.Abs(c.GetParam(N("AngleX"))) < 1e-4f || anim != "", "ClearParams goes back to the animation's value");
}

// expressions (format 0.8) on the component: the model's own, with a fade, and a preset
{
    var om = UgoModel.FromBytes(File.ReadAllBytes(Path.Combine(root, "tests/order/model.ug9")), null);
    var c = new UgoCharacter { model = om, manual = true, playing = false };
    Check(string.Join(",", c.ExpressionNames) == "puffed,swapped", $"expression names ({string.Join(",", c.ExpressionNames)})");
    c.ShowExpression("swapped", 1); // 1 s fade-in
    c.Advance(0.25f); c.UpdateNow();
    Check(Math.Abs(c.GetParam("Sw") - 0.75f * 0.25f) < 1e-4, $"ShowExpression fades in with the clock (Sw {c.GetParam("Sw")} after 0.25 s)");
    c.Advance(1); c.UpdateNow();
    Check(Math.Abs(c.GetParam("Sw") - 0.75f) < 1e-4, $"fully shown (Sw {c.GetParam("Sw")})");
    var missing = c.LoadExpressions("{\"format\": \"ugo9-expressions\", \"version\": 1, \"expressions\": [{\"id\": \"x\", \"params\": {\"Puff\": [\"set\", 1], \"Nope\": [\"set\", 1]}}]}");
    Check(missing.Count == 1 && missing[0] == "Nope", "LoadExpressions reports the names the model lacks");
    c.OnlyExpressions("x"); c.Advance(5); c.UpdateNow();
    Check(Math.Abs(c.GetParam("Puff") - 1) < 1e-4 && Math.Abs(c.GetParam("Sw")) < 1e-4, $"OnlyExpressions: the preset's shows, the others fade out (Puff {c.GetParam("Puff")}, Sw {c.GetParam("Sw")})");
}

// switching animations: tests/unity_logic/model.ug9 has "once" (A 0 -> 1 over 1 s, does not loop) and "loop" (A 1 -> 0 -> 1 over 2 s)
{
    var vm = UgoModel.FromBytes(File.ReadAllBytes(Path.Combine(root, "tests/unity_logic/model.ug9")), null);
    var d = vm.Data;
    float MixA(params (string anim, float t, float w)[] layers)
    {
        using var inst = new UgoInstanceData(d);
        inst.ResetParams();
        foreach (var (anim, t, w) in layers) inst.ApplyAnimation(d.FindAnimation(anim), t, w);
        inst.Update(0);
        return inst.GetParam(d.FindParameter("A"));
    }
    var c = new UgoCharacter { model = vm, manual = true };
    var ended = new System.Collections.Generic.List<string>();
    c.AnimationFinished += ended.Add;
    c.Play("once");
    c.Advance(0.25f); c.UpdateNow();
    Check(Math.Abs(c.GetParam("A") - 0.25f) < 1e-4, $"Play: plays from the start (A {c.GetParam("A")})");
    c.Play("loop", 0, 1); // a 1 s cross-fade from once (at 0.25 s) to loop
    c.Advance(0.5f); c.UpdateNow();
    float want = MixA(("once", 0.75f, 1), ("loop", 0.5f, 0.5f));
    Check(Math.Abs(c.GetParam("A") - want) < 1e-4 && Math.Abs(want - (0.75f * 0.5f + 0.5f * 0.5f)) < 1e-3,
        $"Play with a fade: half way, the two are mixed half and half (A {c.GetParam("A")}, by hand {want})");
    c.Advance(0.6f); c.UpdateNow();
    Check(Math.Abs(c.GetParam("A") - MixA(("loop", 1.1f, 1))) < 1e-4, $"after the fade only the new one plays (A {c.GetParam("A")})");
    c.Advance(3);
    Check(ended.Count == 0, "a looping animation never finishes");

    c.Play("once");
    c.PlayNext("loop");
    c.Advance(0.9f);
    Check(ended.Count == 0 && !c.IsFinished, "not finished before its end");
    c.Advance(0.2f);
    Check(ended.Count == 1 && ended[0] == "once" && c.animation == "loop", $"AnimationFinished at the end of a once-only animation, then PlayNext's (finished: {string.Join(",", ended)}, now {c.animation})");
    c.Advance(5);
    Check(ended.Count == 1, "raised once");
}

// set in the Inspector: parameters (kept, SetParam over them) and a starting expression (tests/order's "swapped": Sw + 0.75)
{
    var om = UgoModel.FromBytes(File.ReadAllBytes(Path.Combine(root, "tests/order/model.ug9")), null);
    var c = new UgoCharacter { model = om, manual = true, playing = false };
    c.parameters.Add(new UgoCharacter.ParamValue { name = "Puff", value = 0.6f });
    c.expression = "swapped";
    c.UpdateNow();
    Check(Math.Abs(c.GetParam("Puff") - 0.6f) < 1e-4 && Math.Abs(c.GetParam("Sw") - 0.75f) < 1e-4,
        $"Inspector parameters and the starting expression apply (Puff {c.GetParam("Puff")}, Sw {c.GetParam("Sw")})");
    c.SetParam("Puff", 0.2f); c.UpdateNow();
    Check(Math.Abs(c.GetParam("Puff") - 0.2f) < 1e-4, "SetParam goes over an Inspector value");
    c.expression = ""; c.UpdateNow();
    Check(Math.Abs(c.GetParam("Sw")) < 1e-4, "clearing the expression hides it");
}

// colour: the character's colour goes into the frame header's floats 6, 7 (white = 0, 0, as the core leaves them)
{
    var c = new UgoCharacter { model = model, manual = true, playing = false };
    c.UpdateNow();
    var f = new float[data.FrameFloats];
    c.CopyFrame(f, 0);
    Check(f[6] == 0 && f[7] == 0, "colour: white and opaque leave the header as the core wrote it");
    c.color = new UnityEngine.Color(1, 0.5f, 0, 0.25f);
    c.CopyFrame(f, 0);
    // decoded as the shaders do
    float dark = f[6], dr = MathF.Floor(dark / 65536), dg = MathF.Floor((dark - dr * 65536) / 256), db = dark - dr * 65536 - dg * 256;
    Check(Math.Abs(1 - dr / 255 - 1) < 1e-6 && Math.Abs(1 - dg / 255 - 0.5f) < 0.003f && Math.Abs(1 - db / 255) < 1e-6 && Math.Abs(1 - f[7] - 0.25f) < 1e-6,
        $"colour: (1, 0.5, 0, 0.25) decodes to ({1 - dr / 255}, {1 - dg / 255:0.000}, {1 - db / 255}, {1 - f[7]})");
    var plain = new UgoCharacter { model = model, manual = true, playing = false };
    plain.UpdateNow();
    var g = new float[data.FrameFloats];
    plain.CopyFrame(g, 0);
    Check(f.Skip(8).SequenceEqual(g.Skip(8)) && f.Take(6).SequenceEqual(g.Take(6)), "colour: the rest of the frame block is unchanged");
}

// sorting under a batch: sortingOrder, then (sortByY) lower in front, then the hierarchy order
{
    UgoCharacter Make(int order, float y) { var c = new UgoCharacter { sortingOrder = order }; c.transform.position = new UnityEngine.Vector3(0, y, 0); return c; }
    var a = Make(0, 5); var b = Make(1, 0); var c2 = Make(0, 1); var d = Make(0, 3);
    var list = new System.Collections.Generic.List<UgoCharacter> { a, b, c2, d };
    var scratch = new System.Collections.Generic.List<(int, float, int, UgoCharacter)>();
    UgoBatch.SortForDrawing(list, false, scratch);
    Check(list.SequenceEqual(new[] { a, c2, d, b }), "sorting: higher sortingOrder last, equal ones keep the hierarchy order");
    UgoBatch.SortForDrawing(list, true, scratch);
    Check(list.SequenceEqual(new[] { a, d, c2, b }), "sorting by y: within an order, higher y first (lower ones in front)");
    var same = new System.Collections.Generic.List<UgoCharacter> { d, a, c2 };
    UgoBatch.SortForDrawing(same, false, scratch);
    Check(same.SequenceEqual(new[] { d, a, c2 }), "sorting: all orders equal and no y: the hierarchy order");
}

// picking by part name through the character (world units: 100 model pixels each, y up)
{
    var c = new UgoCharacter { model = model, manual = true, playing = false };
    c.UpdateNow();
    Check(c.PartAt(new UnityEngine.Vector3(0, 3.3f, 0)) == "face" && c.PartAt(new UnityEngine.Vector3(50, 50, 0)) == null && c.HitTest(new UnityEngine.Vector3(0, 3.3f, 0)),
        $"PartAt: the face at its middle ({c.PartAt(new UnityEngine.Vector3(0, 3.3f, 0)) ?? "null"}), nothing far away");
    var p = c.WorldToModel(new UnityEngine.Vector3(1.5f, 2, 0));
    Check(p.x == 150 && p.y == -200, $"WorldToModel: units to pixels, y down ({p.x}, {p.y})");
    Check(c.PartBounds("face") != null && c.PartBounds() != null && c.PartBounds("no such part") == null, "PartBounds: by name, the whole character, null for an unknown name");
}

// layers above the main animation: masked, added, cross-faded, stopped, queued (tests/unity_logic/model.ug9)
{
    var lm = UgoModel.FromBytes(File.ReadAllBytes(Path.Combine(root, "tests/unity_logic/model.ug9")), null);
    var c = new UgoCharacter { model = lm, manual = true };
    c.Play("once");
    c.UpdateNow();
    var onlyB = c.MakeMask(parameters: new[] { "B" });
    c.PlayLayer(1, "both", 0, mask: onlyB);
    c.Advance(0.5f); c.UpdateNow();
    Check(Math.Abs(c.GetParam("A") - 0.5f) < 1e-4 && Math.Abs(c.GetParam("B") - 0.6f) < 1e-4,
        $"a masked layer takes only B (A {c.GetParam("A"):0.###} from the main animation, B {c.GetParam("B"):0.###})");
    c.PlayLayer(2, "nudge", 0, additive: true);
    c.UpdateNow();
    Check(Math.Abs(c.GetParam("A") - 0.75f) < 1e-4, $"an added layer raises A by its change from the rest pose ({c.GetParam("A"):0.###})");
    c.SetLayerWeight(2, 0.5f); c.UpdateNow();
    Check(Math.Abs(c.GetParam("A") - 0.625f) < 1e-4, $"the layer's weight scales what it adds ({c.GetParam("A"):0.###})");
    c.StopLayer(1, 0.5f);
    c.Advance(0.25f); c.UpdateNow();
    Check(Math.Abs(c.GetParam("B") - 0.3f) < 1e-3, $"stopping fades the layer out (B {c.GetParam("B"):0.###} half way)");
    c.Advance(0.3f); c.UpdateNow();
    Check(Math.Abs(c.GetParam("B")) < 1e-4 && c.LayerAnimation(1) == null, $"and then it is gone (B {c.GetParam("B"):0.###})");
    var ended = new System.Collections.Generic.List<string>();
    c.LayerFinished += (l, n) => ended.Add($"{l}:{n}");
    c.SetLayerWeight(2, 1);
    c.QueueLayer(2, "both", 0, mask: onlyB);
    c.Advance(0.6f); c.UpdateNow(); // nudge (1 s, does not loop) ends, both follows
    Check(ended.Contains("2:nudge") && c.LayerAnimation(2) == "both" && Math.Abs(c.GetParam("B") - 0.6f) < 1e-4,
        $"a queued layer animation follows when the one before ends ([{string.Join(",", ended)}], now {c.LayerAnimation(2)}, B {c.GetParam("B"):0.###})");
    bool threw = false;
    try { c.MakeMask(parameters: new[] { "Nope" }); } catch (ArgumentException) { threw = true; }
    Check(threw && !c.PlayLayer(1, "no such animation"), "a mask with an unknown name throws; an unknown animation returns false");
    try { c.PlayLayer(0, "both"); threw = false; } catch (ArgumentOutOfRangeException) { threw = true; }
    Check(threw, "layer 0 is the main animation (Play), layers start at 1");
}

// the helpers look with the standard names first (tests/unity_logic/std.ug9 has both HeadTurnX and AngleX)
{
    var sm = UgoModel.FromBytes(File.ReadAllBytes(Path.Combine(root, "tests/unity_logic/std.ug9")), null);
    var c = new UgoCharacter { model = sm, manual = true };
    c.UpdateNow();
    c.LookAt(new UnityEngine.Vector3(1000, 0.25f, 0)); // far to the right, at the face's height (canvas 100 px: face 25 px above the origin)
    c.Advance(2); c.UpdateNow();
    Check(c.GetParam("HeadTurnX") > 29 && c.GetParam("PupilX") > 0.95f && Math.Abs(c.GetParam("BodyTurnX") - 3) < 0.1f && c.GetParam("AngleX") == 0,
        $"look: standard names first (HeadTurnX {c.GetParam("HeadTurnX"):0.#}, PupilX {c.GetParam("PupilX"):0.##}, BodyTurnX {c.GetParam("BodyTurnX"):0.#}, AngleX {c.GetParam("AngleX")})");
}

// Timeline's mix: clips applied one after another give their weighted average over the rest
{
    float Mix(float rest, float[] values, float[] weights)
    {
        var applied = new float[weights.Length];
        UgoMix.Sequential(weights, weights.Length, applied);
        float v = rest;
        for (int i = 0; i < values.Length; i++) v += (values[i] - v) * applied[i];
        return v;
    }
    float a = Mix(10, new[] { 2f, 6f }, new[] { 0.25f, 0.75f }), b = Mix(10, new[] { 2f }, new[] { 0.5f }), c3 = Mix(10, new[] { 1f, 2f, 3f }, new[] { 0.2f, 0.3f, 0.5f });
    Check(Math.Abs(a - 5) < 1e-5 && Math.Abs(b - 6) < 1e-5 && Math.Abs(c3 - 2.3f) < 1e-5,
        $"timeline mix: cross-fade 2/6 at 1:3 = 5 ({a}), easing in over 10 at 0.5 = 6 ({b}), three clips = 2.3 ({c3})");
}

// catching up with the core: hit areas, bones in the world, reaching, wind (tests/unity_logic/rig.ug9; 100 px a unit, y up)
{
    var rm = UgoModel.FromBytes(File.ReadAllBytes(Path.Combine(root, "tests/unity_logic/rig.ug9")), null);
    UnityEngine.Vector3 W(float x, float y) => new UnityEngine.Vector3(x / 100, -y / 100, 0);
    var c = new UgoCharacter { model = rm, manual = true };
    c.UpdateNow();
    Check(c.AreaAt(W(50, 50)) == "head" && c.AreaAt(W(10, 10)) == "body" && c.AreaAt(W(150, 150)) == null && c.AreaNames.Length == 2,
        $"AreaAt: head in front of body, nothing outside ({c.AreaAt(W(50, 50))}, {c.AreaAt(W(10, 10))}, [{string.Join(",", c.AreaNames)}])");
    var p1 = c.BonePosition("arm1");
    Check(p1.HasValue && Math.Abs(p1.Value.x - 1) < 1e-4 && Math.Abs(p1.Value.y + 1) < 1e-4 && Math.Abs(c.BoneRotation("arm1")) < 1e-3 && c.BonePosition("nope") == null,
        $"BonePosition / BoneRotation: arm1 at ({p1?.x}, {p1?.y}), {c.BoneRotation("arm1")}°");
    c.ReachFor("arm2", W(130, 165)); // 72 px from the shoulder (the arm is 80 long)
    c.UpdateNow();
    var p2 = c.BonePosition("arm2").Value;
    float r2 = c.BoneRotation("arm2") * MathF.PI / 180;
    float tx = p2.x + 0.4f * MathF.Cos(r2), ty = p2.y + 0.4f * MathF.Sin(r2);
    Check(Math.Abs(tx - 1.3f) < 0.02f && Math.Abs(ty + 1.65f) < 0.02f, $"ReachFor: the arm's tip reaches the point down and to the right ({tx:0.###}, {ty:0.###})");
    c.UpdateNow();
    var after = c.BonePosition("arm2").Value;
    Check(Math.Abs(after.x - 1.4f) < 1e-3, $"ReachFor lasts one frame: the arm is back ({after.x:0.###})");
    float HairX(float windX)
    {
        var h = new UgoCharacter { model = rm, manual = true, wind = new UnityEngine.Vector2(windX, 0) };
        for (int i = 0; i < 120; i++) { h.Advance(1f / 60); h.UpdateNow(); }
        return h.BonePosition("h2").Value.x;
    }
    float still = HairX(0), blown = HairX(600);
    Check(blown > still + 0.05f, $"wind pushes the hair its way (tip bone x {still:0.###} -> {blown:0.###})");
}

// render queue ranges between drawing owners: lower order first, then farther first, then the first one
{
    var bases = new int[4];
    int used = UgoQueueOrder.Assign(new[] { 0, 0, 1, 0 }, new[] { 5f, 9f, 0f, 5f }, new[] { 2, 3, 1, 4 }, 4, bases, 1000);
    Check(bases[1] == 0 && bases[0] == 3 && bases[3] == 5 && bases[2] == 9 && used == 10,
        $"owners get back-to-back queues: farther first, a higher order last ({string.Join(",", bases)})");
    var tight = new int[2];
    UgoQueueOrder.Assign(new[] { 0, 1 }, new[] { 0f, 0f }, new[] { 6, 6 }, 2, tight, 8);
    Check(tight[0] == 0 && tight[1] == 2, $"past the limit, the last owner shares the top queues ({string.Join(",", tight)})");
}

if (failures > 0) { Console.WriteLine($"{failures} check(s) failed"); return 1; }
Console.WriteLine("all Unity character checks passed");
return 0;
