/* SPDX-FileCopyrightText: 2026 U5143
 * SPDX-License-Identifier: MIT */
// UgoDrawer: draws many characters of one model with a few MultiMesh draws:
// one per run of parts that share a blend class (normal and add together,
// multiply, screen), plus one mask draw per 3 mask channels when the model
// has masks. The count does not grow with the number of characters.
// Instance placement is in the owner's local space and travels in the frame
// blocks.
#pragma once

#include <godot_cpp/classes/image.hpp>
#include <godot_cpp/classes/image_texture.hpp>
#include <godot_cpp/classes/node2d.hpp>
#include <godot_cpp/classes/shader_material.hpp>
#include <godot_cpp/classes/sub_viewport.hpp>
#include <godot_cpp/variant/rid.hpp>
#include <godot_cpp/variant/transform2d.hpp>

#include <vector>

#include "ugo_model.h"

namespace ugo9 {

class UgoCharacter;

class UgoDrawer {
	struct Pass {
		godot::RID item;
		godot::RID multimesh;
		godot::Ref<godot::ArrayMesh> mesh;
		godot::Ref<godot::ShaderMaterial> material;
		const char *variant = "";
		int allocated = 0; // instances the multimesh holds
	};
	// a draw order in use (format 0.8): its part list and the meshes of its runs
	struct Order {
		uint32_t key = 0;
		std::vector<uint32_t> list;
		std::vector<BlendClass> classes;
		std::vector<godot::Ref<godot::ArrayMesh>> meshes;
		uint64_t used = 0;
	};
	static constexpr int ORDER_SLOTS = 8; // as web/ugo.js

	godot::Ref<UgoModel> model_;
	godot::Node2D *owner_;
	godot::RID root_;
	godot::Transform2D item_xf_;
	std::vector<Pass> runs_;
	bool screen_approximate_ = false;
	// models with a draw order: the passes for groups of neighbours with the same order, made as needed
	std::vector<Order> orders_;
	uint64_t order_use_ = 0;
	std::vector<Pass> pool_;
	int pool_used_ = 0;
	// masks: every character's mask parts drawn into screen-sized images first
	// (3 channels each, in rgb), read by the masked parts of the runs
	std::vector<godot::SubViewport *> mask_viewports_;
	std::vector<Pass> mask_passes_;
	godot::Ref<godot::Image> frame_image_;
	godot::Ref<godot::ImageTexture> frame_tex_;
	godot::PackedByteArray staging_;
	int capacity_ = 0;
	int rows_ = 0;

	Pass make_pass(const godot::PackedInt32Array &indices, const char *variant, godot::RID parent);
	void set_pass_instances(Pass &pass, int n, bool grow);
	const char *variant_for(BlendClass cls) const;
	void bind_masks(Pass &pass);
	const Order &order_for(const ::UgoInstance *instance);
	void draw_ordered(const std::vector<UgoCharacter *> &characters, const godot::Rect2 &cover);

public:
	// screen_approximate: draw screen-blended parts without reading the screen
	// (faster, close but not exact).
	UgoDrawer(const godot::Ref<UgoModel> &model, godot::Node2D *owner, bool screen_approximate);
	~UgoDrawer();
	UgoDrawer(const UgoDrawer &) = delete;
	UgoDrawer &operator=(const UgoDrawer &) = delete;

	const godot::Ref<UgoModel> &model() const { return model_; }
	void set_draw_index(int index);
	static void write_tint(float *frame, const godot::Color &c);
	// Transform of the draws inside the owner's canvas item (identity by default).
	void set_item_transform(const godot::Transform2D &xf);
	// Draw calls per frame (does not depend on the number of characters).
	int draw_count() const { return (int)((model_->has_draw_order() ? pool_used_ : runs_.size()) + mask_passes_.size()); }
	// Uploads the frame blocks of these (already evaluated) characters and
	// draws them in this order.
	void draw(const std::vector<UgoCharacter *> &characters);
};

} // namespace ugo9
