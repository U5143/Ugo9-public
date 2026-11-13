# SPDX-FileCopyrightText: 2026 U5143
# SPDX-License-Identifier: MIT
# The GameMaker extension's native library: ugo9_gm.dll (Windows), libugo9_gm.so (Linux), libugo9_gm.dylib (macOS),
# with the Ugo9 core compiled in.
#   cmake -S engines/gamemaker/extension -B build/gamemaker/lib -DCMAKE_BUILD_TYPE=Release
#   cmake --build build/gamemaker/lib --config Release
cmake_minimum_required(VERSION 3.16)
project(ugo9_gm C)
set(CORE ${CMAKE_CURRENT_SOURCE_DIR}/../../../core)
add_library(ugo9_gm SHARED ugo9_gm.c ${CORE}/src/ugo.c)
target_include_directories(ugo9_gm PRIVATE ${CORE}/include)
set_target_properties(ugo9_gm PROPERTIES C_STANDARD 99 C_VISIBILITY_PRESET hidden)
if(MSVC)
  set_target_properties(ugo9_gm PROPERTIES MSVC_RUNTIME_LIBRARY "MultiThreaded") # no extra runtime to ship
else()
  target_link_libraries(ugo9_gm PRIVATE m)
endif()
