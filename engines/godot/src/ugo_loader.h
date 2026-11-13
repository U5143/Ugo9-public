/* SPDX-FileCopyrightText: 2026 U5143
 * SPDX-License-Identifier: MIT */
// Lets load("res://character.ug9") return a UgoModel.
#pragma once

#include <godot_cpp/classes/resource_format_loader.hpp>

namespace ugo9 {

class UgoLoader : public godot::ResourceFormatLoader {
	GDCLASS(UgoLoader, godot::ResourceFormatLoader)

protected:
	static void _bind_methods() {}

public:
	godot::PackedStringArray _get_recognized_extensions() const override;
	bool _handles_type(const godot::StringName &type) const override;
	godot::String _get_resource_type(const godot::String &path) const override;
	godot::Variant _load(const godot::String &path, const godot::String &original_path, bool use_sub_threads, int32_t cache_mode) const override;
};

} // namespace ugo9
