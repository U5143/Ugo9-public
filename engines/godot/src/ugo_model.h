/* SPDX-FileCopyrightText: 2026 U5143
 * SPDX-License-Identifier: MIT */
// UgoModel: a loaded .ug9 file (shared by every character that uses it) and
// the GPU data built from it once: the mesh, the vertex table, the morph
// entries and the premultiplied atlas.
#pragma once

#include <godot_cpp/classes/array_mesh.hpp>
#include <godot_cpp/classes/image_texture.hpp>
#include <godot_cpp/classes/resource.hpp>
#include <godot_cpp/classes/shader.hpp>
#include <godot_cpp/classes/texture2d.hpp>
#include <godot_cpp/classes/texture2d_array.hpp>
#include <godot_cpp/variant/packed_int32_array.hpp>
#include <godot_cpp/variant/packed_vector2_array.hpp>
#include <godot_cpp/variant/packed_byte_array.hpp>
#include <godot_cpp/variant/packed_string_array.hpp>
#include <godot_cpp/variant/rect2.hpp>

#include <vector>

#include "ugo.h"

namespace ugo9 {

// 16-byte aligned storage for the core (it never allocates).
struct alignas(16) Block {
	unsigned char bytes[16];
};
inline std::vector<Block> blocks(uint32_t size) { return std::vector<Block>((size + 15) / 16); }

constexpr int FRAME_W = 1024;  // texels per row of the frame texture
constexpr int VERTEX_W = 1024; // 4 texels per vertex
constexpr int ENTRY_W = 2048;
constexpr int PARTS_W = 1024;  // 2 texels per part
constexpr int MAX_TEXTURES = 64;

// Blend modes that need a draw of their own (normal and add share one).
enum BlendClass { BLEND_CLASS_NORMAL = 0, BLEND_CLASS_MULTIPLY = 1, BLEND_CLASS_SCREEN = 2 };

// A run of drawn parts that share a blend class, in draw order.
struct Run {
	BlendClass cls;
	godot::PackedInt32Array indices;
};

class UgoModel : public godot::Resource {
	GDCLASS(UgoModel, godot::Resource)

	std::vector<Block> data_;
	std::vector<Block> mem_;
	::UgoModel *model_ = nullptr;
	godot::String base_dir_;
	std::vector<godot::Ref<godot::Texture2D>> textures_; // one per texture of the model (may be null)

	// GPU data, built on first use
	bool gpu_built_ = false;
	bool pixel_art_ = false;
	godot::PackedVector2Array vertices_, uvs_;
	std::vector<Run> runs_;
	godot::PackedInt32Array mask_indices_;
	godot::Ref<godot::ImageTexture> vertex_tex_;
	godot::Ref<godot::ImageTexture> entry_tex_;
	godot::Ref<godot::ImageTexture> xweight_tex_;
	godot::Ref<godot::ImageTexture> part_tex_;
	godot::Ref<godot::Texture2DArray> atlas_tex_;
	godot::PackedVector2Array tex_scale_;
	godot::Vector2 atlas_size_;
	godot::Rect2 bounds_;

	void build_gpu();
	void clear();

protected:
	static void _bind_methods();

public:
	~UgoModel() override;

	// Loads a .ug9 file; textures are looked up next to it.
	godot::Error load_file(const godot::String &path);
	// Loads .ug9 bytes; textures are looked up in base_dir (may be empty).
	godot::Error load_bytes(const godot::PackedByteArray &bytes, const godot::String &base_dir);
	bool is_loaded() const { return model_ != nullptr; }
	// pixel_art: read the textures texel by texel (nearest), for pixel art. Set before characters draw.
	void set_pixel_art(bool on) { pixel_art_ = on; }
	bool is_pixel_art() const { return pixel_art_; }
	const ::UgoModel *core() const { return model_; }

	godot::PackedStringArray get_parameter_names() const;
	godot::PackedStringArray get_animation_names() const;
	godot::PackedStringArray get_part_names() const;
	godot::PackedStringArray get_texture_names() const;
	godot::PackedStringArray get_expression_names() const; // the model's own expressions (format 0.8)
	int find_expression(const godot::String &name) const;
	int find_parameter(const godot::String &name) const;
	int find_animation(const godot::String &name) const;
	float get_parameter_min(const godot::String &name) const;
	float get_parameter_max(const godot::String &name) const;
	float get_parameter_default(const godot::String &name) const;
	float get_animation_length(const godot::String &name) const;
	godot::Vector2 get_canvas_size() const;
	godot::Vector2 get_canvas_origin() const;
	int get_vertex_count() const;
	int get_bone_count() const;
	int get_part_count() const;
	int get_morph_count() const;
	int get_frame_bytes() const;

	// The textures (atlas pages). Set one to use an imported texture instead
	// of the file named in the .ug9. They are premultiplied once for drawing.
	void set_texture(int index, const godot::Ref<godot::Texture2D> &texture);
	godot::Ref<godot::Texture2D> get_texture(int index) const;
	void set_atlas(const godot::Ref<godot::Texture2D> &texture) { set_texture(0, texture); }
	godot::Ref<godot::Texture2D> get_atlas() const { return get_texture(0); }

	// GPU data (valid while loaded)
	const std::vector<Run> &gpu_runs();
	// The runs that draw the parts in this order (part numbers, as ugo_draw_order gives them; format 0.8).
	std::vector<Run> gpu_runs_for(const uint32_t *order);
	bool has_draw_order() const { return model_ && ugo_has_draw_order(model_); }
	// A mesh with every vertex and these triangles (VERTEX_ID stays the model's vertex number).
	godot::Ref<godot::ArrayMesh> gpu_mesh(const godot::PackedInt32Array &indices);
	const godot::PackedInt32Array &gpu_mask_indices();
	int mask_channel_count() const { return model_ ? (int)ugo_mask_channel_count(model_) : 0; }
	godot::Ref<godot::ImageTexture> gpu_vertices();
	godot::Ref<godot::ImageTexture> gpu_entries();
	godot::Ref<godot::ImageTexture> gpu_xweights();
	godot::Ref<godot::ImageTexture> gpu_parts();
	godot::Ref<godot::Texture2DArray> gpu_atlas();
	godot::PackedVector2Array gpu_tex_scale();
	godot::Vector2 gpu_atlas_size();
	// Rest-pose bounds of the model, padded for deformation (culling only)
	godot::Rect2 cull_bounds();

	// The shader for one kind of draw (see shaders/ugo9.gdshader): "" (normal and
	// add), "UGO_MULTIPLY", "UGO_SCREEN", "UGO_SCREEN_APPROX" or "UGO_MASK".
	static godot::Ref<godot::Shader> shader(const char *variant);
	static void free_shared();
};

} // namespace ugo9
