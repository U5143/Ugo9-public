/* SPDX-FileCopyrightText: 2026 U5143
 * SPDX-License-Identifier: MIT */
#include "ugo_batch.h"

#include <godot_cpp/classes/rendering_server.hpp>
#include <godot_cpp/core/class_db.hpp>

#include <algorithm>

#include "ugo_character.h"

using namespace godot;

namespace ugo9 {

// Characters leave the batch on their own exit, which comes before the batch's.
UgoBatch::~UgoBatch() {}

void UgoBatch::add_character(UgoCharacter *c) {
	characters_.push_back(c);
	dirty_ = true;
}

void UgoBatch::remove_character(UgoCharacter *c) {
	characters_.erase(std::remove(characters_.begin(), characters_.end(), c), characters_.end());
	dirty_ = true;
}

void UgoBatch::pre_draw() {
	if (dirty_) {
		std::stable_sort(characters_.begin(), characters_.end(), [](UgoCharacter *a, UgoCharacter *b) { return b->is_greater_than(a); });
		dirty_ = false;
	}
	// drawing order: z_index (relative ones added up to the batch), then with y_sort_enabled
	// lower ones in front, then the tree order; colour: the modulate Godot cannot apply itself
	order_.clear();
	bool sort = is_y_sort_enabled();
	for (size_t i = 0; i < characters_.size(); i++) {
		UgoCharacter *c = characters_[i];
		if (!c->can_draw()) continue;
		int z = 0;
		Color tint = c->get_self_modulate();
		for (Node *n = c; n && n != this; n = n->get_parent()) {
			CanvasItem *ci = Object::cast_to<CanvasItem>(n);
			if (!ci) continue;
			tint *= ci->get_modulate();
			Node2D *n2 = Object::cast_to<Node2D>(n);
			if (n2) {
				z += n2->get_z_index();
				if (!n2->is_z_relative()) break;
			}
		}
		c->draw_tint = tint;
		if (z != 0) sort = true;
		order_.push_back({ z, is_y_sort_enabled() ? c->get_global_position().y : 0.0f, c });
	}
	if (sort) std::stable_sort(order_.begin(), order_.end(), [](const Sorted &a, const Sorted &b) { return a.z != b.z ? a.z < b.z : a.y < b.y; });
	// one list per model, in the order the models first appear
	std::vector<std::vector<UgoCharacter *>> lists(drawers_.size());
	const Transform2D to_local = get_global_transform().affine_inverse();
	int drawn = 0;
	for (const Sorted &s : order_) {
		UgoCharacter *c = s.c;
		const Ref<UgoModel> &m = c->get_model();
		size_t d = 0;
		while (d < drawers_.size() && drawers_[d]->model() != m) d++;
		if (d == drawers_.size()) {
			drawers_.push_back(std::make_unique<UgoDrawer>(m, this, screen_approximate_));
			lists.emplace_back();
		}
		c->evaluate(to_local * c->get_global_transform());
		lists[d].push_back(c);
		drawn++;
	}
	int draws = 0;
	for (size_t d = 0; d < drawers_.size();) {
		if (lists[d].empty()) { // model no longer used here
			drawers_.erase(drawers_.begin() + d);
			lists.erase(lists.begin() + d);
			continue;
		}
		drawers_[d]->set_draw_index((int)d);
		drawers_[d]->draw(lists[d]);
		draws += drawers_[d]->draw_count();
		d++;
	}
	last_draws_ = draws;
	last_drawn_ = drawn;
}

void UgoBatch::set_screen_approximate(bool on) {
	if (screen_approximate_ == on) return;
	screen_approximate_ = on;
	drawers_.clear(); // rebuilt with the other shader on the next frame
}

void UgoBatch::_notification(int what) {
	switch (what) {
		case NOTIFICATION_ENTER_TREE:
			RenderingServer::get_singleton()->connect("frame_pre_draw", callable_mp(this, &UgoBatch::pre_draw));
			connected_ = true;
			break;
		case NOTIFICATION_EXIT_TREE:
			if (connected_) {
				RenderingServer::get_singleton()->disconnect("frame_pre_draw", callable_mp(this, &UgoBatch::pre_draw));
				connected_ = false;
			}
			drawers_.clear();
			break;
		case NOTIFICATION_CHILD_ORDER_CHANGED:
			dirty_ = true;
			break;
	}
}

void UgoBatch::_bind_methods() {
	ClassDB::bind_method(D_METHOD("set_screen_approximate", "on"), &UgoBatch::set_screen_approximate);
	ClassDB::bind_method(D_METHOD("is_screen_approximate"), &UgoBatch::is_screen_approximate);
	ADD_PROPERTY(PropertyInfo(Variant::BOOL, "screen_approximate"), "set_screen_approximate", "is_screen_approximate");
	ClassDB::bind_method(D_METHOD("get_draw_count"), &UgoBatch::get_draw_count);
	ClassDB::bind_method(D_METHOD("get_character_count"), &UgoBatch::get_character_count);
}

} // namespace ugo9
