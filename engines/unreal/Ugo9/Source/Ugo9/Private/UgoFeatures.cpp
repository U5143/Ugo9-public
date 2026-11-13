/* SPDX-FileCopyrightText: 2026 U5143
 * SPDX-License-Identifier: MIT */
#include "UgoFeatures.h"

#include <algorithm>
#include <cmath>

namespace ugo9core {

// ---- layers ----

void Layers::Bind(const Model *model) {
	if (model_ == model) return;
	model_ = model;
	layers_.clear();
}

Layers::Layer &Layers::At(int i) {
	while ((int)layers_.size() <= i) layers_.emplace_back();
	if (!layers_[i]) layers_[i].reset(new Layer());
	return *layers_[i];
}

std::shared_ptr<Layers::Entry> Layers::Make(const std::string &name, float fade, int loop, float speed, float weight, bool additive,
                                            std::shared_ptr<const AnimMask> mask) const {
	const int a = model_ ? model_->FindAnimation(name) : -1;
	if (a < 0) return nullptr;
	auto e = std::make_shared<Entry>();
	e->animation = a; e->name = name;
	e->loop = loop < 0 ? model_->AnimationLoops(a) : loop != 0;
	e->speed = speed; e->weight = weight; e->additive = additive; e->mask = std::move(mask);
	e->fade = std::max(0.0f, fade); e->from = 0; e->to = model_->AnimationDuration(a);
	return e;
}

void Layers::Start(Layer &l, std::shared_ptr<Entry> e) {
	if (l.current && e->fade > 0) { l.old = l.current; l.mix = 0; l.fadeTime = e->fade; }
	else { l.old = nullptr; l.mix = 1; }
	l.current = std::move(e);
}

bool Layers::Play(int layer, const std::string &name, float fade, int loop, float speed, float weight, bool additive, std::shared_ptr<const AnimMask> mask) {
	if (layer < 0) return false;
	auto e = Make(name, fade, loop, speed, weight, additive, std::move(mask));
	if (!e) return false;
	Layer &l = At(layer);
	l.queue.clear();
	Start(l, std::move(e));
	return true;
}

bool Layers::Queue(int layer, const std::string &name, float fade, int loop, float speed, float weight, bool additive, std::shared_ptr<const AnimMask> mask) {
	if (layer < 0) return false;
	auto e = Make(name, fade, loop, speed, weight, additive, std::move(mask));
	if (!e) return false;
	Layer &l = At(layer);
	if (!l.current) Start(l, std::move(e)); else l.queue.push_back(std::move(e));
	return true;
}

void Layers::Stop(int layer, float fade) {
	if (layer < 0 || layer >= (int)layers_.size() || !layers_[layer]) return;
	Layer &l = *layers_[layer];
	l.queue.clear();
	if (!l.current) return;
	l.old = l.current; l.current = nullptr; l.mix = 0; l.fadeTime = std::max(0.0f, fade);
	if (l.fadeTime <= 0) { l.old = nullptr; l.mix = 1; }
}

void Layers::SetWeight(int layer, float weight) { if (layer >= 0) At(layer).weight = std::max(0.0f, std::min(1.0f, weight)); }
float Layers::GetWeight(int layer) const { return layer >= 0 && layer < (int)layers_.size() && layers_[layer] ? layers_[layer]->weight : 1.0f; }
const Layers::Entry *Layers::Current(int layer) const {
	return layer >= 0 && layer < (int)layers_.size() && layers_[layer] ? layers_[layer]->current.get() : nullptr;
}

void Layers::Update(float dt) {
	for (int i = 0; i < (int)layers_.size(); i++) {
		if (!layers_[i]) continue;
		Layer &l = *layers_[i];
		for (Entry *e : { l.old.get(), l.current.get() }) {
			if (!e || e->done) continue;
			e->time += dt * e->speed;
			const float len = e->to - e->from;
			if (e->loop && len > 0) {
				if (e->time - e->from >= len && e == l.current.get() && !l.queue.empty()) { e->time = e->to; e->done = true; }
				else e->time = e->from + std::fmod(std::fmod(e->time - e->from, len) + len, len);
			} else if (e->time >= e->to || e->time < e->from) {
				e->time = std::min(e->to, std::max(e->from, e->time));
				if (!e->done) { e->done = true; if (e == l.current.get() && Finished) Finished(i, e->name); }
			}
		}
		if (l.old) {
			l.mix = l.fadeTime > 0 ? std::min(1.0f, l.mix + dt / l.fadeTime) : 1.0f;
			if (l.mix >= 1) l.old = nullptr;
		}
		if (l.current && l.current->done && !l.queue.empty()) {
			auto n = l.queue.front();
			l.queue.erase(l.queue.begin());
			Start(l, std::move(n));
		}
	}
}

void Layers::Apply(Instance &instance) const {
	for (const auto &lp : layers_) {
		if (!lp || lp->weight <= 0) continue;
		const Layer &l = *lp;
		if (l.old) { // cross-fading: the old one in full under the new one; stopping: the old one fading out
			const float w = l.weight * l.old->weight * (l.old->additive || !l.current ? 1 - l.mix : 1.0f);
			if (w > 0) instance.ApplyAnimation(l.old->animation, l.old->time, w, l.old->additive, l.old->mask.get());
		}
		if (l.current) {
			const float w = l.weight * l.current->weight * (l.old ? l.mix : 1.0f);
			if (w > 0) instance.ApplyAnimation(l.current->animation, l.current->time, w, l.current->additive, l.current->mask.get());
		}
	}
}

// ---- expressions ----

void Expressions::Bind(const Model *model) {
	if (model_ == model) return;
	model_ = model;
	active_.clear();
	presets_.clear();
}

std::vector<std::string> Expressions::Load(std::vector<Preset> presets) {
	std::vector<std::string> missing;
	if (!model_) return missing;
	for (Preset &p : presets) {
		p.index = model_->ResolveParams(p.names);
		for (size_t i = 0; i < p.names.size(); i++)
			if (p.index[i] < 0 && std::find(missing.begin(), missing.end(), p.names[i]) == missing.end()) missing.push_back(p.names[i]);
	}
	presets_.insert(presets_.begin(), presets.begin(), presets.end());
	return missing;
}

const Expressions::Preset *Expressions::FindPreset(const std::string &name) const {
	for (const Preset &p : presets_) if (p.id == name) return &p;
	return nullptr;
}

bool Expressions::Has(const std::string &name) const { return FindPreset(name) || (model_ && model_->FindExpression(name) >= 0); }

void Expressions::FadeOf(const std::string &name, float &in, float &out) const {
	if (const Preset *p = FindPreset(name)) { in = p->fadeIn; out = p->fadeOut; return; }
	in = out = 0;
	if (model_) model_->ExpressionFade(model_->FindExpression(name), in, out);
}

void Expressions::Show(const std::string &name, float fade) {
	auto it = std::find_if(active_.begin(), active_.end(), [&](const Active &a) { return a.name == name; });
	if (it == active_.end()) { active_.push_back({ name }); it = active_.end() - 1; }
	float in, out;
	FadeOf(name, in, out);
	it->target = 1;
	it->fade = fade >= 0 ? fade : in;
}

void Expressions::Hide(const std::string &name, float fade) {
	auto it = std::find_if(active_.begin(), active_.end(), [&](const Active &a) { return a.name == name; });
	if (it == active_.end()) return;
	float in, out;
	FadeOf(name, in, out);
	it->target = 0;
	it->fade = fade >= 0 ? fade : out;
}

void Expressions::Only(const std::vector<std::string> &names) {
	std::vector<std::string> shown;
	for (const Active &a : active_) shown.push_back(a.name);
	for (const std::string &n : shown) if (std::find(names.begin(), names.end(), n) == names.end()) Hide(n);
	for (const std::string &n : names) Show(n);
}

void Expressions::HideAll() {
	std::vector<std::string> shown;
	for (const Active &a : active_) shown.push_back(a.name);
	for (const std::string &n : shown) Hide(n);
}

float Expressions::Weight(const std::string &name) const {
	for (const Active &a : active_) if (a.name == name) return a.weight;
	return 0;
}

void Expressions::Update(float dt) {
	for (Active &a : active_) {
		const float step = a.fade > 0 ? dt / a.fade : 1.0f;
		a.weight = a.target > a.weight ? std::min(a.target, a.weight + step) : std::max(a.target, a.weight - step);
	}
	active_.erase(std::remove_if(active_.begin(), active_.end(), [](const Active &a) { return a.weight <= 0 && a.target <= 0; }), active_.end());
}

void Expressions::Apply(Instance &instance) const {
	for (const Active &a : active_) {
		if (a.weight <= 0) continue;
		if (const Preset *p = FindPreset(a.name)) instance.ApplyParams(p->index, p->ops, p->values, a.weight);
		else if (model_) instance.ApplyExpression(model_->FindExpression(a.name), a.weight);
	}
}

// ---- helpers ----

const char *Helpers::OlderName(const std::string &name) {
	if (name == "HeadTurnX") return "AngleX";
	if (name == "HeadTurnY") return "AngleY";
	if (name == "PupilX") return "EyeBallX";
	if (name == "PupilY") return "EyeBallY";
	if (name == "BodyTurnX") return "BodyAngleX";
	return nullptr;
}

static int FindParam(const Model &model, const std::string &name) {
	int i = model.FindParameter(name);
	if (i < 0) if (const char *old = Helpers::OlderName(name)) i = model.FindParameter(old);
	return i;
}

static float Follow(float current, float target, float smoothing, float dt) {
	return smoothing <= 0 ? target : current + (target - current) * (1 - std::exp(-dt / smoothing));
}

void Helpers::SetSeed(uint32_t seed) { seed_ = seed == 0 ? 1 : seed; blinkWait_ = -1; }

float Helpers::Random01() {
	seed_ ^= seed_ << 13; seed_ ^= seed_ >> 17; seed_ ^= seed_ << 5;
	return (float)(seed_ & 0xffffff) / 16777216.0f;
}

void Helpers::Blend(const Model &model, Instance &instance, const std::string &name, float amount, float part, float weight) const {
	const int i = FindParam(model, name);
	if (i < 0) return;
	const float lo = model.ParameterMin(i), hi = model.ParameterMax(i), def = model.ParameterDefault(i);
	const float target = def + (amount >= 0 ? (hi - def) : (def - lo)) * amount * part;
	const float v = instance.GetParam(i);
	instance.SetParam(i, v + (target - v) * weight);
}

void Helpers::Apply(const Model &model, Instance &instance, float dt) {
	// looking: fade in and out with the same smoothing, so turning away is gentle too
	lookWeight_ = Follow(lookWeight_, looking ? 1.0f : 0.0f, lookSmoothing, dt);
	const float range = std::max(1.0f, lookRange);
	const float nx = looking ? std::max(-1.0f, std::min(1.0f, lookX / range)) : lx_;
	const float ny = looking ? std::max(-1.0f, std::min(1.0f, lookY / range)) : ly_;
	lx_ = Follow(lx_, nx, lookSmoothing, dt);
	ly_ = Follow(ly_, ny, lookSmoothing, dt);
	if (lookWeight_ > 1e-4f) {
		Blend(model, instance, angleX, lx_, 1, lookWeight_);
		Blend(model, instance, angleY, -ly_, 1, lookWeight_);
		Blend(model, instance, eyeBallX, lx_, 1, lookWeight_);
		Blend(model, instance, eyeBallY, -ly_, 1, lookWeight_);
		Blend(model, instance, bodyAngleX, lx_, lookBody, lookWeight_);
	}
	// blinking: wait, close, open
	if (autoBlink) {
		if (blinkWait_ < 0) blinkWait_ = blinkMin + (blinkMax - blinkMin) * Random01();
		if (blinkT_ < 0) {
			blinkWait_ -= dt;
			if (blinkWait_ <= 0) blinkT_ = 0;
			blinkOpenness_ = 1;
		}
		if (blinkT_ >= 0) {
			blinkT_ += dt;
			blinkOpenness_ = blinkT_ < blinkClose ? 1 - blinkT_ / blinkClose : std::min(1.0f, (blinkT_ - blinkClose) / blinkOpen);
			if (blinkT_ >= blinkClose + blinkOpen) { blinkT_ = -1; blinkWait_ = -1; blinkOpenness_ = 1; }
		}
		for (const std::string &n : blinkParams) {
			const int i = model.FindParameter(n);
			if (i >= 0) instance.SetParam(i, instance.GetParam(i) * blinkOpenness_);
		}
	} else blinkOpenness_ = 1;
	// the mouth follows the level: quick to open, slower to close
	if (mouthLevel >= 0) {
		const float target = std::max(0.0f, std::min(1.0f, mouthLevel));
		mouth_ = Follow(mouth_, target, target > mouth_ ? mouthSmoothing * 0.5f : mouthSmoothing, dt);
		const int i = model.FindParameter(mouthParam);
		if (i >= 0) instance.SetParam(i, model.ParameterMin(i) + (model.ParameterMax(i) - model.ParameterMin(i)) * mouth_);
	}
}

// ---- voice gate ----

float VoiceGate::Update(float db, float dt) {
	above_ = db > gateDb ? above_ + dt : 0;
	if (!open_ && above_ >= attack) open_ = true;
	if (open_) {
		since_ = db > gateDb - 4 ? 0 : since_ + dt;
		if (since_ > hold) { open_ = false; since_ = 1e9f; }
	}
	level_ = open_ ? std::max(0.0f, std::min(1.0f, (db - gateDb) / std::max(1e-3f, rangeDb))) : 0.0f;
	return level_;
}

} // namespace ugo9core
