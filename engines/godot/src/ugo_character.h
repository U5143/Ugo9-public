/* SPDX-FileCopyrightText: 2026 U5143
 * SPDX-License-Identifier: MIT */
// UgoCharacter: one Ugo9 character (a Node2D). Under a UgoBatch it is drawn
// together with the batch's other characters; on its own it draws itself.
#pragma once

#include <godot_cpp/classes/node2d.hpp>

#include <memory>
#include <vector>

#include "ugo_helpers.h"
#include "ugo_layers.h"
#include "ugo_model.h"

namespace ugo9 {

class UgoBatch;
class UgoDrawer;

class UgoCharacter : public godot::Node2D {
	GDCLASS(UgoCharacter, godot::Node2D)

	godot::Ref<UgoModel> model_;
	std::vector<Block> mem_;
	::UgoInstance *instance_ = nullptr;
	// wind on the swaying chains, and bones reaching for points this frame
	godot::Vector2 wind_;
	float wind_gust_ = 0;
	struct Reach { int bone; int chain; godot::Vector2 target; };
	std::vector<Reach> reach_;
	// hit areas: per part, 1 when it is one ("hit:<name>", "当たり:<name>")
	std::vector<uint8_t> area_mask_;
	std::vector<godot::String> area_of_part_;
	const ::UgoModel *areas_for_ = nullptr;
	void build_areas();
	const ::UgoModel *built_for_ = nullptr;
	godot::String animation_;
	int anim_index_ = -1;
	bool playing_ = true;
	float speed_ = 1.0f;
	float time_ = 0.0f;
	double pending_dt_ = 0.0;
	bool manual_ = false;
	struct Layer {
		int anim;
		float time, weight;
	};
	std::vector<Layer> layers_;
	std::vector<std::pair<int, float>> overrides_;
	// set in the Inspector: "parameters/<name>" values (saved with the scene), a starting expression
	godot::Dictionary inspector_params_;
	std::vector<std::pair<int, float>> inspector_cache_;
	const ::UgoModel *inspector_for_ = nullptr;
	bool inspector_dirty_ = true;
	godot::String expression_;
	godot::String expression_shown_;
	bool preview_in_editor_ = true;
	// helpers: looking, blinking, the mouth
	UgoHelpers helpers_;
	UgoLayers anim_layers_; // layers 1, 2, ... above the main animation (index = layer - 1)
	std::shared_ptr<UgoLayerMask> make_mask(const godot::Dictionary &mask, bool &ok) const;
	godot::NodePath look_target_;
	bool look_at_point_ = false;
	godot::Vector2 look_point_, look_from_;
	godot::StringName lip_sync_bus_;
	float lip_sync_gain_ = 1.0f;
	UgoVoiceGate voice_gate_;
	void apply_helpers(float dt);
	// animation switching: the animation fading out, the queue, the end of a non-looping one
	int from_anim_ = -1;
	float from_time_ = 0, fade_t_ = 0, fade_total_ = 0;
	bool finished_ = false;
	std::vector<std::pair<godot::String, float>> queue_;
	// expressions (format 0.8): presets loaded with load_expressions (newest first), and the
	// expressions shown or fading, applied in the order they were shown
	struct ExprPreset {
		godot::String id;
		float fade_in = 0.5f, fade_out = 0.5f;
		std::vector<int32_t> index;
		std::vector<uint32_t> ops;
		std::vector<float> values;
	};
	struct ExprActive {
		godot::String name;
		float weight = 0, target = 0, fade = 0;
	};
	std::vector<ExprPreset> presets_;
	std::vector<ExprActive> expressions_;
	const ExprPreset *find_preset(const godot::String &name) const;
	void expression_fade(const godot::String &name, float &in, float &out) const;
	void apply_expressions(float dt);

	UgoBatch *batch_ = nullptr;
	std::unique_ptr<UgoDrawer> drawer_; // only when not under a batch
	bool connected_ = false;

