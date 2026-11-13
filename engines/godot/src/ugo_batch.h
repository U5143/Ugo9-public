/* SPDX-FileCopyrightText: 2026 U5143
 * SPDX-License-Identifier: MIT */
// UgoBatch: draws every UgoCharacter below it with one draw per model.
// Characters are drawn by z_index (relative ones added up to the batch), then,
// with y_sort_enabled on the batch, lower ones in front, then in tree order.
// The modulate of a character (and of nodes between it and the batch) is
// applied by the shader; the batch's own modulate by Godot. Work happens once per frame, after all
// nodes have processed (RenderingServer.frame_pre_draw), so values set in
// _process show in the same frame.
#pragma once

#include <godot_cpp/classes/node2d.hpp>

#include <memory>
#include <vector>

#include "ugo_drawer.h"

namespace ugo9 {

class UgoCharacter;

class UgoBatch : public godot::Node2D {
	GDCLASS(UgoBatch, godot::Node2D)

	std::vector<UgoCharacter *> characters_;
	struct Sorted { int z; float y; UgoCharacter *c; };
	std::vector<Sorted> order_;
	std::vector<std::unique_ptr<UgoDrawer>> drawers_;
	bool dirty_ = true;
	bool connected_ = false;
	int last_draws_ = 0;
	bool screen_approximate_ = false;
	int last_drawn_ = 0;

	void pre_draw();

protected:
	static void _bind_methods();
	void _notification(int what);

public:
	~UgoBatch() override;
	void add_character(UgoCharacter *c);
	void remove_character(UgoCharacter *c);
	void mark_dirty() { dirty_ = true; }

	// Screen-blended parts without reading the screen: faster, close but not exact.
	void set_screen_approximate(bool on);
	bool is_screen_approximate() const { return screen_approximate_; }

	// Draw calls issued and characters drawn in the last frame.
	int get_draw_count() const { return last_draws_; }
	int get_character_count() const { return last_drawn_; }
};

} // namespace ugo9
