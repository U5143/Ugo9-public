/* SPDX-FileCopyrightText: 2026 U5143
 * SPDX-License-Identifier: MIT */
// What games use on top of the core, without Unreal's types (tested outside Unreal in
// tests/unreal_core), with the same rules and numbers as the Unity package (UgoLayers,
// UgoExpressionMixer, UgoHelpers, UgoVoiceGate) and the Web:
//   Layers       animations on layers above the main one: cross-fades, queues, additive, masks
//   Expressions  a smile, anger, ... shown and hidden with fades (the model's own, or presets)
//   Helpers      looking at a point, blinking on its own, the mouth following a level
//   VoiceGate    a noise gate from loudness (dB) to the mouth's level
#pragma once

#include "UgoCore.h"

#include <functional>
#include <memory>
#include <string>
#include <vector>

namespace ugo9core {

class Layers {
public:
	struct Entry {
		int animation = -1;
		std::string name;
		float time = 0, speed = 1, weight = 1;
		bool loop = false, additive = false, done = false;
		std::shared_ptr<const AnimMask> mask;
		float fade = 0, from = 0, to = 0;
	};

	// forgets every layer when the model changes
	void Bind(const Model *model);
	// plays an animation on a layer now, mixing in over fade seconds (false: no such animation). loop: -1 the animation's own, 0 no, 1 yes
	bool Play(int layer, const std::string &name, float fade = 0.25f, int loop = -1, float speed = 1, float weight = 1, bool additive = false,
	          std::shared_ptr<const AnimMask> mask = nullptr);
	// plays it after the layer's current animation ends (a looping one: at the end of its loop)
	bool Queue(int layer, const std::string &name, float fade = 0.25f, int loop = -1, float speed = 1, float weight = 1, bool additive = false,
	           std::shared_ptr<const AnimMask> mask = nullptr);
	// fades the layer out over fade seconds and drops its queue
	void Stop(int layer, float fade = 0.25f);
	void SetWeight(int layer, float weight);
	float GetWeight(int layer) const;
	// the animation playing on the layer (null: none)
	const Entry *Current(int layer) const;
	int Count() const { return (int)layers_.size(); }
	// moves the clocks by dt seconds: speeds, loops, ends, fades, the queues
	void Update(float dt);
	// applies the layers in order (after the main animation, before SetParam and Update)
	void Apply(Instance &instance) const;
	// a layer's animation that does not loop reached its end: (layer, name)
	std::function<void(int, const std::string &)> Finished;

private:
	struct Layer {
		std::shared_ptr<Entry> current, old;
		float mix = 1, fadeTime = 0, weight = 1;
		std::vector<std::shared_ptr<Entry>> queue;
	};
	Layer &At(int i);
	std::shared_ptr<Entry> Make(const std::string &name, float fade, int loop, float speed, float weight, bool additive, std::shared_ptr<const AnimMask> mask) const;
	static void Start(Layer &l, std::shared_ptr<Entry> e);
	std::vector<std::unique_ptr<Layer>> layers_;
	const Model *model_ = nullptr;
};

class Expressions {
public:
	// one expression of a preset ({"format": "ugo9-expressions", ...}), read by the engine's own JSON reader
	struct Preset {
		std::string id;
		float fadeIn = 0.5f, fadeOut = 0.5f;
		std::vector<std::string> names;
		std::vector<uint32_t> ops; // UGO_EXPR_SET 0, ADD 1, MULTIPLY 2 (anything else: skipped by the core)
		std::vector<float> values;
		std::vector<int> index;    // filled by Load
	};

	void Bind(const Model *model);
	// adds a preset's expressions (they override the model's of the same name); returns the parameter names the model lacks
	std::vector<std::string> Load(std::vector<Preset> presets);
	bool Has(const std::string &name) const;
	// fades it in (fade < 0: its own fade-in time)
	void Show(const std::string &name, float fade = -1);
	// fades it out (fade < 0: its own fade-out time)
	void Hide(const std::string &name, float fade = -1);
	// shows only these; the others fade out
	void Only(const std::vector<std::string> &names);
	void HideAll();
	float Weight(const std::string &name) const;
	void Update(float dt);
	// after the animations and SetParam, before Update
	void Apply(Instance &instance) const;

private:
	struct Active { std::string name; float weight = 0, target = 0, fade = 0; };
	const Preset *FindPreset(const std::string &name) const;
	void FadeOf(const std::string &name, float &in, float &out) const;
	std::vector<Active> active_;
	std::vector<Preset> presets_; // later loads first
	const Model *model_ = nullptr;
};

class Helpers {
public:
	// the parameters they move (standard names; a model that lacks one is looked up again under its older name)
	std::string angleX = "HeadTurnX", angleY = "HeadTurnY", eyeBallX = "PupilX", eyeBallY = "PupilY", bodyAngleX = "BodyTurnX";
	std::vector<std::string> blinkParams = { "EyeOpenL", "EyeOpenR" };
	std::string mouthParam = "MouthOpen";
	static const char *OlderName(const std::string &name);

	// looking: where the target is, from the face, in model pixels (x right, y down)
	float lookX = 0, lookY = 0;
	bool looking = false;
	float lookRange = 400, lookSmoothing = 0.12f, lookBody = 0.3f;
	// blinking
	bool autoBlink = false;
	float blinkMin = 2, blinkMax = 6, blinkClose = 0.07f, blinkOpen = 0.12f;
	// mouth: 0..1 (negative: left to the animation)
	float mouthLevel = -1, mouthSmoothing = 0.06f;

	float BlinkOpenness() const { return blinkOpenness_; }
	void SetSeed(uint32_t seed);
	// moves the helpers on by dt and writes their parameters (after SetParam, before Update)
	void Apply(const Model &model, Instance &instance, float dt);

private:
	float Random01();
	void Blend(const Model &model, Instance &instance, const std::string &name, float amount, float part, float weight) const;
	float lx_ = 0, ly_ = 0, lookWeight_ = 0, blinkWait_ = -1, blinkT_ = -1, mouth_ = 0, blinkOpenness_ = 1;
	uint32_t seed_ = 12345;
};

class VoiceGate {
public:
	float gateDb = -45, rangeDb = 25, attack = 0.05f, hold = 0.12f;
	bool IsOpen() const { return open_; }
	float Level() const { return level_; }
	// loudness now (dB of the RMS) and the time since the last call; returns the mouth's level 0..1
	float Update(float db, float dt);

private:
	float above_ = 0, since_ = 1e9f, level_ = 0;
	bool open_ = false;
};

} // namespace ugo9core
