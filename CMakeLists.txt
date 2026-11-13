# SPDX-FileCopyrightText: 2026 U5143
# SPDX-License-Identifier: MIT
cmake_minimum_required(VERSION 3.16)
project(ugo9 C)

set(CMAKE_C_STANDARD 99)
set(CMAKE_C_STANDARD_REQUIRED ON)

# MSVC: read the sources as UTF-8 (comments hold Japanese; without this a
# Japanese Windows reads them as CP932 and warns C4819)
if(MSVC)
  add_compile_options(/utf-8)
endif()
# warnings for the core: MSVC /W4, GCC/Clang the same set CI checks with -Werror
# (UGO_STRICT=ON turns them into errors)
option(UGO_STRICT "Treat warnings in the core as errors" OFF)
function(ugo_warnings target)
  if(MSVC)
    target_compile_options(${target} PRIVATE /W4)
    if(UGO_STRICT)
      target_compile_options(${target} PRIVATE /WX)
    endif()
  else()
    target_compile_options(${target} PRIVATE -Wall -Wextra -Wpedantic -Wconversion -Wshadow -Wstrict-prototypes -Wmissing-prototypes)
    if(UGO_STRICT)
      target_compile_options(${target} PRIVATE -Werror)
    endif()
  endif()
endfunction()

# Runtime core: no allocation, no I/O, no libc. Link it into an engine plugin,
# a native app, or build it as a shared library for C#/GDScript bindings.
add_library(ugo STATIC core/src/ugo.c core/src/ugo_raster.c)
target_include_directories(ugo PUBLIC core/include)
ugo_warnings(ugo)
# SIMD in the hot loops (core/src/ugo_simd.h: SSE2 on x86-64, NEON on ARM64, picked by the compiler's target;
# the same results bit for bit). OFF: plain C everywhere (UGO_NO_SIMD).
option(UGO_SIMD "Use SSE2 / NEON in the core where the target has them" ON)
function(ugo_simd target)
  if(NOT UGO_SIMD)
    target_compile_definitions(${target} PRIVATE UGO_NO_SIMD)
  endif()
endfunction()
ugo_simd(ugo)

option(UGO_SHARED "Also build ugo as a shared library (for Unity/Godot bindings)" OFF)
if(UGO_SHARED)
  add_library(ugo_shared SHARED core/src/ugo.c core/src/ugo_raster.c)
  target_include_directories(ugo_shared PUBLIC core/include)
  target_compile_definitions(ugo_shared PRIVATE UGO_BUILD_DLL)
  # ugo.dll / libugo.so / libugo.dylib (no "lib" on Windows, also with MinGW, so bindings load "ugo")
  set_target_properties(ugo_shared PROPERTIES OUTPUT_NAME ugo C_VISIBILITY_PRESET hidden)
  if(WIN32)
    set_target_properties(ugo_shared PROPERTIES PREFIX "")
  endif()
  ugo_warnings(ugo_shared)
  ugo_simd(ugo_shared)
endif()

# Exporter: GIF / APNG / PNG frames / sprite sheet / raw, MP4 and WebM via ffmpeg.
add_executable(ugo_export cli/ugo_export.c cli/encoders.c cli/preset.c)
target_include_directories(ugo_export PRIVATE third_party)
target_link_libraries(ugo_export PRIVATE ugo)
if(WIN32)
  target_link_libraries(ugo_export PRIVATE shell32)
  target_compile_definitions(ugo_export PRIVATE _CRT_SECURE_NO_WARNINGS)
else()
  target_link_libraries(ugo_export PRIVATE m)
endif()
# drawing threads (--threads): pthreads where there is no Windows
find_package(Threads REQUIRED)
target_link_libraries(ugo_export PRIVATE Threads::Threads)

# The C example: load -> play -> draw on the processor -> PNG (examples/c/play_png.c)
add_executable(ugo_play_png examples/c/play_png.c)
target_include_directories(ugo_play_png PRIVATE third_party)
target_link_libraries(ugo_play_png PRIVATE ugo)
if(WIN32)
  target_compile_definitions(ugo_play_png PRIVATE _CRT_SECURE_NO_WARNINGS)
else()
  target_link_libraries(ugo_play_png PRIVATE m)
endif()

# Tests and benchmark
enable_testing()
add_executable(ugo_test tests/test_core.c)
target_link_libraries(ugo_test PRIVATE ugo)
if(NOT WIN32)
  target_link_libraries(ugo_test PRIVATE m)
endif()
add_test(NAME core COMMAND ugo_test ${CMAKE_CURRENT_SOURCE_DIR}/samples/basic/model.ug9 --fuzz ${CMAKE_CURRENT_SOURCE_DIR}/tests/pose/rig.ug9 --fuzz ${CMAKE_CURRENT_SOURCE_DIR}/tests/warp/model.ug9 --fuzz ${CMAKE_CURRENT_SOURCE_DIR}/tests/order/model.ug9 --fuzz ${CMAKE_CURRENT_SOURCE_DIR}/tests/future/model.ug9 --fuzz ${CMAKE_CURRENT_SOURCE_DIR}/tests/v11/model.ug9 --fuzz ${CMAKE_CURRENT_SOURCE_DIR}/tests/runs/model.ug9)
