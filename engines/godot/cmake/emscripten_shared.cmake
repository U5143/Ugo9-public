# SPDX-FileCopyrightText: 2026 U5143
# SPDX-License-Identifier: MIT
# The Web (Emscripten): CMake does not make shared libraries there, but Godot loads a
# GDExtension as a WebAssembly side module. Loaded before project() (the same trick as
# godot-cpp's cmake/emsdkHack.cmake), so add_library(SHARED) gives a .wasm side module.
if(EMSCRIPTEN)
  set_property(GLOBAL PROPERTY TARGET_SUPPORTS_SHARED_LIBS TRUE)
  set(CMAKE_SHARED_LIBRARY_CREATE_C_FLAGS "-sSIDE_MODULE=1")
  set(CMAKE_SHARED_LIBRARY_CREATE_CXX_FLAGS "-sSIDE_MODULE=1")
  set(CMAKE_SHARED_LIBRARY_SUFFIX ".wasm")
  set(CMAKE_STRIP FALSE)
  set(CMAKE_SYSTEM_PROCESSOR "wasm32")
endif()
