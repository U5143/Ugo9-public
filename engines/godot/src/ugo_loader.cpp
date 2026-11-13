/* SPDX-FileCopyrightText: 2026 U5143
 * SPDX-License-Identifier: MIT */
#include "ugo_loader.h"

#include "ugo_model.h"

using namespace godot;

namespace ugo9 {

PackedStringArray UgoLoader::_get_recognized_extensions() const {
	PackedStringArray out;
	out.push_back("ug9");
	out.push_back("ugo"); // the earlier name, read for now
	return out;
}

bool UgoLoader::_handles_type(const StringName &type) const { return type == StringName("UgoModel") || type == StringName("Resource"); }

String UgoLoader::_get_resource_type(const String &path) const {
	const String e = path.get_extension().to_lower();
	return e == "ug9" || e == "ugo" ? "UgoModel" : "";
}

Variant UgoLoader::_load(const String &path, const String &original_path, bool use_sub_threads, int32_t cache_mode) const {
	Ref<UgoModel> model;
	model.instantiate();
	const Error err = model->load_file(path);
	if (err != OK) return err;
	return model;
}

} // namespace ugo9
