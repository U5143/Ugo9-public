/* SPDX-FileCopyrightText: 2026 U5143
 * SPDX-License-Identifier: MIT */
#include "ugo_character.h"

#include <godot_cpp/classes/rendering_server.hpp>
#include <godot_cpp/classes/audio_server.hpp>
#include <godot_cpp/classes/engine.hpp>
#include <godot_cpp/classes/json.hpp>
#include <godot_cpp/core/class_db.hpp>
#include <godot_cpp/variant/utility_functions.hpp>

#include <algorithm>
#include <cmath>

#include "ugo_batch.h"
#include "ugo_drawer.h"

using namespace godot;

namespace ugo9 {

UgoCharacter::UgoCharacter() {
	anim_layers_.finished = [this](int layer, const String &name) { emit_signal("layer_finished", layer + 1, name); };
}
UgoCharacter::~UgoCharacter() { detach(); }

void UgoCharacter::set_model(const Ref<UgoModel> &model) {
	if (model_ == model) return;
	const Callable changed = callable_mp(this, &UgoCharacter::on_model_changed);
	if (model_.is_valid() && model_->is_connected("changed", changed)) model_->disconnect("changed", changed);
	model_ = model;
	if (model_.is_valid()) model_->connect("changed", changed);
	on_model_changed();
}

void UgoCharacter::on_model_changed() {
	drawer_.reset();
	const ::UgoModel *m = model_.is_valid() ? model_->core() : nullptr;
	if (m != built_for_) {
		rebuild_instance(); // a new atlas alone keeps the state
		notify_property_list_changed(); // the model's parameters as Inspector sliders
	}
	if (batch_) batch_->mark_dirty();
}

void UgoCharacter::rebuild_instance() {
	instance_ = nullptr;
	mem_.clear();
	overrides_.clear();
	layers_.clear();
	anim_layers_.clear();
	presets_.clear();
	expressions_.clear();
	expression_shown_ = String();
	inspector_dirty_ = true;
	built_for_ = model_.is_valid() ? model_->core() : nullptr;
	if (model_.is_null() || !model_->is_loaded()) return;
	const ::UgoModel *m = model_->core();
	mem_ = blocks(ugo_instance_mem_size(m));
	instance_ = ugo_instance_init(mem_.data(), m);
	anim_index_ = model_->find_animation(animation_);
}

void UgoCharacter::set_animation(const String &name) {
	if (name != animation_) finished_ = false;
	animation_ = name;
	anim_index_ = model_.is_valid() ? model_->find_animation(name) : -1;
}

void UgoCharacter::play(const String &name, float from_time, float fade) {
	if (fade > 0 && anim_index_ >= 0) {
		from_anim_ = anim_index_;
		from_time_ = time_;
		fade_total_ = fade;
		fade_t_ = 0;
	} else {
		from_anim_ = -1;
	}
	set_animation(name);
	time_ = from_time;
	playing_ = true;
	finished_ = false;
	queue_.clear();
}

void UgoCharacter::play_next(const String &name, float fade) { queue_.push_back({ name, fade }); }

void UgoCharacter::stop() { playing_ = false; }

void UgoCharacter::advance(double delta) {
	pending_dt_ += delta;
	if (!playing_) return;
	time_ += (float)(delta * speed_);
	anim_layers_.update((float)(delta * speed_));
	if (from_anim_ >= 0) {
		from_time_ += (float)(delta * speed_);
		fade_t_ += (float)delta;
		if (fade_t_ >= fade_total_) from_anim_ = -1;
	}
	const float d = (instance_ && anim_index_ >= 0) ? ugo_animation_duration(model_->core(), anim_index_) : 0.0f;
	if (d > 0.0f && !finished_ && time_ >= d && !ugo_animation_loop(model_->core(), anim_index_)) {
		finished_ = true;
		const String ended = animation_;
		emit_signal("animation_finished", ended);
		if (!queue_.empty() && animation_ == ended) { // (a handler may have started something else)
			const std::pair<String, float> next = queue_.front();
			std::vector<std::pair<String, float>> rest(queue_.begin() + 1, queue_.end());
			play(next.first, 0.0f, next.second);
			queue_ = rest;
		}
	}
	// keep the clock small: looping and clamped animations look the same
	if (d > 0.0f && time_ > 2.0f * d) time_ = d + std::fmod(time_ - d, d);
}

void UgoCharacter::set_param(const String &name, float value) {
	const int i = model_.is_valid() ? model_->find_parameter(name) : -1;
	if (i < 0) return;
	for (auto &o : overrides_) {
		if (o.first == i) {
			o.second = value;
			return;
		}
	}
	overrides_.emplace_back(i, value);
}

void UgoCharacter::clear_param(const String &name) {
	const int i = model_.is_valid() ? model_->find_parameter(name) : -1;
	for (size_t k = 0; k < overrides_.size(); k++) {
		if (overrides_[k].first == i) {
			overrides_.erase(overrides_.begin() + k);
			return;
		}
	}
}

void UgoCharacter::clear_params() { overrides_.clear(); }

float UgoCharacter::get_param(const String &name) const {
	const int i = model_.is_valid() ? model_->find_parameter(name) : -1;
	return (i < 0 || !instance_) ? 0.0f : ugo_get_param(instance_, i);
}

void UgoCharacter::add_blend(const String &name, float time, float weight) {
	const int a = model_.is_valid() ? model_->find_animation(name) : -1;
	if (a >= 0) layers_.push_back({ a, time, weight });
}

// ---- layers ----

std::shared_ptr<UgoLayerMask> UgoCharacter::make_mask(const Dictionary &mask, bool &ok) const {
	ok = true;
	if (mask.is_empty() || model_.is_null()) return nullptr;
	const ::UgoModel *m = model_->core();
	auto mask_out = std::make_shared<UgoLayerMask>();
	struct Kind { const char *key; uint32_t count; const char *(*name)(const ::UgoModel *, uint32_t); std::vector<uint8_t> *out; };
	const Kind kinds[] = {
		{ "bones", ugo_bone_count(m), ugo_bone_name, &mask_out->bones },
		{ "parts", ugo_part_count(m), ugo_part_name, &mask_out->parts },
		{ "params", ugo_param_count(m), ugo_param_name, &mask_out->params },
	};
	for (const Kind &k : kinds) {
		if (!mask.has(k.key)) continue;
		k.out->assign(std::max<uint32_t>(1, k.count), 0);
		const Array names = mask[k.key];
		for (int n = 0; n < names.size(); n++) {
			const String want = names[n];
			bool found = false;
			for (uint32_t i = 0; i < k.count && !found; i++) {
				if (want == String::utf8(k.name(m, i))) { (*k.out)[i] = 1; found = true; }
			}
			if (!found) {
				UtilityFunctions::push_error("Ugo9: the mask names ", k.key, " \"", want, "\", which the model does not have");
				ok = false;
				return nullptr;
			}
		}
	}
	return mask_out;
}

static bool layer_ok(int layer) {
	if (layer >= 1) return true;
	UtilityFunctions::push_error("Ugo9: layers start at 1 (layer 0 is the main animation: play)");
	return false;
}

bool UgoCharacter::play_layer(int layer, const String &name, float fade, bool additive, const Dictionary &mask, float weight) {
	if (!layer_ok(layer) || !instance_) return false;
	bool ok;
	auto mk = make_mask(mask, ok);
	return ok && anim_layers_.play(layer - 1, model_->core(), model_->find_animation(name), name, fade, weight, additive, mk);
}

bool UgoCharacter::queue_layer(int layer, const String &name, float fade, bool additive, const Dictionary &mask, float weight) {
	if (!layer_ok(layer) || !instance_) return false;
	bool ok;
	auto mk = make_mask(mask, ok);
	return ok && anim_layers_.queue(layer - 1, model_->core(), model_->find_animation(name), name, fade, weight, additive, mk);
}

void UgoCharacter::stop_layer(int layer, float fade) { if (layer_ok(layer)) anim_layers_.stop(layer - 1, fade); }
void UgoCharacter::set_layer_weight(int layer, float weight) { if (layer_ok(layer)) anim_layers_.set_weight(layer - 1, weight); }
float UgoCharacter::get_layer_weight(int layer) const { return layer >= 1 ? anim_layers_.get_weight(layer - 1) : 1.0f; }
String UgoCharacter::get_layer_animation(int layer) const { return layer >= 1 ? anim_layers_.current(layer - 1) : String(); }

void UgoCharacter::reset_physics() {
	if (instance_) ugo_reset_physics(instance_);
}

// The character's local coordinates are the model's pixels (the placement maps them on screen).
String UgoCharacter::get_part_at(const Vector2 &global_point, float min_opacity) {
	if (!instance_ || model_.is_null()) return String();
	const Vector2 p = get_global_transform().affine_inverse().xform(global_point);
	const int part = ugo_pick_part(instance_, nullptr, (float)p.x, (float)p.y, min_opacity);
	return part >= 0 ? String::utf8(ugo_part_name(model_->core(), (uint32_t)part)) : String();
}

void UgoCharacter::build_areas() {
	const ::UgoModel *m = model_.is_valid() ? model_->core() : nullptr;
	if (m == areas_for_) return;
	areas_for_ = m;
	area_mask_.clear();
	area_of_part_.clear();
	if (!m) return;
	const uint32_t n = ugo_part_count(m);
	area_mask_.assign(std::max<uint32_t>(1, n), 0);
	area_of_part_.resize(n);
	for (uint32_t i = 0; i < n; i++) {
		const String name = String::utf8(ugo_part_name(m, i));
		for (const char *pre : { "hit:", "当たり:", "当たり：" }) {
			const String p = String::utf8(pre);
			if (name.begins_with(p)) {
				area_mask_[i] = 1;
				area_of_part_[i] = name.substr(p.length());
			}
		}
	}
}

String UgoCharacter::get_area_at(const Vector2 &global_point) {
	if (!instance_ || model_.is_null()) return String();
	build_areas();
	const Vector2 p = get_global_transform().affine_inverse().xform(global_point);
	const int part = ugo_pick_area(instance_, nullptr, (float)p.x, (float)p.y, area_mask_.data());
	return part >= 0 ? area_of_part_[part] : String();
}

PackedStringArray UgoCharacter::get_area_names() {
	build_areas();
	PackedStringArray out;
	for (const String &a : area_of_part_) if (!a.is_empty() && !out.has(a)) out.push_back(a);
	return out;
}

// The bone's world matrix is in model pixels (= the node's local space): through the node to global.
Transform2D UgoCharacter::get_bone_transform(const String &bone) {
	const int b = (instance_ && model_.is_valid()) ? ugo_find_bone(model_->core(), bone.utf8().get_data()) : -1;
	if (b < 0) return Transform2D();
	float w[6];
	ugo_bone_world(instance_, (uint32_t)b, w);
	return get_global_transform() * Transform2D(Vector2(w[0], w[1]), Vector2(w[2], w[3]), Vector2(w[4], w[5]));
}

void UgoCharacter::reach_for(const String &bone, const Vector2 &global_point, int chain) {
	const int b = (instance_ && model_.is_valid()) ? ugo_find_bone(model_->core(), bone.utf8().get_data()) : -1;
	if (b < 0) return;
	reach_.push_back({ b, std::max(1, chain), get_global_transform().affine_inverse().xform(global_point) });
}

Rect2 UgoCharacter::cull_rect() const {
	float box[4];
	if (instance_ && ugo_bounds_estimate(instance_, box)) return Rect2(box[0], box[1], box[2] - box[0], box[3] - box[1]);
	return model_.is_valid() ? model_->cull_bounds() : Rect2();
}

Rect2 UgoCharacter::get_part_rect(const String &part) {
	if (!instance_ || model_.is_null()) return Rect2();
	int index = -1;
	if (!part.is_empty()) {
		index = model_->get_part_names().find(part);
		if (index < 0) return Rect2();
	}
	float box[4];
	if (!ugo_bounds(instance_, nullptr, index, box)) return Rect2();
	return Rect2(box[0], box[1], box[2] - box[0], box[3] - box[1]);
}

void UgoCharacter::evaluate(const Transform2D &placement) {
	if (!instance_) return;
	ugo_reset_params(instance_);
	if (from_anim_ >= 0 && fade_total_ > 0) {
		// a cross-fade: the one before at full weight, the new one over it
		ugo_apply_animation(instance_, from_anim_, from_time_, 1.0f);
		if (anim_index_ >= 0) ugo_apply_animation(instance_, anim_index_, time_, std::min(1.0f, fade_t_ / fade_total_));
	} else if (anim_index_ >= 0) {
		ugo_apply_animation(instance_, anim_index_, time_, 1.0f);
	}
	for (const Layer &l : layers_) ugo_apply_animation(instance_, l.anim, l.time, l.weight);
	layers_.clear();
	anim_layers_.apply(instance_);
	// values set in the Inspector, then set_param over them
	if (inspector_dirty_ || inspector_for_ != model_->core()) {
		inspector_cache_.clear();
		const Array keys = inspector_params_.keys();
		for (int k = 0; k < keys.size(); k++) {
			const int i = model_->find_parameter(keys[k]);
			if (i >= 0) inspector_cache_.push_back({ i, (float)(double)inspector_params_[keys[k]] });
		}
		inspector_for_ = model_->core();
		inspector_dirty_ = false;
	}
	for (const auto &o : inspector_cache_) ugo_set_param(instance_, o.first, o.second);
	for (const auto &o : overrides_) ugo_set_param(instance_, o.first, o.second);
	if (expression_shown_ != expression_) {
		if (!expression_shown_.is_empty()) hide_expression(expression_shown_, 0.0f);
		if (!expression_.is_empty()) show_expression(expression_, 0.0f);
		expression_shown_ = expression_;
	}
	// expressions after the animations and set_param, before the update (physics follows them)
	apply_expressions((float)pending_dt_);
	apply_helpers((float)pending_dt_);
	// placement before the update: swaying chains feel how far the character moved
	const Vector2 &x = placement.columns[0], &y = placement.columns[1], &o = placement.columns[2];
	ugo_set_transform(instance_, x.x, x.y, y.x, y.y, o.x, o.y);
	ugo_set_wind(instance_, (float)wind_.x, (float)wind_.y, wind_gust_);
	ugo_update(instance_, (float)pending_dt_);
	pending_dt_ = 0.0;
	// reaching: from the pose just made, then once more to show it (and let constraints follow)
	if (!reach_.empty()) {
		for (const Reach &r : reach_) ugo_solve_ik_to(instance_, (uint32_t)r.bone, (uint32_t)r.chain, (float)r.target.x, (float)r.target.y, 16);
		reach_.clear();
		ugo_update(instance_, 0.0f);
	}
}

// ---- expressions (format 0.8) ----

PackedStringArray UgoCharacter::get_expression_names() const { return model_.is_valid() ? model_->get_expression_names() : PackedStringArray(); }

const UgoCharacter::ExprPreset *UgoCharacter::find_preset(const String &name) const {
	for (const ExprPreset &p : presets_) if (p.id == name) return &p;
	return nullptr;
}

void UgoCharacter::expression_fade(const String &name, float &in, float &out) const {
	in = out = 0;
	if (const ExprPreset *p = find_preset(name)) { in = p->fade_in; out = p->fade_out; return; }
	const int e = model_.is_valid() ? model_->find_expression(name) : -1;
	if (e < 0) return;
	float f[2];
	ugo_expression_fade(model_->core(), (uint32_t)e, f);
	in = f[0];
	out = f[1];
}

void UgoCharacter::show_expression(const String &name, float fade) {
	ExprActive *a = nullptr;
	for (ExprActive &x : expressions_) if (x.name == name) a = &x;
	if (!a) {
		expressions_.push_back({ name });
		a = &expressions_.back();
	}
	float in, out;
	expression_fade(name, in, out);
	a->target = 1;
	a->fade = fade >= 0 ? fade : in;
}

void UgoCharacter::hide_expression(const String &name, float fade) {
	for (ExprActive &a : expressions_) {
		if (a.name != name) continue;
		float in, out;
		expression_fade(name, in, out);
		a.target = 0;
		a.fade = fade >= 0 ? fade : out;
	}
}

void UgoCharacter::only_expressions(const PackedStringArray &names) {
	for (ExprActive &a : expressions_) if (!names.has(a.name)) hide_expression(a.name, -1);
	for (const String &n : names) show_expression(n, -1);
}

float UgoCharacter::get_expression_weight(const String &name) const {
	for (const ExprActive &a : expressions_) if (a.name == name) return a.weight;
	return 0;
}

void UgoCharacter::apply_expressions(float dt) {
	for (ExprActive &a : expressions_) {
		const float step = a.fade > 0 ? dt / a.fade : 1.0f;
		a.weight = a.target > a.weight ? std::min(a.target, a.weight + step) : std::max(a.target, a.weight - step);
	}
	expressions_.erase(std::remove_if(expressions_.begin(), expressions_.end(), [](const ExprActive &a) { return a.weight <= 0 && a.target <= 0; }), expressions_.end());
	for (const ExprActive &a : expressions_) {
		if (a.weight <= 0) continue;
		if (const ExprPreset *p = find_preset(a.name)) {
			ugo_apply_params(instance_, p->index.data(), p->ops.data(), p->values.data(), (uint32_t)p->index.size(), a.weight);
		} else {
			const int e = model_->find_expression(a.name);
			if (e >= 0) ugo_apply_expression(instance_, (uint32_t)e, a.weight);
		}
	}
}

PackedStringArray UgoCharacter::load_expressions(const String &json) {
	PackedStringArray missing;
	if (!instance_) {
		UtilityFunctions::push_error("Ugo9: load_expressions needs a loaded model");
		return missing;
	}
	const Variant parsed = JSON::parse_string(json);
	if (parsed.get_type() != Variant::DICTIONARY || Dictionary(parsed).get("format", "") != Variant("ugo9-expressions")) {
		UtilityFunctions::push_error("Ugo9: not an expression preset (format \"ugo9-expressions\")");
		return missing;
	}
	const Array list = Dictionary(parsed).get("expressions", Array());
	std::vector<ExprPreset> loaded;
	for (int i = 0; i < list.size(); i++) {
		if (list[i].get_type() != Variant::DICTIONARY) continue;
		const Dictionary e = list[i];
		if (e.get("id", Variant()).get_type() != Variant::STRING) continue;
		ExprPreset p;
		p.id = e["id"];
		if (e.has("fadeIn")) p.fade_in = (float)(double)e["fadeIn"];
		if (e.has("fadeOut")) p.fade_out = (float)(double)e["fadeOut"];
		const Dictionary params = e.get("params", Dictionary());
		const Array keys = params.keys();
		std::vector<CharString> names;
		for (int k = 0; k < keys.size(); k++) {
			const Variant v = params[keys[k]];
			if (v.get_type() != Variant::ARRAY || Array(v).size() < 2) continue;
			const Array pair = v;
			const String op = pair[0];
			names.push_back(String(keys[k]).utf8());
			p.ops.push_back(op == "set" ? UGO_EXPR_SET : op == "add" ? UGO_EXPR_ADD : op == "multiply" ? UGO_EXPR_MULTIPLY : 0xffffffffu);
			p.values.push_back((float)(double)pair[1]);
		}
		std::vector<const char *> ptrs;
		for (const CharString &n : names) ptrs.push_back(n.get_data());
		p.index.resize(names.size());
		ugo_resolve_params(model_->core(), ptrs.data(), (uint32_t)ptrs.size(), p.index.data());
		for (size_t k = 0; k < names.size(); k++) {
			const String n = String::utf8(names[k].get_data());
			if (p.index[k] < 0 && !missing.has(n)) missing.push_back(n);
		}
		loaded.push_back(std::move(p));
	}
	presets_.insert(presets_.begin(), loaded.begin(), loaded.end()); // the newest preset wins
	return missing;
}

const float *UgoCharacter::frame() const { return instance_ ? ugo_frame(instance_) : nullptr; }

void UgoCharacter::attach() {
	for (Node *n = get_parent(); n; n = n->get_parent()) {
		if (UgoBatch *b = Object::cast_to<UgoBatch>(n)) {
			batch_ = b;
			batch_->add_character(this);
			return;
		}
	}
	RenderingServer::get_singleton()->connect("frame_pre_draw", callable_mp(this, &UgoCharacter::draw_alone));
	connected_ = true;
}

void UgoCharacter::detach() {
	if (batch_) {
		batch_->remove_character(this);
		batch_ = nullptr;
	}
	if (connected_) {
		RenderingServer *rs = RenderingServer::get_singleton();
		if (rs) rs->disconnect("frame_pre_draw", callable_mp(this, &UgoCharacter::draw_alone));
		connected_ = false;
	}
	drawer_.reset();
}

// Not under a batch: one draw for this character. The placement is its
// on-screen transform (so swaying chains feel it move); the draw cancels it
// again inside the character's own canvas item.
void UgoCharacter::draw_alone() {
	if (!can_draw()) return;
	if (!drawer_) drawer_ = std::make_unique<UgoDrawer>(model_, this, false);
	const Transform2D placement = get_global_transform();
	draw_tint = get_self_modulate(); // modulate reaches the drawer's canvas items on its own
	evaluate(placement);
	drawer_->set_item_transform(placement.affine_inverse());
	std::vector<UgoCharacter *> one{ this };
	drawer_->draw(one);
}

void UgoCharacter::_notification(int what) {
	switch (what) {
		case NOTIFICATION_ENTER_TREE:
			attach();
			set_process_internal(true);
			break;
		case NOTIFICATION_EXIT_TREE:
			detach();
			break;
		case NOTIFICATION_MOVED_IN_PARENT:
			if (batch_) batch_->mark_dirty();
			break;
		case NOTIFICATION_INTERNAL_PROCESS:
			if (!manual_ && (preview_in_editor_ || !Engine::get_singleton()->is_editor_hint())) advance(get_process_delta_time());
			break;
	}
}

void UgoCharacter::set_expression(const String &name) { expression_ = name; }

void UgoCharacter::apply_helpers(float dt) {
	const ::UgoModel *m = model_->core();
	bool looking = look_at_point_;
	Vector2 at = look_point_;
	if (!look_target_.is_empty() && is_inside_tree()) {
		if (Node2D *t = Object::cast_to<Node2D>(get_node_or_null(look_target_))) {
			at = t->get_global_position();
			looking = true;
		}
	}
	helpers_.looking = looking;
	if (looking) {
		const Vector2 local = is_inside_tree() ? get_global_transform().affine_inverse().xform(at) : at; // model pixels, y down
		const float *cv = ugo_canvas(m); // width, height, origin x, origin y
		const Vector2 face = look_from_ != Vector2() ? look_from_ : Vector2(cv[0] / 2 - cv[2], cv[1] / 4 - cv[3]);
		helpers_.look_x = local.x - face.x;
		helpers_.look_y = local.y - face.y;
	}
	if (!String(lip_sync_bus_).is_empty()) {
		AudioServer *audio = AudioServer::get_singleton();
		const int bus = audio->get_bus_index(lip_sync_bus_);
		if (bus >= 0) {
			const float db = std::max(audio->get_bus_peak_volume_left_db(bus, 0), audio->get_bus_peak_volume_right_db(bus, 0));
			const float gained = db + 20.0f * std::log10(std::max(1e-6f, lip_sync_gain_));
			helpers_.mouth_level = voice_gate_.update(std::max(-100.0f, gained), dt); // keys and breath stay shut
		}
	}
	helpers_.apply(m, instance_, dt);
}

// the model's parameters as "parameters/<name>" sliders in the Inspector
bool UgoCharacter::_set(const StringName &name, const Variant &value) {
	const String n = name;
	if (!n.begins_with("parameters/")) return false;
	const String p = n.substr(11);
	if (value.get_type() == Variant::NIL) inspector_params_.erase(p);
	else inspector_params_[p] = value;
	inspector_dirty_ = true;
	return true;
}

bool UgoCharacter::_get(const StringName &name, Variant &ret) const {
	const String n = name;
	if (!n.begins_with("parameters/")) return false;
	const String p = n.substr(11);
	if (inspector_params_.has(p)) {
		ret = inspector_params_[p];
	} else {
		const int i = model_.is_valid() ? model_->find_parameter(p) : -1;
		ret = i >= 0 ? ugo_param_default(model_->core(), (uint32_t)i) : 0.0f;
	}
	return true;
}

void UgoCharacter::_get_property_list(List<PropertyInfo> *list) const {
	if (model_.is_null() || !model_->is_loaded()) return;
	const ::UgoModel *m = model_->core();
	for (uint32_t i = 0, n = ugo_param_count(m); i < n; i++) {
		const String p = String::utf8(ugo_param_name(m, i));
		const String range = String::num(ugo_param_min(m, i)) + "," + String::num(ugo_param_max(m, i)) + ",0.001";
		// saved with the scene only when set here
		const uint32_t usage = inspector_params_.has(p) ? PROPERTY_USAGE_DEFAULT : PROPERTY_USAGE_EDITOR;
		list->push_back(PropertyInfo(Variant::FLOAT, "parameters/" + p, PROPERTY_HINT_RANGE, range, usage));
	}
}

// the animation and the expression offer the model's names
void UgoCharacter::_validate_property(PropertyInfo &property) const {
	if (model_.is_null() || !model_->is_loaded()) return;
	if (property.name == StringName("animation")) {
		property.hint = PROPERTY_HINT_ENUM_SUGGESTION;
		property.hint_string = String(",").join(model_->get_animation_names());
	} else if (property.name == StringName("expression")) {
		property.hint = PROPERTY_HINT_ENUM_SUGGESTION;
		property.hint_string = String(",").join(model_->get_expression_names());
	}
}

void UgoCharacter::_bind_methods() {
	ClassDB::bind_method(D_METHOD("set_model", "model"), &UgoCharacter::set_model);
	ClassDB::bind_method(D_METHOD("get_model"), &UgoCharacter::get_model);
	ClassDB::bind_method(D_METHOD("set_animation", "name"), &UgoCharacter::set_animation);
	ClassDB::bind_method(D_METHOD("get_animation"), &UgoCharacter::get_animation);
	ClassDB::bind_method(D_METHOD("set_playing", "playing"), &UgoCharacter::set_playing);
	ClassDB::bind_method(D_METHOD("is_playing"), &UgoCharacter::is_playing);
	ClassDB::bind_method(D_METHOD("set_speed", "speed"), &UgoCharacter::set_speed);
	ClassDB::bind_method(D_METHOD("get_speed"), &UgoCharacter::get_speed);
	ClassDB::bind_method(D_METHOD("set_time", "time"), &UgoCharacter::set_time);
	ClassDB::bind_method(D_METHOD("get_time"), &UgoCharacter::get_time);
	ClassDB::bind_method(D_METHOD("set_manual", "manual"), &UgoCharacter::set_manual);
	ClassDB::bind_method(D_METHOD("is_manual"), &UgoCharacter::is_manual);
	ClassDB::bind_method(D_METHOD("advance", "delta"), &UgoCharacter::advance);
	ClassDB::bind_method(D_METHOD("play", "name", "from_time", "fade"), &UgoCharacter::play, DEFVAL(0.0f), DEFVAL(0.0f));
	ClassDB::bind_method(D_METHOD("play_next", "name", "fade"), &UgoCharacter::play_next, DEFVAL(0.0f));
	ClassDB::bind_method(D_METHOD("is_finished"), &UgoCharacter::is_finished);
	ADD_SIGNAL(MethodInfo("animation_finished", PropertyInfo(Variant::STRING, "name")));
	ClassDB::bind_method(D_METHOD("play_layer", "layer", "name", "fade", "additive", "mask", "weight"), &UgoCharacter::play_layer, DEFVAL(0.25f), DEFVAL(false), DEFVAL(Dictionary()), DEFVAL(1.0f));
	ClassDB::bind_method(D_METHOD("queue_layer", "layer", "name", "fade", "additive", "mask", "weight"), &UgoCharacter::queue_layer, DEFVAL(0.25f), DEFVAL(false), DEFVAL(Dictionary()), DEFVAL(1.0f));
	ClassDB::bind_method(D_METHOD("stop_layer", "layer", "fade"), &UgoCharacter::stop_layer, DEFVAL(0.25f));
	ClassDB::bind_method(D_METHOD("set_layer_weight", "layer", "weight"), &UgoCharacter::set_layer_weight);
	ClassDB::bind_method(D_METHOD("get_layer_weight", "layer"), &UgoCharacter::get_layer_weight);
	ClassDB::bind_method(D_METHOD("get_layer_animation", "layer"), &UgoCharacter::get_layer_animation);
	ADD_SIGNAL(MethodInfo("layer_finished", PropertyInfo(Variant::INT, "layer"), PropertyInfo(Variant::STRING, "name")));
	ClassDB::bind_method(D_METHOD("stop"), &UgoCharacter::stop);
	ClassDB::bind_method(D_METHOD("set_param", "name", "value"), &UgoCharacter::set_param);
	ClassDB::bind_method(D_METHOD("clear_param", "name"), &UgoCharacter::clear_param);
	ClassDB::bind_method(D_METHOD("clear_params"), &UgoCharacter::clear_params);
	ClassDB::bind_method(D_METHOD("get_param", "name"), &UgoCharacter::get_param);
	ClassDB::bind_method(D_METHOD("add_blend", "name", "time", "weight"), &UgoCharacter::add_blend);
	ClassDB::bind_method(D_METHOD("reset_physics"), &UgoCharacter::reset_physics);
	ClassDB::bind_method(D_METHOD("get_expression_names"), &UgoCharacter::get_expression_names);
	ClassDB::bind_method(D_METHOD("get_part_at", "global_point", "min_opacity"), &UgoCharacter::get_part_at, DEFVAL(0.01f));
	ClassDB::bind_method(D_METHOD("hit_test", "global_point", "min_opacity"), &UgoCharacter::hit_test, DEFVAL(0.01f));
	ClassDB::bind_method(D_METHOD("get_part_rect", "part"), &UgoCharacter::get_part_rect, DEFVAL(String()));
	ClassDB::bind_method(D_METHOD("get_area_at", "global_point"), &UgoCharacter::get_area_at);
	ClassDB::bind_method(D_METHOD("get_area_names"), &UgoCharacter::get_area_names);
	ClassDB::bind_method(D_METHOD("get_bone_transform", "bone"), &UgoCharacter::get_bone_transform);
	ClassDB::bind_method(D_METHOD("reach_for", "bone", "global_point", "chain"), &UgoCharacter::reach_for, DEFVAL(2));
	ClassDB::bind_method(D_METHOD("set_wind", "wind"), &UgoCharacter::set_wind);
	ClassDB::bind_method(D_METHOD("get_wind"), &UgoCharacter::get_wind);
	ClassDB::bind_method(D_METHOD("set_wind_gust", "gust"), &UgoCharacter::set_wind_gust);
	ClassDB::bind_method(D_METHOD("get_wind_gust"), &UgoCharacter::get_wind_gust);
	ADD_PROPERTY(PropertyInfo(Variant::VECTOR2, "wind"), "set_wind", "get_wind");
	ADD_PROPERTY(PropertyInfo(Variant::FLOAT, "wind_gust"), "set_wind_gust", "get_wind_gust");
	ClassDB::bind_method(D_METHOD("show_expression", "name", "fade"), &UgoCharacter::show_expression, DEFVAL(-1.0f));
	ClassDB::bind_method(D_METHOD("hide_expression", "name", "fade"), &UgoCharacter::hide_expression, DEFVAL(-1.0f));
	ClassDB::bind_method(D_METHOD("only_expressions", "names"), &UgoCharacter::only_expressions);
	ClassDB::bind_method(D_METHOD("get_expression_weight", "name"), &UgoCharacter::get_expression_weight);
	ClassDB::bind_method(D_METHOD("load_expressions", "json"), &UgoCharacter::load_expressions);
	ClassDB::bind_method(D_METHOD("update_now"), &UgoCharacter::update_now);
	ADD_PROPERTY(PropertyInfo(Variant::OBJECT, "model", PROPERTY_HINT_RESOURCE_TYPE, "UgoModel"), "set_model", "get_model");
	ADD_PROPERTY(PropertyInfo(Variant::STRING, "animation"), "set_animation", "get_animation");
	ClassDB::bind_method(D_METHOD("set_expression", "name"), &UgoCharacter::set_expression);
	ClassDB::bind_method(D_METHOD("get_expression"), &UgoCharacter::get_expression);
	ClassDB::bind_method(D_METHOD("set_preview_in_editor", "on"), &UgoCharacter::set_preview_in_editor);
	ClassDB::bind_method(D_METHOD("is_preview_in_editor"), &UgoCharacter::is_preview_in_editor);
	ADD_PROPERTY(PropertyInfo(Variant::STRING, "expression"), "set_expression", "get_expression");
	ADD_PROPERTY(PropertyInfo(Variant::BOOL, "preview_in_editor"), "set_preview_in_editor", "is_preview_in_editor");
	ClassDB::bind_method(D_METHOD("set_look_target", "path"), &UgoCharacter::set_look_target);
	ClassDB::bind_method(D_METHOD("get_look_target"), &UgoCharacter::get_look_target);
	ClassDB::bind_method(D_METHOD("look_at_point", "global_point"), &UgoCharacter::look_at_point);
	ClassDB::bind_method(D_METHOD("stop_looking"), &UgoCharacter::stop_looking);
	ClassDB::bind_method(D_METHOD("set_look_from", "model_pixels"), &UgoCharacter::set_look_from);
	ClassDB::bind_method(D_METHOD("get_look_from"), &UgoCharacter::get_look_from);
	ClassDB::bind_method(D_METHOD("set_look_range", "model_pixels"), &UgoCharacter::set_look_range);
	ClassDB::bind_method(D_METHOD("get_look_range"), &UgoCharacter::get_look_range);
	ClassDB::bind_method(D_METHOD("set_auto_blink", "on"), &UgoCharacter::set_auto_blink);
	ClassDB::bind_method(D_METHOD("is_auto_blink"), &UgoCharacter::is_auto_blink);
	ClassDB::bind_method(D_METHOD("set_mouth_level", "level"), &UgoCharacter::set_mouth_level);
	ClassDB::bind_method(D_METHOD("set_lip_sync_bus", "bus"), &UgoCharacter::set_lip_sync_bus);
	ClassDB::bind_method(D_METHOD("get_lip_sync_bus"), &UgoCharacter::get_lip_sync_bus);
	ClassDB::bind_method(D_METHOD("set_lip_sync_gain", "gain"), &UgoCharacter::set_lip_sync_gain);
	ClassDB::bind_method(D_METHOD("get_lip_sync_gain"), &UgoCharacter::get_lip_sync_gain);
	ADD_GROUP("Helpers", "");
	ADD_PROPERTY(PropertyInfo(Variant::NODE_PATH, "look_target", PROPERTY_HINT_NODE_PATH_VALID_TYPES, "Node2D"), "set_look_target", "get_look_target");
	ADD_PROPERTY(PropertyInfo(Variant::VECTOR2, "look_from"), "set_look_from", "get_look_from");
	ADD_PROPERTY(PropertyInfo(Variant::FLOAT, "look_range"), "set_look_range", "get_look_range");
	ADD_PROPERTY(PropertyInfo(Variant::BOOL, "auto_blink"), "set_auto_blink", "is_auto_blink");
	ADD_PROPERTY(PropertyInfo(Variant::STRING_NAME, "lip_sync_bus"), "set_lip_sync_bus", "get_lip_sync_bus");
	ADD_PROPERTY(PropertyInfo(Variant::FLOAT, "lip_sync_gain"), "set_lip_sync_gain", "get_lip_sync_gain");
	ClassDB::bind_method(D_METHOD("set_lip_sync_gate_db", "db"), &UgoCharacter::set_lip_sync_gate_db);
	ClassDB::bind_method(D_METHOD("get_lip_sync_gate_db"), &UgoCharacter::get_lip_sync_gate_db);
	ClassDB::bind_method(D_METHOD("set_lip_sync_range_db", "db"), &UgoCharacter::set_lip_sync_range_db);
	ClassDB::bind_method(D_METHOD("get_lip_sync_range_db"), &UgoCharacter::get_lip_sync_range_db);
	ADD_PROPERTY(PropertyInfo(Variant::FLOAT, "lip_sync_gate_db"), "set_lip_sync_gate_db", "get_lip_sync_gate_db");
	ADD_PROPERTY(PropertyInfo(Variant::FLOAT, "lip_sync_range_db"), "set_lip_sync_range_db", "get_lip_sync_range_db");
	ADD_PROPERTY(PropertyInfo(Variant::BOOL, "playing"), "set_playing", "is_playing");
	ADD_PROPERTY(PropertyInfo(Variant::FLOAT, "speed"), "set_speed", "get_speed");
	ADD_PROPERTY(PropertyInfo(Variant::BOOL, "manual"), "set_manual", "is_manual");
	ADD_PROPERTY(PropertyInfo(Variant::FLOAT, "time", PROPERTY_HINT_NONE, "", PROPERTY_USAGE_EDITOR), "set_time", "get_time");
}

} // namespace ugo9
