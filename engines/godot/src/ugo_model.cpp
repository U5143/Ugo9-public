/* SPDX-FileCopyrightText: 2026 U5143
 * SPDX-License-Identifier: MIT */
#include "ugo_model.h"

#include <godot_cpp/classes/file_access.hpp>
#include <godot_cpp/classes/image.hpp>
#include <godot_cpp/classes/resource_loader.hpp>
#include <godot_cpp/core/class_db.hpp>
#include <godot_cpp/variant/utility_functions.hpp>

#include <algorithm>
#include <cstring>

#include "ugo_shader.h"

using namespace godot;

namespace ugo9 {

static Ref<Shader> s_shaders[5];
static const char *const s_variants[5] = { "", "UGO_MULTIPLY", "UGO_SCREEN", "UGO_SCREEN_APPROX", "UGO_MASK" };

Ref<Shader> UgoModel::shader(const char *variant) {
	int i = 0;
	while (i < 4 && strcmp(s_variants[i], variant) != 0) i++;
	if (strcmp(s_variants[i], variant) != 0) i = 0;
	if (s_shaders[i].is_null()) {
		// the variant's #define goes right after the shader_type line
		String code = UGO9_SHADER_CODE;
		if (*s_variants[i]) {
			const int at = code.find("shader_type canvas_item;");
			const int eol = code.find("\n", at);
			code = code.substr(0, eol + 1) + "#define " + s_variants[i] + "\n" + code.substr(eol + 1);
		}
		s_shaders[i].instantiate();
		s_shaders[i]->set_code(code);
	}
	return s_shaders[i];
}

void UgoModel::free_shared() {
	for (Ref<Shader> &s : s_shaders) s.unref();
}

UgoModel::~UgoModel() { clear(); }

void UgoModel::clear() {
	model_ = nullptr;
	data_.clear();
	mem_.clear();
	gpu_built_ = false;
	vertices_.clear();
	uvs_.clear();
	runs_.clear();
	mask_indices_.clear();
	vertex_tex_.unref();
	entry_tex_.unref();
	xweight_tex_.unref();
	part_tex_.unref();
	atlas_tex_.unref();
}

Error UgoModel::load_file(const String &path) {
	PackedByteArray bytes = FileAccess::get_file_as_bytes(path);
	if (bytes.is_empty()) {
		UtilityFunctions::push_error("Ugo9: cannot read ", path);
		return ERR_FILE_CANT_OPEN;
	}
	return load_bytes(bytes, path.get_base_dir());
}

Error UgoModel::load_bytes(const PackedByteArray &bytes, const String &base_dir) {
	clear();
	const uint32_t size = (uint32_t)bytes.size();
	data_ = blocks(size);
	memcpy(data_.data(), bytes.ptr(), size);
	// the memory this file needs (format 1.1 expands curve keys when loading); 0: it cannot be read
	const uint32_t need = ugo_model_mem_size_for(data_.data(), size);
	if (need) {
		mem_ = blocks(need);
		model_ = ugo_model_init_sized(mem_.data(), need, data_.data(), size);
	}
	if (!model_) {
		const int err = ugo_last_error();
		const int reads = (int)(ugo_version() >> 16);
		if (err == UGO_ERR_VERSION && size >= 8) { // say which version it is, and what to do (as web/ugo.js)
			const uint8_t *b = bytes.ptr();
			const int major = b[4] | (b[5] << 8), minor = b[6] | (b[7] << 8);
			const String v = String::num_int64(major) + "." + String::num_int64(minor);
			UtilityFunctions::push_error(major == reads ? "Ugo9: this .ug9 (format " + v + ") uses something this plugin does not know: update the Ugo9 plugin"
					: major < reads ? "Ugo9: this .ug9 is format " + v + ", but this plugin reads " + String::num_int64(reads) + ".x: compile it again from its authoring JSON"
									: "Ugo9: this .ug9 is format " + v + ", but this plugin reads " + String::num_int64(reads) + ".x: update the Ugo9 plugin");
		} else {
			UtilityFunctions::push_error("Ugo9: not a valid .ug9 file (error ", err, ")");
		}
		clear();
		return ERR_FILE_CORRUPT;
	}
	if (const uint32_t w = ugo_model_warnings(model_)) {
		const uint32_t f = ugo_model_format(model_), v = ugo_version();
		const String what = (w & UGO_WARN_SKIPPED_TABLE) && (w & UGO_WARN_SKIPPED_TRACKS) ? "tables and animation tracks"
				: (w & UGO_WARN_SKIPPED_TABLE) ? "tables" : "animation tracks";
		UtilityFunctions::push_warning("Ugo9: this .ug9 is format ", (int)(f >> 16), ".", (int)(f & 0xffff), ", newer than this plugin (",
				(int)(v >> 16), ".", (int)(v & 0xffff), "): it skipped ", what, " it does not know, so the picture may differ. Update the Ugo9 plugin.");
	}
	base_dir_ = base_dir;
	const int n = std::min((int)ugo_texture_count(model_), MAX_TEXTURES);
	textures_.resize(std::max(n, (int)textures_.size()));
	for (int i = 0; i < n; i++) {
		if (textures_[i].is_valid() || base_dir_.is_empty()) continue;
		const String path = base_dir_.path_join(String::utf8(ugo_texture_name(model_, i)));
		if (ResourceLoader::get_singleton()->exists(path)) {
			textures_[i] = ResourceLoader::get_singleton()->load(path);
		} else if (FileAccess::file_exists(path)) { // not imported (e.g. outside res://)
			Ref<Image> image = Image::load_from_file(path);
			if (image.is_valid()) textures_[i] = ImageTexture::create_from_image(image);
		}
		if (textures_[i].is_null()) UtilityFunctions::push_warning("Ugo9: texture not found: ", path);
	}
	emit_changed();
	return OK;
}

void UgoModel::set_texture(int index, const Ref<Texture2D> &texture) {
	ERR_FAIL_INDEX(index, MAX_TEXTURES);
	if ((int)textures_.size() <= index) textures_.resize(index + 1);
	textures_[index] = texture;
	atlas_tex_.unref();
	emit_changed();
}

Ref<Texture2D> UgoModel::get_texture(int index) const {
	return (index >= 0 && index < (int)textures_.size()) ? textures_[index] : Ref<Texture2D>();
}

static PackedStringArray names(const ::UgoModel *m, uint32_t count, const char *(*get)(const ::UgoModel *, uint32_t)) {
	PackedStringArray out;
	for (uint32_t i = 0; m && i < count; i++) out.push_back(String::utf8(get(m, i)));
	return out;
}

PackedStringArray UgoModel::get_parameter_names() const { return names(model_, model_ ? ugo_param_count(model_) : 0, ugo_param_name); }
PackedStringArray UgoModel::get_animation_names() const { return names(model_, model_ ? ugo_animation_count(model_) : 0, ugo_animation_name); }
PackedStringArray UgoModel::get_part_names() const { return names(model_, model_ ? ugo_part_count(model_) : 0, ugo_part_name); }
PackedStringArray UgoModel::get_texture_names() const { return names(model_, model_ ? ugo_texture_count(model_) : 0, ugo_texture_name); }
PackedStringArray UgoModel::get_expression_names() const { return names(model_, model_ ? ugo_expression_count(model_) : 0, ugo_expression_name); }
int UgoModel::find_expression(const String &name) const { return (int)get_expression_names().find(name); }

int UgoModel::find_parameter(const String &name) const { return model_ ? ugo_find_param(model_, name.utf8().get_data()) : -1; }
int UgoModel::find_animation(const String &name) const { return model_ ? ugo_find_animation(model_, name.utf8().get_data()) : -1; }

float UgoModel::get_parameter_min(const String &name) const {
	const int i = find_parameter(name);
	return i < 0 ? 0.0f : ugo_param_min(model_, i);
}
float UgoModel::get_parameter_max(const String &name) const {
	const int i = find_parameter(name);
	return i < 0 ? 0.0f : ugo_param_max(model_, i);
}
float UgoModel::get_parameter_default(const String &name) const {
	const int i = find_parameter(name);
	return i < 0 ? 0.0f : ugo_param_default(model_, i);
}
float UgoModel::get_animation_length(const String &name) const {
	const int i = find_animation(name);
	return i < 0 ? 0.0f : ugo_animation_duration(model_, i);
}
Vector2 UgoModel::get_canvas_size() const {
	if (!model_) return Vector2();
	const float *c = ugo_canvas(model_);
	return Vector2(c[0], c[1]);
}
Vector2 UgoModel::get_canvas_origin() const {
	if (!model_) return Vector2();
	const float *c = ugo_canvas(model_);
	return Vector2(c[2], c[3]);
}
int UgoModel::get_vertex_count() const { return model_ ? (int)ugo_vertex_count(model_) : 0; }
int UgoModel::get_bone_count() const { return model_ ? (int)ugo_bone_count(model_) : 0; }
int UgoModel::get_part_count() const { return model_ ? (int)ugo_part_count(model_) : 0; }
int UgoModel::get_morph_count() const { return model_ ? (int)ugo_morph_count(model_) : 0; }
int UgoModel::get_frame_bytes() const { return model_ ? (int)ugo_frame_float_count(model_) * 4 : 0; }

// A float texture holding `texels` RGBA texels in rows of `width`.
static Ref<ImageTexture> float_texture(const std::vector<float> &texels, int width) {
	const int count = (int)(texels.size() / 4);
	const int rows = std::max(1, (count + width - 1) / width);
	PackedByteArray bytes;
	bytes.resize((int64_t)width * rows * 16);
	memset(bytes.ptrw(), 0, bytes.size());
	if (!texels.empty()) memcpy(bytes.ptrw(), texels.data(), texels.size() * sizeof(float));
	return ImageTexture::create_from_image(Image::create_from_data(width, rows, false, Image::FORMAT_RGBAF, bytes));
}

void UgoModel::build_gpu() {
	if (!model_ || gpu_built_) return;
	gpu_built_ = true;
	const ::UgoModel *m = model_;
	const uint32_t nv = ugo_vertex_count(m), ne = ugo_entry_count(m), nx = ugo_extra_weight_count(m), np = ugo_part_count(m);
	const float *pos = ugo_positions(m), *uv = ugo_uvs(m), *w = ugo_weights(m);
	const uint16_t *joints = ugo_joints(m);
	const uint32_t *parts = ugo_vertex_parts(m), *csr = ugo_csr_starts(m), *xs = ugo_extra_weight_starts(m), *idx = ugo_indices(m);

	vertices_.resize(nv);
	uvs_.resize(nv);
	Vector2 lo(1e30f, 1e30f), hi(-1e30f, -1e30f);
	for (uint32_t i = 0; i < nv; i++) {
		vertices_.set(i, Vector2(pos[2 * i], pos[2 * i + 1]));
		uvs_.set(i, Vector2(uv[2 * i], uv[2 * i + 1]));
		lo = lo.min(vertices_[i]);
		hi = hi.max(vertices_[i]);
	}
	// a deformed character can leave its rest-pose box: pad by half its size
	if (nv == 0) lo = hi = Vector2();
	// vertices in warp grids are in cell units: the canvas tells where the character is
	const float *cv = ugo_canvas(m);
	lo = lo.min(Vector2(-cv[2], -cv[3]));
	hi = hi.max(Vector2(cv[0] - cv[2], cv[1] - cv[3]));
	const Vector2 pad = (hi - lo) * 0.5f + Vector2(64, 64);
	bounds_ = Rect2(lo - pad, hi - lo + pad * 2.0f);

	// vertex table: joints, weights, (part, first morph entry, count, 0), (first extra weight, count, 0, 0)
	std::vector<float> vt(16 * (size_t)nv);
	for (uint32_t i = 0; i < nv; i++) {
		float *t = &vt[16 * (size_t)i];
		for (int j = 0; j < 4; j++) {
			t[j] = joints[4 * i + j];
			t[4 + j] = w[4 * i + j];
		}
		t[8] = (float)parts[i];
		t[9] = (float)csr[i];
		t[10] = (float)(csr[i + 1] - csr[i]);
		t[12] = (float)xs[i];
		t[13] = (float)(xs[i + 1] - xs[i]);
	}
	vertex_tex_ = float_texture(vt, VERTEX_W);

	const float *raw = ugo_entries(m);
	std::vector<float> et(4 * (size_t)ne);
	for (uint32_t i = 0; i < ne; i++) {
		uint32_t morph;
		memcpy(&morph, &raw[3 * i], 4);
		et[4 * i] = (float)morph;
		et[4 * i + 1] = raw[3 * i + 1];
		et[4 * i + 2] = raw[3 * i + 2];
	}
	entry_tex_ = float_texture(et, ENTRY_W);

	const float *xraw = ugo_extra_weights(m);
	std::vector<float> xt(4 * (size_t)nx);
	for (uint32_t i = 0; i < nx; i++) {
		uint32_t bone;
		memcpy(&bone, &xraw[2 * i], 4);
		xt[4 * i] = (float)bone;
		xt[4 * i + 1] = xraw[2 * i + 1];
	}
	xweight_tex_ = float_texture(xt, ENTRY_W);

	// part table (same meaning as web/ugo.js, stored as floats)
	const uint32_t nmask = ugo_mask_count(m);
	std::vector<uint32_t> written(np, 0);
	std::vector<char> is_mask(np, 0);
	for (uint32_t k = 0; k < nmask; k++) {
		uint32_t count = 0;
		const uint32_t *list = ugo_mask_parts(m, k, &count);
		for (uint32_t j = 0; j < count; j++) {
			written[list[j]] |= 1u << ugo_mask_channel(m, k);
			is_mask[list[j]] = 1;
		}
	}
	const int ntex = std::max(1, std::min((int)ugo_texture_count(m), MAX_TEXTURES));
	std::vector<float> pt(8 * (size_t)np);
	for (uint32_t i = 0; i < np; i++) {
		float *t = &pt[8 * (size_t)i];
		const uint32_t flags = ugo_part_flags(m, i), blend = ugo_part_blend(m, i);
		const int mask = ugo_part_mask(m, i), warp = ugo_part_warp(m, i);
		t[0] = (float)written[i];
		if (mask >= 0) t[1] = (float)(ugo_mask_channel(m, mask) | ((flags & UGO_PART_MASK_INVERT) ? 16u : 0u) | 32u);
		t[2] = (float)(flags | (blend << 8) | ((uint32_t)std::min((int)ugo_part_texture(m, i), ntex - 1) << 16));
		t[3] = (float)(ugo_part_color(m, i) + 1);
		if (warp >= 0) {
			uint32_t info[3];
			ugo_warp_info(m, warp, info); // cols, rows, offset of its points (floats)
			t[4] = (float)(info[2] / 4 + 1);
			t[5] = (float)info[0];
			t[6] = (float)info[1];
		}
	}
	part_tex_ = float_texture(pt, PARTS_W);

	// triangles: every mask part, and runs of drawn parts by blend class in the stored order
	for (uint32_t i = 0; i < np; i++) {
		uint32_t range[4];
		ugo_part_range(m, i, range);
		if (range[3] == 0 || !is_mask[i]) continue;
		for (uint32_t k = 0; k < range[3]; k++) mask_indices_.push_back((int32_t)idx[range[2] + k]);
	}
	runs_ = gpu_runs_for(nullptr);
}

std::vector<Run> UgoModel::gpu_runs_for(const uint32_t *order) {
	std::vector<Run> runs;
	if (!model_) return runs;
	const ::UgoModel *m = model_;
	const uint32_t *idx = ugo_indices(m);
	for (uint32_t j = 0, np = ugo_part_count(m); j < np; j++) {
		const uint32_t i = order ? order[j] : j;
		uint32_t range[4];
		ugo_part_range(m, i, range);
		if (range[3] == 0 || (ugo_part_flags(m, i) & UGO_PART_HIDDEN)) continue;
		const uint32_t blend = ugo_part_blend(m, i);
		const BlendClass cls = blend == UGO_BLEND_MULTIPLY ? BLEND_CLASS_MULTIPLY : (blend == UGO_BLEND_SCREEN ? BLEND_CLASS_SCREEN : BLEND_CLASS_NORMAL);
		if (runs.empty() || runs.back().cls != cls) runs.push_back({ cls, PackedInt32Array() });
		for (uint32_t k = 0; k < range[3]; k++) runs.back().indices.push_back((int32_t)idx[range[2] + k]);
	}
	return runs;
}

const std::vector<Run> &UgoModel::gpu_runs() {
	build_gpu();
	return runs_;
}
const PackedInt32Array &UgoModel::gpu_mask_indices() {
	build_gpu();
	return mask_indices_;
}

Ref<ArrayMesh> UgoModel::gpu_mesh(const PackedInt32Array &indices) {
	build_gpu();
	Ref<ArrayMesh> mesh;
	mesh.instantiate();
	if (vertices_.is_empty() || indices.is_empty()) return mesh;
	Array arrays;
	arrays.resize(Mesh::ARRAY_MAX);
	arrays[Mesh::ARRAY_VERTEX] = vertices_;
	arrays[Mesh::ARRAY_TEX_UV] = uvs_;
	arrays[Mesh::ARRAY_INDEX] = indices;
	mesh->add_surface_from_arrays(Mesh::PRIMITIVE_TRIANGLES, arrays);
	return mesh;
}

Ref<ImageTexture> UgoModel::gpu_vertices() {
	build_gpu();
	return vertex_tex_;
}
Ref<ImageTexture> UgoModel::gpu_entries() {
	build_gpu();
	return entry_tex_;
}
Ref<ImageTexture> UgoModel::gpu_xweights() {
	build_gpu();
	return xweight_tex_;
}
Ref<ImageTexture> UgoModel::gpu_parts() {
	build_gpu();
	return part_tex_;
}
Rect2 UgoModel::cull_bounds() {
	build_gpu();
	return bounds_;
}

// Every texture premultiplied, in one texture array (smaller pages padded: their
// edges repeated, then transparent, like web/ugo.js), so all parts draw in one call.
Ref<Texture2DArray> UgoModel::gpu_atlas() {
	if (atlas_tex_.is_valid() || !model_) return atlas_tex_;
	const int n = std::max(1, std::min((int)ugo_texture_count(model_), MAX_TEXTURES));
	std::vector<Ref<Image>> pages(n);
	int aw = 1, ah = 1;
	for (int i = 0; i < n; i++) {
		const Ref<Texture2D> t = get_texture(i);
		Ref<Image> image = t.is_valid() ? t->get_image() : Ref<Image>();
		if (image.is_valid()) {
			image = image->duplicate();
			if (image->is_compressed()) image->decompress();
			image->clear_mipmaps();
			image->convert(Image::FORMAT_RGBA8);
			image->premultiply_alpha();
		} else {
			// no texture: draw the mesh in white so it is still visible
			image = Image::create_empty(1, 1, false, Image::FORMAT_RGBA8);
			image->fill(Color(1, 1, 1, 1));
		}
		pages[i] = image;
		aw = std::max(aw, image->get_width());
		ah = std::max(ah, image->get_height());
	}
	tex_scale_.resize(MAX_TEXTURES);
	for (int i = 0; i < MAX_TEXTURES; i++) tex_scale_.set(i, Vector2(1, 1));
	Array layers;
	for (int i = 0; i < n; i++) {
		Ref<Image> image = pages[i];
		tex_scale_.set(i, Vector2((float)image->get_width() / aw, (float)image->get_height() / ah));
		if (image->get_width() != aw || image->get_height() != ah) {
			const int w = image->get_width(), h = image->get_height();
			Ref<Image> padded = Image::create_empty(aw, ah, false, Image::FORMAT_RGBA8);
			padded->fill(Color(0, 0, 0, 0));
			padded->blit_rect(image, Rect2i(0, 0, w, h), Vector2i(0, 0));
			// the page's last column and row repeated up to 64 texels out (and the corner), as web/ugo.js's
			// UgoRenderer.pageEdges: with transparent padding, the mipmaps of a part drawn small mix it into the
			// page's right and bottom edges (a see-through seam); with these the page samples as clamped to its edge
			const int mx = std::min(64, aw - w), my = std::min(64, ah - h);
			for (int k = 0; k < mx; k++) padded->blit_rect(image, Rect2i(w - 1, 0, 1, h), Vector2i(w + k, 0));
			for (int k = 0; k < my; k++) padded->blit_rect(image, Rect2i(0, h - 1, w, 1), Vector2i(0, h + k));
			if (mx > 0 && my > 0) padded->fill_rect(Rect2i(w, h, mx, my), image->get_pixel(w - 1, h - 1));
			image = padded;
		}
		image->generate_mipmaps();
		layers.push_back(image);
	}
	atlas_size_ = Vector2(aw, ah);
	atlas_tex_.instantiate();
	atlas_tex_->create_from_images(layers);
	return atlas_tex_;
}

PackedVector2Array UgoModel::gpu_tex_scale() {
	gpu_atlas();
	return tex_scale_;
}
Vector2 UgoModel::gpu_atlas_size() {
	gpu_atlas();
	return atlas_size_;
}

void UgoModel::_bind_methods() {
	ClassDB::bind_method(D_METHOD("load_file", "path"), &UgoModel::load_file);
	ClassDB::bind_method(D_METHOD("load_bytes", "bytes", "base_dir"), &UgoModel::load_bytes);
	ClassDB::bind_method(D_METHOD("is_loaded"), &UgoModel::is_loaded);
	ClassDB::bind_method(D_METHOD("get_parameter_names"), &UgoModel::get_parameter_names);
	ClassDB::bind_method(D_METHOD("get_animation_names"), &UgoModel::get_animation_names);
	ClassDB::bind_method(D_METHOD("get_part_names"), &UgoModel::get_part_names);
	ClassDB::bind_method(D_METHOD("get_texture_names"), &UgoModel::get_texture_names);
	ClassDB::bind_method(D_METHOD("get_expression_names"), &UgoModel::get_expression_names);
	ClassDB::bind_method(D_METHOD("find_parameter", "name"), &UgoModel::find_parameter);
	ClassDB::bind_method(D_METHOD("find_animation", "name"), &UgoModel::find_animation);
	ClassDB::bind_method(D_METHOD("get_parameter_min", "name"), &UgoModel::get_parameter_min);
	ClassDB::bind_method(D_METHOD("get_parameter_max", "name"), &UgoModel::get_parameter_max);
	ClassDB::bind_method(D_METHOD("get_parameter_default", "name"), &UgoModel::get_parameter_default);
	ClassDB::bind_method(D_METHOD("get_animation_length", "name"), &UgoModel::get_animation_length);
	ClassDB::bind_method(D_METHOD("get_canvas_size"), &UgoModel::get_canvas_size);
	ClassDB::bind_method(D_METHOD("get_canvas_origin"), &UgoModel::get_canvas_origin);
	ClassDB::bind_method(D_METHOD("get_vertex_count"), &UgoModel::get_vertex_count);
	ClassDB::bind_method(D_METHOD("get_bone_count"), &UgoModel::get_bone_count);
	ClassDB::bind_method(D_METHOD("get_part_count"), &UgoModel::get_part_count);
	ClassDB::bind_method(D_METHOD("get_morph_count"), &UgoModel::get_morph_count);
	ClassDB::bind_method(D_METHOD("get_frame_bytes"), &UgoModel::get_frame_bytes);
	ClassDB::bind_method(D_METHOD("set_texture", "index", "texture"), &UgoModel::set_texture);
	ClassDB::bind_method(D_METHOD("set_pixel_art", "on"), &UgoModel::set_pixel_art);
	ClassDB::bind_method(D_METHOD("is_pixel_art"), &UgoModel::is_pixel_art);
	ClassDB::bind_method(D_METHOD("get_texture", "index"), &UgoModel::get_texture);
	ClassDB::bind_method(D_METHOD("set_atlas", "texture"), &UgoModel::set_atlas);
	ClassDB::bind_method(D_METHOD("get_atlas"), &UgoModel::get_atlas);
	ADD_PROPERTY(PropertyInfo(Variant::BOOL, "pixel_art"), "set_pixel_art", "is_pixel_art");
	ADD_PROPERTY(PropertyInfo(Variant::OBJECT, "atlas", PROPERTY_HINT_RESOURCE_TYPE, "Texture2D", PROPERTY_USAGE_EDITOR), "set_atlas", "get_atlas");
}

} // namespace ugo9