	void rebuild_instance();
	void on_model_changed();
	void attach();
	void detach();
	void draw_alone();

protected:
	static void _bind_methods();
	void _notification(int what);
	bool _set(const godot::StringName &name, const godot::Variant &value);
	bool _get(const godot::StringName &name, godot::Variant &ret) const;
	void _get_property_list(godot::List<godot::PropertyInfo> *list) const;
	void _validate_property(godot::PropertyInfo &property) const;

public:
	UgoCharacter();
	~UgoCharacter() override;

	void set_model(const godot::Ref<UgoModel> &model);
	// An expression shown from the start (the model's, or a loaded preset's); "" for none.
	void set_expression(const godot::String &name);
	godot::String get_expression() const { return expression_; }
	// Play the animation in the editor (outside the running game).
	void set_preview_in_editor(bool on) { preview_in_editor_ = on; }

	// Helpers. Looking: face, eyes and a little of the body turn towards look_target (a Node2D)
	// or a point (look_at_point) until stop_looking; look_from is where the face is, in model
	// pixels from the model's origin ((0, 0): a quarter down the canvas).
	void set_look_target(const godot::NodePath &path) { look_target_ = path; }
	godot::NodePath get_look_target() const { return look_target_; }
	void look_at_point(const godot::Vector2 &global_point) { look_point_ = global_point; look_at_point_ = true; }
	void stop_looking() { look_at_point_ = false; look_target_ = godot::NodePath(); }
	void set_look_from(const godot::Vector2 &v) { look_from_ = v; }
	godot::Vector2 get_look_from() const { return look_from_; }
	void set_look_range(float v) { helpers_.look_range = v; }
	float get_look_range() const { return helpers_.look_range; }
	// Blinking on its own (EyeOpenL/EyeOpenR).
	void set_auto_blink(bool on) { helpers_.auto_blink = on; }
	bool is_auto_blink() const { return helpers_.auto_blink; }
	// The mouth (MouthOpen): set_mouth_level(0..1, negative: back to the animation), or the
	// loudness of an audio bus (lip_sync_bus, its peak times lip_sync_gain).
	void set_mouth_level(float level) { lip_sync_bus_ = godot::StringName(); helpers_.mouth_level = level; }
	void set_lip_sync_bus(const godot::StringName &bus) { lip_sync_bus_ = bus; }
	godot::StringName get_lip_sync_bus() const { return lip_sync_bus_; }
	void set_lip_sync_gain(float g) { lip_sync_gain_ = g; }
	float get_lip_sync_gain() const { return lip_sync_gain_; }
	// the noise gate (dB): quieter sounds leave the mouth shut; fully open range dB above it
	void set_lip_sync_gate_db(float v) { voice_gate_.gate_db = v; }
	float get_lip_sync_gate_db() const { return voice_gate_.gate_db; }
	void set_lip_sync_range_db(float v) { voice_gate_.range_db = v; }
	float get_lip_sync_range_db() const { return voice_gate_.range_db; }
	bool is_preview_in_editor() const { return preview_in_editor_; }
	godot::Ref<UgoModel> get_model() const { return model_; }
	void set_animation(const godot::String &name);
	godot::String get_animation() const { return animation_; }
	void set_playing(bool playing) { playing_ = playing; }
	bool is_playing() const { return playing_; }
	void set_speed(float speed) { speed_ = speed; }
	float get_speed() const { return speed_; }
	void set_time(float time) { time_ = time; }
	float get_time() const { return time_; }

	// manual: the clock and physics only move with advance() (lockstep games,
	// replays, tests); otherwise they follow the process delta.
	void set_manual(bool manual) { manual_ = manual; }
	bool is_manual() const { return manual_; }
	void advance(double delta);

