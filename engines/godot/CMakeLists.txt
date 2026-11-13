# SPDX-FileCopyrightText: 2026 U5143
# SPDX-License-Identifier: MIT
# Ugo9 GDExtension for Godot 4.4+.
#
#   cmake -S engines/godot -B build/godot -DCMAKE_BUILD_TYPE=Release
#   cmake --build build/godot --config Release
#
# The library lands in engines/godot/project/addons/ugo9/bin/. The C core is
# compiled into it (no separate shared library to ship).
#
# Phones and the Web (what Godot's export templates load; names as in ugo9.gdextension):
#   Android: cmake -S engines/godot -B build/godot-android -DCMAKE_BUILD_TYPE=Release
#              -DCMAKE_TOOLCHAIN_FILE=$ANDROID_NDK_HOME/build/cmake/android.toolchain.cmake
#              -DANDROID_ABI=arm64-v8a -DANDROID_PLATFORM=android-24
#   Web:     emcmake cmake -S engines/godot -B build/godot-web -DCMAKE_BUILD_TYPE=Release
#              [-DGODOTCPP_THREADS=OFF for an export without thread support]
#   then cmake --build <dir> --config Release
cmake_minimum_required(VERSION 3.17)
set(CMAKE_PROJECT_ugo9_godot_INCLUDE ${CMAKE_CURRENT_LIST_DIR}/cmake/emscripten_shared.cmake)
project(ugo9_godot C CXX)

set(UGO_GODOT_CPP_TAG "godot-4.4-stable" CACHE STRING "godot-cpp tag (sets the oldest Godot that loads the extension)")
set(UGO_GODOT_TARGET "template_release" CACHE STRING "godot-cpp target: template_debug, template_release or editor")

include(FetchContent)
FetchContent_Declare(godot-cpp
  GIT_REPOSITORY https://github.com/godotengine/godot-cpp.git
  GIT_TAG ${UGO_GODOT_CPP_TAG}
  GIT_SHALLOW TRUE)
FetchContent_MakeAvailable(godot-cpp)

set(UGO_ROOT ${CMAKE_CURRENT_SOURCE_DIR}/../..)

# The core stays plain C99 with its own flags.
add_library(ugo_core_godot STATIC ${UGO_ROOT}/core/src/ugo.c)
target_include_directories(ugo_core_godot PUBLIC ${UGO_ROOT}/core/include)
set_target_properties(ugo_core_godot PROPERTIES C_STANDARD 99 POSITION_INDEPENDENT_CODE ON C_VISIBILITY_PRESET hidden)

# The shader is kept as a .gdshader file and embedded at build time.
file(READ ${CMAKE_CURRENT_SOURCE_DIR}/shaders/ugo9.gdshader UGO_SHADER_CODE)
configure_file(${CMAKE_CURRENT_SOURCE_DIR}/src/ugo_shader.h.in ${CMAKE_CURRENT_BINARY_DIR}/gen/ugo_shader.h @ONLY)
set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS ${CMAKE_CURRENT_SOURCE_DIR}/shaders/ugo9.gdshader)

add_library(ugo9_godot SHARED
  src/register_types.cpp
  src/ugo_model.cpp
  src/ugo_drawer.cpp
  src/ugo_character.cpp
  src/ugo_batch.cpp
  src/ugo_loader.cpp)
target_include_directories(ugo9_godot PRIVATE src ${CMAKE_CURRENT_BINARY_DIR}/gen)
target_link_libraries(ugo9_godot PRIVATE ugo_core_godot godot-cpp::${UGO_GODOT_TARGET})
# MSVC: read the sources as UTF-8 (comments hold Japanese; a Japanese Windows otherwise warns C4819)
if(MSVC)
  target_compile_options(ugo_core_godot PRIVATE /utf-8)
  target_compile_options(ugo9_godot PRIVATE /utf-8)
endif()

get_target_property(UGO_GODOT_SUFFIX godot-cpp::${UGO_GODOT_TARGET} GODOTCPP_SUFFIX)
set(UGO_BIN_DIR ${CMAKE_CURRENT_SOURCE_DIR}/project/addons/ugo9/bin)
set_target_properties(ugo9_godot PROPERTIES
  CXX_STANDARD 17
  CXX_EXTENSIONS OFF
  CXX_VISIBILITY_PRESET hidden
  POSITION_INDEPENDENT_CODE ON
  PREFIX "lib"
  OUTPUT_NAME "ugo9${UGO_GODOT_SUFFIX}"
  LIBRARY_OUTPUT_DIRECTORY "$<1:${UGO_BIN_DIR}>"
  RUNTIME_OUTPUT_DIRECTORY "$<1:${UGO_BIN_DIR}>"
  PDB_OUTPUT_DIRECTORY "$<1:${UGO_BIN_DIR}>")
if(CMAKE_SYSTEM_NAME STREQUAL Darwin)
  set_target_properties(ugo9_godot PROPERTIES SUFFIX ".dylib")
endif()
message(STATUS "Ugo9 GDExtension: ${UGO_BIN_DIR}/libugo9${UGO_GODOT_SUFFIX}")

# The demo project uses samples/basic; copy it in (not kept in git, so it
# always matches the current format).
add_custom_command(TARGET ugo9_godot POST_BUILD
  COMMAND ${CMAKE_COMMAND} -E make_directory ${CMAKE_CURRENT_SOURCE_DIR}/project/samples/basic
  COMMAND ${CMAKE_COMMAND} -E copy_if_different ${UGO_ROOT}/samples/basic/model.ug9 ${CMAKE_CURRENT_SOURCE_DIR}/project/samples/basic/model.ug9
  COMMAND ${CMAKE_COMMAND} -E copy_if_different ${UGO_ROOT}/samples/basic/atlas.png ${CMAKE_CURRENT_SOURCE_DIR}/project/samples/basic/)
