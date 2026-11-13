/* SPDX-FileCopyrightText: 2026 U5143
 * SPDX-License-Identifier: MIT */
#include "ugo_drawer.h"

#include <godot_cpp/classes/rendering_server.hpp>
#include <godot_cpp/classes/viewport.hpp>
#include <godot_cpp/classes/viewport_texture.hpp>
#include <godot_cpp/classes/world2d.hpp>

#include <algorithm>
#include <cmath>
#include <cstring>

#include "ugo_character.h"

using namespace godot;

namespace ugo9 {

UgoDrawer::Pass UgoDrawer::make_pass(const PackedInt32Array &indices, const char *variant, RID parent) {
	RenderingServer *rs = RenderingServer::get_singleton();
	const ::UgoModel *m = model_->core();
	Pass p;
	p.item = rs->canvas_item_create();
	rs->canvas_item_set_parent(p.item, parent);
	p.mesh = model_->gpu_mesh(indices);
	p.multimesh = rs->multimesh_create();
	rs->multimesh_set_mesh(p.multimesh, p.mesh->get_rid());
	p.material.instantiate();
	p.material->set_shader(UgoModel::shader(variant));
	p.material->set_shader_parameter("ugo_vertices", model_->gpu_vertices());
	p.material->set_shader_parameter("ugo_entries", model_->gpu_entries());
	p.material->set_shader_parameter("ugo_xweights", model_->gpu_xweights());
	p.material->set_shader_parameter("ugo_parts", model_->gpu_parts());
	p.material->set_shader_parameter("ugo_atlas", model_->gpu_atlas());
	p.material->set_shader_parameter("ugo_nearest", model_->is_pixel_art());
	p.material->set_shader_parameter("ugo_tex_scale", model_->gpu_tex_scale());
	p.material->set_shader_parameter("ugo_atlas_size", model_->gpu_atlas_size());
	p.material->set_shader_parameter("ugo_frame_w", FRAME_W);
	p.material->set_shader_parameter("ugo_vertex_w", VERTEX_W);
	p.material->set_shader_parameter("ugo_entry_w", ENTRY_W);
	p.material->set_shader_parameter("ugo_parts_w", PARTS_W);
	p.material->set_shader_parameter("ugo_stride", (int)ugo_frame_float_count(m) / 4);
	p.material->set_shader_parameter("ugo_skin_t", (int)ugo_frame_skin_offset(m) / 4);
	p.material->set_shader_parameter("ugo_op_f", (int)ugo_frame_opacity_offset(m));
	p.material->set_shader_parameter("ugo_morph_f", (int)ugo_frame_morph_offset(m));
	p.material->set_shader_parameter("ugo_color_f", (int)ugo_frame_color_offset(m));
	rs->canvas_item_set_material(p.item, p.material->get_rid());
	rs->canvas_item_add_multimesh(p.item, p.multimesh);
	return p;
}

UgoDrawer::UgoDrawer(const Ref<UgoModel> &model, Node2D *owner, bool screen_approximate) : model_(model), owner_(owner) {
	RenderingServer *rs = RenderingServer::get_singleton();
	root_ = rs->canvas_item_create();
	rs->canvas_item_set_parent(root_, owner_->get_canvas_item());

	const int groups = (model_->mask_channel_count() + 2) / 3; // 3 channels per image (rgb)
	for (int g = 0; g < groups; g++) {
		SubViewport *vp = memnew(SubViewport);
		Ref<World2D> world;
		world.instantiate();
		vp->set_world_2d(world); // its own canvas: only the mask draw is in it
		vp->set_transparent_background(true);
		vp->set_disable_3d(true);
		vp->set_update_mode(SubViewport::UPDATE_ALWAYS);
		vp->set_clear_mode(SubViewport::CLEAR_MODE_ALWAYS);
		owner_->add_child(vp, false, Node::INTERNAL_MODE_BACK);
		Pass p = make_pass(model_->gpu_mask_indices(), "UGO_MASK", world->get_canvas());
		p.material->set_shader_parameter("ugo_mask_group", g);
		mask_viewports_.push_back(vp);
		mask_passes_.push_back(p);
	}
	screen_approximate_ = screen_approximate;
	if (model_->has_draw_order()) return; // drawn with passes made per group of characters (draw_ordered)
	const std::vector<Run> &runs = model_->gpu_runs();
	for (size_t i = 0; i < runs.size(); i++) {
		Pass p = make_pass(runs[i].indices, variant_for(runs[i].cls), root_);
		rs->canvas_item_set_draw_index(p.item, (int)i);
		bind_masks(p);
		runs_.push_back(p);
	}
}

const char *UgoDrawer::variant_for(BlendClass cls) const {
	return cls == BLEND_CLASS_MULTIPLY ? "UGO_MULTIPLY"
			: cls == BLEND_CLASS_SCREEN ? (screen_approximate_ ? "UGO_SCREEN_APPROX" : "UGO_SCREEN")
										: "";
}

void UgoDrawer::bind_masks(Pass &p) {
	static const char *const names[6] = { "ugo_mask0", "ugo_mask1", "ugo_mask2", "ugo_mask3", "ugo_mask4", "ugo_mask5" };
	for (size_t g = 0; g < mask_viewports_.size() && g < 6; g++) {
		p.material->set_shader_parameter(names[g], mask_viewports_[g]->get_texture());
	}
}

// the runs of this character's draw order: made once per order and kept (ORDER_SLOTS of them)
const UgoDrawer::Order &UgoDrawer::order_for(const ::UgoInstance *instance) {
	const uint32_t key = ugo_draw_order_key(instance);
	const uint32_t np = (uint32_t)model_->get_part_count();
	const uint32_t *list = ugo_draw_order(instance);
	const uint64_t use = ++order_use_;
	for (Order &o : orders_) {
		if (o.key == key && std::equal(o.list.begin(), o.list.end(), list, list + np)) {
			o.used = use;
			return o;
		}
	}
	size_t slot = orders_.size();
	if (slot >= (size_t)ORDER_SLOTS) { // the order used longest ago makes room
		slot = 0;
		for (size_t i = 1; i < orders_.size(); i++) if (orders_[i].used < orders_[slot].used) slot = i;
	} else {
		orders_.emplace_back();
	}
	Order &o = orders_[slot];
	o.key = key;
	o.list.assign(list, list + np);
	o.used = use;
	o.classes.clear();
	o.meshes.clear();
	for (const Run &r : model_->gpu_runs_for(list)) {
		o.classes.push_back(r.cls);
		o.meshes.push_back(model_->gpu_mesh(r.indices));
	}
	return o;
}

// Characters next to each other with the same draw order are drawn together: one pass per run of
// their order, reading their frame blocks from ugo_instance_base on (format 0.8).
void UgoDrawer::draw_ordered(const std::vector<UgoCharacter *> &characters, const Rect2 &cover) {
	RenderingServer *rs = RenderingServer::get_singleton();
	const int n = (int)characters.size();
	int used = 0;
	for (int i = 0; i < n;) {
		const ::UgoInstance *a = characters[i]->core_instance();
		const uint32_t key = ugo_draw_order_key(a), np = (uint32_t)model_->get_part_count();
		const uint32_t *list = ugo_draw_order(a);
		int j = i + 1;
		while (j < n) {
			const ::UgoInstance *b = characters[j]->core_instance();
			if (ugo_draw_order_key(b) != key || !std::equal(list, list + np, ugo_draw_order(b))) break;
			j++;
		}
		const Order *o = &order_for(a);
		for (size_t r = 0; r < o->meshes.size(); r++) {
			if (used == (int)pool_.size()) {
				Pass p = make_pass(PackedInt32Array(), "", root_);
				bind_masks(p);
				if (frame_tex_.is_valid()) p.material->set_shader_parameter("ugo_frame", frame_tex_);
				pool_.push_back(p);
			}
			Pass &p = pool_[used];
			const char *variant = variant_for(o->classes[r]);
			if (strcmp(p.variant, variant) != 0) {
				p.material->set_shader(UgoModel::shader(variant));
				p.variant = variant;
			}
			if (p.mesh != o->meshes[r]) {
				p.mesh = o->meshes[r];
				rs->multimesh_set_mesh(p.multimesh, p.mesh->get_rid());
			}
			if (p.allocated < capacity_) {
				p.allocated = capacity_;
				set_pass_instances(p, j - i, true);
			} else {
				rs->multimesh_set_visible_instances(p.multimesh, j - i);
			}
			p.material->set_shader_parameter("ugo_instance_base", i);
			rs->canvas_item_set_draw_index(p.item, used);
			rs->canvas_item_set_custom_rect(p.item, true, cover);
			used++;
		}
		i = j;
	}
	for (int k = used; k < (int)pool_.size(); k++) rs->multimesh_set_visible_instances(pool_[k].multimesh, 0);
	pool_used_ = used;
}

UgoDrawer::~UgoDrawer() {
	RenderingServer *rs = RenderingServer::get_singleton();
	if (!rs) return;
	for (std::vector<Pass> *list : { &runs_, &mask_passes_, &pool_ }) {
		for (Pass &p : *list) {
			rs->free_rid(p.item);
			rs->free_rid(p.multimesh);
		}
	}
	rs->free_rid(root_);
	for (SubViewport *vp : mask_viewports_) vp->queue_free();
}

// The whole character's colour into the frame header's floats 6, 7, which the core leaves at 0
// (= white, opaque): how much darker each channel is, 8 bits each, and 1 - alpha.
void UgoDrawer::write_tint(float *frame, const Color &c) {
	auto dark = [](float v) { return (int)std::lround((1.0f - std::clamp(v, 0.0f, 1.0f)) * 255.0f); };
	frame[6] = (float)(dark(c.r) * 65536 + dark(c.g) * 256 + dark(c.b));
	frame[7] = 1.0f - std::clamp(c.a, 0.0f, 1.0f);
}

void UgoDrawer::set_draw_index(int index) { RenderingServer::get_singleton()->canvas_item_set_draw_index(root_, index); }

void UgoDrawer::set_item_transform(const Transform2D &xf) {
	item_xf_ = xf;
	RenderingServer::get_singleton()->canvas_item_set_transform(root_, xf);
}

void UgoDrawer::set_pass_instances(Pass &pass, int n, bool grow) {
	RenderingServer *rs = RenderingServer::get_singleton();
	if (grow) {
		rs->multimesh_allocate_data(pass.multimesh, capacity_, RenderingServer::MULTIMESH_TRANSFORM_2D);
		// instance transforms stay identity: placement is in the frame block
		PackedFloat32Array identity;
		identity.resize(8 * (int64_t)capacity_);
		float *p = identity.ptrw();
		for (int i = 0; i < capacity_; i++) {
			const float t[8] = { 1, 0, 0, 0, 0, 1, 0, 0 };
			memcpy(p + 8 * i, t, sizeof t);
		}
		rs->multimesh_set_buffer(pass.multimesh, identity);
	}
	rs->multimesh_set_visible_instances(pass.multimesh, n);
}

void UgoDrawer::draw(const std::vector<UgoCharacter *> &characters) {
	RenderingServer *rs = RenderingServer::get_singleton();
	const ::UgoModel *m = model_->core();
	const int n = (int)characters.size();
	const uint32_t ff = ugo_frame_float_count(m);

	const bool grow_instances = n > capacity_;
	if (grow_instances) capacity_ = std::max(n, capacity_ * 2);
	for (Pass &p : runs_) set_pass_instances(p, n, grow_instances);
	for (Pass &p : mask_passes_) set_pass_instances(p, n, grow_instances);
	if (n == 0) {
		for (Pass &p : pool_) rs->multimesh_set_visible_instances(p.multimesh, 0);
		pool_used_ = 0;
		return;
	}

	const int rows = std::max(1, (int)((n * (int64_t)ff / 4 + FRAME_W - 1) / FRAME_W));
	const bool grow = rows > rows_;
	if (grow) {
		rows_ = std::max(rows, rows_ * 2);
		staging_.resize((int64_t)FRAME_W * rows_ * 16);
		memset(staging_.ptrw(), 0, staging_.size());
	}
	float *dst = reinterpret_cast<float *>(staging_.ptrw());
	Rect2 cover;
	for (int i = 0; i < n; i++) {
		const float *f = characters[i]->frame();
		memcpy(dst + (size_t)i * ff, f, ff * sizeof(float));
		write_tint(dst + (size_t)i * ff, characters[i]->draw_tint);
		const Transform2D xf(Vector2(f[0], f[1]), Vector2(f[2], f[3]), Vector2(f[4], f[5]));
		const Rect2 r = xf.xform(characters[i]->cull_rect()); // the core's box for this frame (cheap, never too small)
		cover = i == 0 ? r : cover.merge(r);
	}
	if (frame_image_.is_null()) frame_image_.instantiate();
	frame_image_->set_data(FRAME_W, rows_, false, Image::FORMAT_RGBAF, staging_);
	if (frame_tex_.is_null()) {
		frame_tex_ = ImageTexture::create_from_image(frame_image_);
		for (std::vector<Pass> *list : { &runs_, &mask_passes_, &pool_ }) {
			for (Pass &p : *list) p.material->set_shader_parameter("ugo_frame", frame_tex_);
		}
	} else if (grow) {
		frame_tex_->set_image(frame_image_);
	} else {
		frame_tex_->update(frame_image_);
	}
	// vertices move in the shader, so tell the culling where they can be
	for (Pass &p : runs_) rs->canvas_item_set_custom_rect(p.item, true, cover);
	if (model_->has_draw_order()) draw_ordered(characters, cover);

	// the mask images cover the screen: draw there with the owner's on-screen transform
	if (!mask_passes_.empty()) {
		const Vector2i size = Vector2i(owner_->get_viewport()->get_visible_rect().size);
		const Transform2D to_screen = owner_->get_global_transform_with_canvas() * item_xf_;
		for (size_t g = 0; g < mask_passes_.size(); g++) {
			if (mask_viewports_[g]->get_size() != size) mask_viewports_[g]->set_size(size);
			rs->canvas_item_set_transform(mask_passes_[g].item, to_screen);
			rs->canvas_item_set_custom_rect(mask_passes_[g].item, true, cover);
		}
	}
}

} // namespace ugo9