	// fade > 0: the animation playing now keeps going and is blended out over that many
	// seconds while the new one is blended in.
	void play(const godot::String &name, float from_time, float fade);
	// Plays this when the current animation (not looping) ends, blending over fade seconds.
	void play_next(const godot::String &name, float fade);
	void stop();
	// The current animation does not loop and has reached its end ("animation_finished" was emitted).
	bool is_finished() const { return finished_; }
	// Layers above the main animation (1, 2, ...): play_layer mixes in over fade seconds; additive adds
	// the animation's change from the rest pose; mask { "bones": [...], "parts": [...], "params": [...] }
	// limits it to those (a kind left out: all of it; an empty list: none).
	bool play_layer(int layer, const godot::String &name, float fade, bool additive, const godot::Dictionary &mask, float weight);
	bool queue_layer(int layer, const godot::String &name, float fade, bool additive, const godot::Dictionary &mask, float weight);
	void stop_layer(int layer, float fade);
	void set_layer_weight(int layer, float weight);
	float get_layer_weight(int layer) const;
	godot::String get_layer_animation(int layer) const;
	// A value set here stays until cleared (applied after the animations).
	void set_param(const godot::String &name, float value);
	void clear_param(const godot::String &name);
	void clear_params();
	// Value after the last update (animation, set_param and physics).
	float get_param(const godot::String &name) const;
	// An extra animation blended over the main one at the next update only
	// (call it every frame): v = v + (anim - v) * weight.
	void add_blend(const godot::String &name, float time, float weight);

	// Expressions (format 0.8): the model's own, or ones from a preset (JSON, "ugo9-expressions").
	// show/hide fade the weight over the expression's own fade time (fade < 0) or the one given.
	godot::PackedStringArray get_expression_names() const;
	void show_expression(const godot::String &name, float fade);
	void hide_expression(const godot::String &name, float fade);
	void only_expressions(const godot::PackedStringArray &names);
	float get_expression_weight(const godot::String &name) const;
	// Returns the parameter names the preset uses that this model lacks.
	godot::PackedStringArray load_expressions(const godot::String &json);
	void reset_physics();
	// Runs the core now (normally done just before drawing), e.g. to read
	// get_param results in the same frame.
	void update_now() { evaluate(godot::Transform2D()); }

	// Runs the core for this frame: animation, parameters, physics, placement.
	void evaluate(const godot::Transform2D &placement);
	const float *frame() const;
	const ::UgoInstance *core_instance() const { return instance_; }
	bool can_draw() const { return instance_ != nullptr && is_visible_in_tree(); }
	// Picking by part name, as drawn in the last frame (draw order, masks; hidden parts and parts
	// at min_opacity or below are skipped): the part in front at a global point ("" for none),
	// and the box around a part ("" for the whole character) in the character's local coordinates.
	godot::String get_part_at(const godot::Vector2 &global_point, float min_opacity = 0.01f);
	bool hit_test(const godot::Vector2 &global_point, float min_opacity = 0.01f) { return !get_part_at(global_point, min_opacity).is_empty(); }
	godot::Rect2 get_part_rect(const godot::String &part = godot::String());
	// Hit areas: parts named "hit:<name>" or "当たり:<name>" (need not be drawn). "" for none.
	godot::String get_area_at(const godot::Vector2 &global_point);
	godot::PackedStringArray get_area_names();
	// Bones: where a bone is (global transform, as of the last frame), and reaching for a point this frame.
	godot::Transform2D get_bone_transform(const godot::String &bone);
	void reach_for(const godot::String &bone, const godot::Vector2 &global_point, int chain = 2);
	// Wind on the swaying chains (model pixels/s², y down, as the node's local space); gust 0: steady.
	void set_wind(const godot::Vector2 &w) { wind_ = w; }
	godot::Vector2 get_wind() const { return wind_; }
	void set_wind_gust(float g) { wind_gust_ = g; }
	float get_wind_gust() const { return wind_gust_; }
	// A box in the character's local space (model pixels) sure to hold every vertex this frame (culling).
	godot::Rect2 cull_rect() const;
	// The colour the shader multiplies in (what Godot cannot apply itself: the modulate of the
	// character and the nodes between it and its batch, or its self_modulate when drawn alone).
	godot::Color draw_tint = godot::Color(1, 1, 1, 1);
};

} // namespace ugo9
