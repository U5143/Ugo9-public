/* SPDX-FileCopyrightText: 2026 U5143
 * SPDX-License-Identifier: MIT */
// Animation layers on top of a character's main animation (the same rules as the Web's
// UgoAnimator and the Unity package's UgoLayers): each layer plays one animation at a time,
// cross-fades to the next, can wait in a queue, and is applied over the layers below it,
// mixed towards (weight) or added (the change from the rest pose), on all tracks or a mask's.
#pragma once

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <functional>
#include <memory>
#include <vector>

#include <godot_cpp/variant/string.hpp>

#include "ugo.h"

namespace ugo9 {

// Which tracks a layer applies: one byte per bone / part / parameter / ...; an empty list = all of that kind.
struct UgoLayerMask {
	std::vector<uint8_t> bones, parts, params, morphs, constraints, colors;
	::UgoAnimMask c{};
	const ::UgoAnimMask *get() {
		auto at = [](std::vector<uint8_t> &v) -> const uint8_t * { return v.empty() ? nullptr : v.data(); };
		c = { at(bones), at(parts), at(params), at(morphs), at(constraints), at(colors) };
		return &c;
	}
};

class UgoLayers {
public:
	struct Entry {
		int anim = -1;
		godot::String name;
		float time = 0, speed = 1, weight = 1, fade = 0, to = 0;
		bool loop = false, additive = false, done = false;
		std::shared_ptr<UgoLayerMask> mask;
	};

	std::function<void(int, const godot::String &)> finished;

	void clear() { layers_.clear(); }

	bool play(int layer, const ::UgoModel *m, int anim, const godot::String &name, float fade, float weight, bool additive,
			std::shared_ptr<UgoLayerMask> mask, int loop = -1, float speed = 1) {
		Entry e;
		if (!make(m, anim, name, fade, weight, additive, std::move(mask), loop, speed, e)) return false;
		Layer &l = at(layer);
		l.queue.clear();
		start(l, std::move(e));
		return true;
	}
	bool queue(int layer, const ::UgoModel *m, int anim, const godot::String &name, float fade, float weight, bool additive,
			std::shared_ptr<UgoLayerMask> mask, int loop = -1, float speed = 1) {
		Entry e;
		if (!make(m, anim, name, fade, weight, additive, std::move(mask), loop, speed, e)) return false;
		Layer &l = at(layer);
		if (!l.has_current) start(l, std::move(e));
		else l.queue.push_back(std::move(e));
		return true;
	}
	void stop(int layer, float fade) {
		if (layer < 0 || layer >= (int)layers_.size()) return;
		Layer &l = layers_[layer];
		l.queue.clear();
		if (!l.has_current) return;
		l.old = l.current;
		l.has_old = true;
		l.has_current = false;
		l.mix = 0;
		l.fade_time = std::max(0.0f, fade);
		if (l.fade_time <= 0) { l.has_old = false; l.mix = 1; }
	}
	void set_weight(int layer, float w) { at(layer).weight = std::clamp(w, 0.0f, 1.0f); }
	float get_weight(int layer) const { return layer >= 0 && layer < (int)layers_.size() ? layers_[layer].weight : 1.0f; }
	godot::String current(int layer) const {
		return layer >= 0 && layer < (int)layers_.size() && layers_[layer].has_current ? layers_[layer].current.name : godot::String();
	}

	void update(float dt) {
		for (int i = 0; i < (int)layers_.size(); i++) {
			Layer &l = layers_[i];
			for (int k = 0; k < 2; k++) {
				const bool is_current = k == 1;
				if (is_current ? !l.has_current : !l.has_old) continue;
				Entry &e = is_current ? l.current : l.old;
				if (e.done) continue;
				e.time += dt * e.speed;
				if (e.loop && e.to > 0) {
					if (e.time >= e.to && is_current && !l.queue.empty()) { e.time = e.to; e.done = true; }
					else e.time = std::fmod(std::fmod(e.time, e.to) + e.to, e.to);
				} else if (e.time >= e.to || e.time < 0) {
					e.time = std::clamp(e.time, 0.0f, e.to);
					if (!e.done) {
						e.done = true;
						if (is_current && finished) finished(i, e.name);
					}
				}
			}
			if (l.has_old) {
				l.mix = l.fade_time > 0 ? std::min(1.0f, l.mix + dt / l.fade_time) : 1.0f;
				if (l.mix >= 1) l.has_old = false;
			}
			if (l.has_current && l.current.done && !l.queue.empty()) {
				Entry n = std::move(l.queue.front());
				l.queue.erase(l.queue.begin());
				start(l, std::move(n));
			}
		}
	}

	void apply(::UgoInstance *in) {
		for (Layer &l : layers_) {
			if (l.weight <= 0) continue;
			if (l.has_old) {
				const float w = l.weight * l.old.weight * (l.old.additive || !l.has_current ? 1 - l.mix : 1);
				if (w > 0) run(in, l.old, w);
			}
			if (l.has_current) {
				const float w = l.weight * l.current.weight * (l.has_old ? l.mix : 1);
				if (w > 0) run(in, l.current, w);
			}
		}
	}

private:
	struct Layer {
		Entry current, old;
		bool has_current = false, has_old = false;
		float mix = 1, fade_time = 0, weight = 1;
		std::vector<Entry> queue;
	};
	std::vector<Layer> layers_;

	Layer &at(int i) {
		if ((int)layers_.size() <= i) layers_.resize(i + 1);
		return layers_[i];
	}
	static bool make(const ::UgoModel *m, int anim, const godot::String &name, float fade, float weight, bool additive,
			std::shared_ptr<UgoLayerMask> mask, int loop, float speed, Entry &e) {
		if (!m || anim < 0) return false;
		e.anim = anim;
		e.name = name;
		e.to = ugo_animation_duration(m, (uint32_t)anim);
		e.loop = loop < 0 ? ugo_animation_loop(m, (uint32_t)anim) != 0 : loop != 0;
		e.fade = std::max(0.0f, fade);
		e.weight = weight;
		e.speed = speed;
		e.additive = additive;
		e.mask = std::move(mask);
		return true;
	}
	static void start(Layer &l, Entry e) {
		if (l.has_current && e.fade > 0) {
			l.old = l.current;
			l.has_old = true;
			l.mix = 0;
			l.fade_time = e.fade;
		} else {
			l.has_old = false;
			l.mix = 1;
		}
		l.current = std::move(e);
		l.has_current = true;
	}
	static void run(::UgoInstance *in, const Entry &e, float w) {
		if (!e.additive && !e.mask) ugo_apply_animation(in, (uint32_t)e.anim, e.time, w);
		else ugo_apply_animation_ex(in, (uint32_t)e.anim, e.time, w, e.additive ? UGO_ANIM_ADD : 0u, e.mask ? e.mask->get() : nullptr);
	}
};

} // namespace ugo9
