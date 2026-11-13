/* SPDX-FileCopyrightText: 2026 U5143
 * SPDX-License-Identifier: MIT */
#include <gdextension_interface.h>

#include <godot_cpp/classes/resource_loader.hpp>
#include <godot_cpp/core/class_db.hpp>
#include <godot_cpp/core/defs.hpp>
#include <godot_cpp/godot.hpp>

#include "ugo_batch.h"
#include "ugo_character.h"
#include "ugo_loader.h"
#include "ugo_model.h"

using namespace godot;

static Ref<ugo9::UgoLoader> s_loader;

static void initialize_ugo9(ModuleInitializationLevel level) {
	if (level != MODULE_INITIALIZATION_LEVEL_SCENE) return;
	GDREGISTER_CLASS(ugo9::UgoModel);
	GDREGISTER_CLASS(ugo9::UgoCharacter);
	GDREGISTER_CLASS(ugo9::UgoBatch);
	GDREGISTER_CLASS(ugo9::UgoLoader);
	s_loader.instantiate();
	ResourceLoader::get_singleton()->add_resource_format_loader(s_loader);
}

static void uninitialize_ugo9(ModuleInitializationLevel level) {
	if (level != MODULE_INITIALIZATION_LEVEL_SCENE) return;
	ResourceLoader::get_singleton()->remove_resource_format_loader(s_loader);
	s_loader.unref();
	ugo9::UgoModel::free_shared();
}

extern "C" {
GDExtensionBool GDE_EXPORT ugo9_library_init(GDExtensionInterfaceGetProcAddress get_proc_address, GDExtensionClassLibraryPtr library, GDExtensionInitialization *initialization) {
	GDExtensionBinding::InitObject init(get_proc_address, library, initialization);
	init.register_initializer(initialize_ugo9);
	init.register_terminator(uninitialize_ugo9);
	init.set_minimum_library_initialization_level(MODULE_INITIALIZATION_LEVEL_SCENE);
	return init.init();
}
}
