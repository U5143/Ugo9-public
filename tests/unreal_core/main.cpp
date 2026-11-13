// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// The Unreal plugin's core layer (engines/unreal/Ugo9/Source/Ugo9/*/UgoCore.*, UgoFeatures.*), without Unreal:
// the same checks as tests/unity_core for the Unity package. Built and run by tests/unreal_core_test.mjs.
#include <algorithm>
#include <cmath>
#include <memory>
#include <cstdio>
#include <fstream>
#include <iterator>
#include <string>
#include <vector>

#include "UgoCore.h"
#include "UgoFeatures.h"

static int failures = 0;
static void Check(bool ok, const std::string &msg) {
	std::printf("%s %s\n", ok ? "ok  " : "FAIL", msg.c_str());
	if (!ok) failures++;
}
static std::vector<uint8_t> Read(const std::string &path) {
	std::ifstream f(path, std::ios::binary);
	return std::vector<uint8_t>((std::istreambuf_iterator<char>(f)), {});
}

int main(int argc, char **argv) {
	const std::string root = argc > 1 ? argv[1] : "../..";
	using namespace ugo9core;

	const auto bytes = Read(root + "/samples/basic/model.ug9");
	Model basic;
	const bool loaded = basic.Load(bytes.data(), bytes.size());
	Check(loaded, "samples/basic loads " + basic.Error());
	Check(basic.FindParameter("HeadTurnX") >= 0 && basic.FindAnimation("idle") >= 0 && basic.FindPart("face") >= 0 && basic.FindBone("head") >= 0,
		"names: parameters, animations, parts, bones (" + std::to_string(basic.ParameterNames().size()) + " parameters)");
	float canvas[4];
	basic.Canvas(canvas);
	Check(canvas[0] == 420 && canvas[1] == 600, "canvas 420 x 600");
	const int idle = basic.FindAnimation("idle");
	Check(std::fabs(basic.AnimationDuration(idle) - 6) < 1e-6 && basic.AnimationLoops(idle), "idle lasts 6 s and loops");
	Check(basic.Warnings() == 0 && basic.WarningText().empty() && basic.FormatMajor() == Model::CoreMajor(), "no warnings, the core's major format");

	Instance a(basic), b(basic);
	a.ResetParams(); a.ApplyAnimation(idle, 1.3f, 1); a.Update(0);
	b.ResetParams(); b.ApplyAnimation(idle, 1.3f, 1); b.SetParam(basic.FindParameter("HeadTurnX"), 25); b.Update(0);
	const uint32_t ff = basic.FrameFloats();
	bool differ = false;
	for (uint32_t i = 0; i < ff; i++) differ |= a.Frame()[i] != b.Frame()[i];
	Check(differ && std::fabs(b.GetParam(basic.FindParameter("HeadTurnX")) - 25) < 1e-6, "a parameter changes the frame block and reads back");
	Check(a.Frame()[0] == 1 && a.Frame()[3] == 1 && a.Frame()[6] == 0 && a.Frame()[7] == 0, "a new instance is placed with the identity (and the colour floats left at 0)");
	a.ResetParams(); a.Update(0);
	Check(basic.PartNames()[a.PickPart(0, -330)] == "face" && a.PickPart(5000, 5000) == -1, "pick: the face at its middle, nothing far away");
	float box[4];
	Check(a.BoundsEstimate(box) && box[0] < -100 && box[2] > 100 && box[1] < -500 && box[3] >= 0, "a box around every vertex");

	// the GPU's tables (the same as the Unity package's GpuTables)
	const ugo9core::GpuTables &t = basic.Tables();
	size_t drawn = 0;
	for (const auto &r : t.runs) drawn += r.indices.size();
	Check(t.vertices.size() == 16 * (size_t)basic.VertexCount() && t.parts.size() == 8 * basic.PartNames().size() && t.positions.size() == 2 * (size_t)basic.VertexCount(),
		"tables: 16 floats per vertex, 8 per part, 2 positions per vertex");
	Check(!t.runs.empty() && drawn > 0 && drawn % 3 == 0 && t.frameFloats == basic.FrameFloats() && t.maskChannels > 0 && !t.maskIndices.empty(),
		"runs of drawn triangles (" + std::to_string(drawn / 3) + " in " + std::to_string(t.runs.size()) + " run(s)), masks, frame layout");
	{ // a draw order (format 0.8): the same triangles, in the order given (what the Unreal renderer keeps per key)
		std::vector<uint32_t> back;
		for (size_t i = basic.PartNames().size(); i-- > 0;) back.push_back((uint32_t)i);
		const std::vector<ugo9core::GpuTables::Run> rev = basic.RunsFor(back.data());
		size_t n = 0;
		for (const auto &r : rev) n += r.indices.size();
		const bool flipped = !rev.empty() && !t.runs.empty() && rev.front().indices.front() != t.runs.front().indices.front();
		Check(n == drawn && flipped, "runs for a reversed draw order: the same triangles, the last part first");
	}
	bool entriesOk = true;
	for (size_t i = 0; i < t.entries.size(); i += 4) entriesOk &= t.entries[i] >= 0 && std::isfinite(t.entries[i + 1]);
	Check(entriesOk && t.minX < 0 && t.maxX > 0, "morph entries (morph numbers, finite moves), bounds around the origin");

	// ---- stage 4: what games use on top (UgoFeatures, the same rules as the Unity package) ----
	{
		// standard parameter names first, then the older ones (the sample is being renamed)
		auto param = [&](const char *name) { int i = basic.FindParameter(name); if (i < 0 && Helpers::OlderName(name)) i = basic.FindParameter(Helpers::OlderName(name)); return i; };
		const int mouth = basic.FindParameter("MouthOpen"), eyeL = basic.FindParameter("EyeOpenL"), turn = param("HeadTurnX");
		Check(mouth >= 0 && eyeL >= 0 && turn >= 0, "the sample has a mouth, eyes and a head turn");
		const int idle = basic.FindAnimation("idle");

		// layers: a masked layer changes only its tracks; a non-looping one ends, says so, and the queue goes on
		Instance in(basic);
		Layers layers;
		layers.Bind(&basic);
		auto mask = std::make_shared<AnimMask>();
		std::string err;
		Check(mask->Make(basic, {}, {}, { "MouthOpen" }, err), "a mask of one parameter");
		AnimMask badMask;
		const bool badMade = badMask.Make(basic, { "noSuchBone" }, {}, {}, err);
		Check(!badMade && err.find("noSuchBone") != std::string::npos, "a mask naming a missing bone: " + err);
		Check(layers.Play(0, "talk", 0, -1, 1, 1, false, mask) && !layers.Play(0, "nothing"), "play a layer (and not a missing animation)");
		layers.Update(0.3f);
		in.ResetParams();
		in.ApplyAnimation(idle, 0.3f, 1);
		const float turnIdle = in.GetParam(turn), mouthIdle = in.GetParam(mouth);
		layers.Apply(in);
		Instance talk(basic);
		talk.ResetParams();
		talk.ApplyAnimation(basic.FindAnimation("talk"), 0.3f, 1);
		Check(std::fabs(in.GetParam(mouth) - talk.GetParam(mouth)) < 1e-4f && std::fabs(in.GetParam(turn) - turnIdle) < 1e-4f && std::fabs(mouthIdle - talk.GetParam(mouth)) > 1e-3f,
			"the masked layer moves the mouth like talk and leaves the head as idle");
		std::string ended;
		int endedLayer = -1;
		layers.Finished = [&](int l, const std::string &n) { endedLayer = l; ended = n; };
		layers.Play(1, "talk", 0, 0);
		layers.Queue(1, "idle", 0);
		layers.Update(basic.AnimationDuration(basic.FindAnimation("talk")) + 0.01f);
		layers.Update(0.01f);
		Check(endedLayer == 1 && ended == "talk" && layers.Current(1) && layers.Current(1)->name == "idle", "a layer that does not loop ends (Finished) and the queued one starts");
		layers.Stop(1, 0);
		Check(!layers.Current(1) && layers.GetWeight(0) == 1, "stopping a layer");

		// expressions: a preset sets a parameter, fades in, and names what the model lacks
		Expressions ex;
		ex.Bind(&basic);
		Expressions::Preset smile;
		smile.id = "smile"; smile.fadeIn = 0.5f; smile.fadeOut = 0.5f;
		smile.names = { "MouthOpen", "NoSuchParam" }; smile.ops = { 0, 0 }; smile.values = { 1, 1 };
		const auto missing = ex.Load({ smile });
		Check(missing.size() == 1 && missing[0] == "NoSuchParam" && ex.Has("smile") && !ex.Has("frown"), "a preset loads; the missing parameter is named");
		ex.Show("smile");
		ex.Update(0.25f);
		Instance e(basic);
		e.ResetParams();
		const float before = e.GetParam(mouth);
		ex.Apply(e);
		Check(std::fabs(ex.Weight("smile") - 0.5f) < 1e-4f && std::fabs(e.GetParam(mouth) - (before + (1 - before) * 0.5f)) < 1e-3f, "half way through the fade, half the expression");
		ex.Hide("smile", 0);
		ex.Update(0.01f);
		Check(ex.Weight("smile") == 0, "hidden at once");

		// helpers: looking right turns the head right; blinking shuts the eyes now and then; the mouth follows a level
		Helpers h;
		h.looking = true; h.lookX = 400; h.lookY = 0;
		h.autoBlink = true; h.blinkMin = h.blinkMax = 0.5f;
		h.mouthLevel = 1;
		Instance hi(basic);
		float minEye = 1e9f;
		for (int k = 0; k < 60; k++) {
			hi.ResetParams();
			h.Apply(basic, hi, 1.0f / 60);
			minEye = std::min(minEye, hi.GetParam(eyeL));
		}
		Check(hi.GetParam(turn) > 0.8f * basic.ParameterMax(turn), "looking right turns the head most of the way (" + std::to_string(hi.GetParam(turn)) + ")");
		Check(minEye < 0.2f * basic.ParameterMax(eyeL), "a blink within a second shuts the eyes");
		Check(hi.GetParam(mouth) > 0.9f * basic.ParameterMax(mouth), "the mouth opens with the level");

		// the noise gate: a click stays shut, a voice opens it, silence closes it after the hold
		VoiceGate g;
		Check(g.Update(-20, 0.02f) == 0, "a short sound does not open the gate");
		g.Update(-80, 0.02f);
		g.Update(-30, 0.03f);
		const float open = g.Update(-30, 0.03f);
		g.Update(-80, 0.1f);
		const bool stillOpen = g.IsOpen();
		g.Update(-80, 0.1f);
		Check(open > 0.5f && stillOpen && !g.IsOpen(), "a voice opens the gate; silence closes it after the hold");

		// bones, reaching, boxes, wind, areas
		Instance b(basic);
		b.ResetParams();
		b.SetWind(50, 0, 0.5f);
		b.Update(0);
		float w[6], box[4];
		const int head = basic.FindBone("head");
		Check(b.BoneWorld(head, w) && std::isfinite(w[4]) && !b.BoneWorld(999, w), "a bone's world matrix");
		Check(b.Bounds(-1, box) && box[0] < box[2] && b.Bounds(basic.FindPart("face"), box) && box[0] < box[2], "boxes around everything and around the face");
		b.BoneWorld(head, w);
		const float tx = w[4] + 60, ty = w[5];
		const float left = b.SolveIK(head, 2, tx, ty);
		Check(left >= 0 && left < 60, "reaching: the head moves towards a point (" + std::to_string(left) + " px left)");
		Check(basic.AreaNames().empty() && b.PickArea(0, -330) == -1, "no hit areas in the sample");
	}

	// a file from another major version: the message says what to do
	auto other = bytes;
	other[4] = 9; other[5] = 0;
	Model bad;
	const bool badLoaded = bad.Load(other.data(), other.size());
	Check(!badLoaded && bad.Error().find("update the Ugo9 plugin") != std::string::npos, "another major version: " + bad.Error());
	Model empty;
	Check(!empty.Load(nullptr, 0) && !empty.IsLoaded(), "empty data does not load");
	// a later 1.x file (tests/future): loads, with a warning
	const auto future = Read(root + "/tests/future/model.ug9");
	Model fut;
	Check(fut.Load(future.data(), future.size()) && fut.Warnings() != 0 && fut.WarningText().find("Update the Ugo9 plugin") != std::string::npos,
		"a later 1.x loads with a warning");

	if (failures) { std::printf("%d check(s) failed\n", failures); return 1; }
	std::printf("all Unreal core checks passed\n");
	return 0;
}
