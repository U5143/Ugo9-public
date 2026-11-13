/* SPDX-FileCopyrightText: 2026 U5143
 * SPDX-License-Identifier: MIT */
// Helpers games use with most characters (the same as the Unity package's UgoHelpers and the
// Web's UgoLook; parameters by their standard names first, then the older AngleX... names):
// looking at something (face, eyes and a little of the body turn towards it), blinking
// on its own, and the mouth following a level (lip-sync from loudness). They write the
// usual parameters by name after the animations and set_param, before the update; a
// model without one of them simply skips it.
#pragma once

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstring>

#include "ugo.h"

namespace ugo9 {

struct UgoHelpers {
	// looking: where the target is from the face, in model pixels (x right, y down)
	bool looking = false;
	float look_x = 0, look_y = 0;
	float look_range = 400;      // model pixels at which the face turns all the way
	float look_smoothing = 0.12f; // seconds to get most of the way there
	float look_body = 0.3f;      // how much of BodyAngleX's range the body follows
	// blinking
	bool auto_blink = false;
	float blink_min = 2, blink_max = 6, blink_close = 0.07f, blink_open = 0.12f;
	// the mouth: 0..1, negative leaves it to the animation
	float mouth_level = -1;
	float mouth_smoothing = 0.06f;

	float blink_openness = 1;

	void apply(const ::UgoModel *m, ::UgoInstance *in, float dt) {
		look_weight_ = follow(look_weight_, looking ? 1.0f : 0.0f, look_smoothing, dt);
		const float nx = looking ? std::clamp(look_x / std::max(1.0f, look_range), -1.0f, 1.0f) : lx_;
		const float ny = looking ? std::clamp(look_y / std::max(1.0f, look_range), -1.0f, 1.0f) : ly_;
		lx_ = follow(lx_, nx, look_smoothing, dt);
		ly_ = follow(ly_, ny, look_smoothing, dt);
		if (look_weight_ > 1e-4f) {
			// the standard names first, then the older ones (docs/パラメータの名前.md)
			blend(m, in, "HeadTurnX", "AngleX", lx_, 1, look_weight_);
			blend(m, in, "HeadTurnY", "AngleY", -ly_, 1, look_weight_);
			blend(m, in, "PupilX", "EyeBallX", lx_, 1, look_weight_);
			blend(m, in, "PupilY", "EyeBallY", -ly_, 1, look_weight_);
			blend(m, in, "BodyTurnX", "BodyAngleX", lx_, look_body, look_weight_);
		}
		if (auto_blink) {
			if (blink_wait_ < 0) blink_wait_ = blink_min + (blink_max - blink_min) * random01();
			if (blink_t_ < 0) {
				blink_wait_ -= dt;
				if (blink_wait_ <= 0) blink_t_ = 0;
				blink_openness = 1;
			}
			if (blink_t_ >= 0) {
				blink_t_ += dt;
				blink_openness = blink_t_ < blink_close ? 1 - blink_t_ / blink_close : std::min(1.0f, (blink_t_ - blink_close) / blink_open);
				if (blink_t_ >= blink_close + blink_open) {
					blink_t_ = -1;
					blink_wait_ = -1;
					blink_openness = 1;
				}
			}
			for (const char *n : { "EyeOpenL", "EyeOpenR" }) {
				const int i = find(m, n);
				if (i >= 0) ugo_set_param(in, (uint32_t)i, ugo_get_param(in, (uint32_t)i) * blink_openness);
			}
		} else {
			blink_openness = 1;
		}
		if (mouth_level >= 0) {
			const float target = std::clamp(mouth_level, 0.0f, 1.0f);
			mouth_ = follow(mouth_, target, target > mouth_ ? mouth_smoothing * 0.5f : mouth_smoothing, dt);
			const int i = find(m, "MouthOpen");
			if (i >= 0) {
				const float lo = ugo_param_min(m, (uint32_t)i), hi = ugo_param_max(m, (uint32_t)i);
				ugo_set_param(in, (uint32_t)i, lo + (hi - lo) * mouth_);
			}
		}
	}

private:
	float lx_ = 0, ly_ = 0, look_weight_ = 0, mouth_ = 0;
	float blink_wait_ = -1, blink_t_ = -1;
	uint32_t seed_ = 12345;

	float random01() {
		seed_ ^= seed_ << 13;
		seed_ ^= seed_ >> 17;
		seed_ ^= seed_ << 5;
		return (float)(seed_ & 0xffffff) / 16777216.0f;
	}
	static float follow(float current, float target, float smoothing, float dt) {
		return smoothing <= 0 ? target : current + (target - current) * (1 - std::exp(-dt / smoothing));
	}
	static int find(const ::UgoModel *m, const char *name) { return ugo_find_param(m, name); }
	static void blend(const ::UgoModel *m, ::UgoInstance *in, const char *name, const char *older, float amount, float part, float weight) {
		int i = find(m, name);
		if (i < 0) i = find(m, older);
		if (i < 0) return;
		const float lo = ugo_param_min(m, (uint32_t)i), hi = ugo_param_max(m, (uint32_t)i), def = ugo_param_default(m, (uint32_t)i);
		const float target = def + (amount >= 0 ? (hi - def) : (def - lo)) * amount * part;
		const float v = ugo_get_param(in, (uint32_t)i);
		ugo_set_param(in, (uint32_t)i, v + (target - v) * weight);
	}
};

// A noise gate for lip-sync (the Unity package's UgoVoiceGate and the Web's VoiceLevel): opens once the
// voice stays above gate_db for attack seconds, stays open until below gate_db - 4 dB for hold seconds,
// and opens by how far above the gate it is over range_db.
struct UgoVoiceGate {
	float gate_db = -45, range_db = 25, attack = 0.05f, hold = 0.12f;
	bool open = false;
	float level = 0;
	float update(float db, float dt) {
		above_ = db > gate_db ? above_ + dt : 0;
		if (!open && above_ >= attack) open = true;
		if (open) {
			since_ = db > gate_db - 4 ? 0 : since_ + dt;
			if (since_ > hold) { open = false; since_ = 1e9f; }
		}
		level = open ? std::clamp((db - gate_db) / std::max(1e-3f, range_db), 0.0f, 1.0f) : 0.0f;
		return level;
	}

private:
	float above_ = 0, since_ = 1e9f;
};

} // namespace ugo9
