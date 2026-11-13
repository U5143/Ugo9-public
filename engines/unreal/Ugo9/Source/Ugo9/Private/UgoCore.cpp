/* SPDX-FileCopyrightText: 2026 U5143
 * SPDX-License-Identifier: MIT */
#include "UgoCore.h"

#include <algorithm>
#include <cstring>

extern "C" {
#include "ugo.h"
}

namespace ugo9core {

void AlignedBlock::Resize(size_t bytes) {
	raw_.reset(new uint8_t[bytes + 16]);
	data_ = reinterpret_cast<uint8_t *>((reinterpret_cast<uintptr_t>(raw_.get()) + 15) & ~uintptr_t(15));
	size_ = bytes;
}

int Model::CoreMajor() { return (int)(ugo_version() >> 16); }

static std::vector<std::string> Names(const UgoModel *m, uint32_t n, const char *(*get)(const UgoModel *, uint32_t)) {
	std::vector<std::string> out;
	out.reserve(n);
	for (uint32_t i = 0; i < n; i++) {
		const char *s = get(m, i);
		out.emplace_back(s ? s : "");
	}
	return out;
}

bool Model::Load(const uint8_t *bytes, size_t size) {
	model_ = nullptr;
	error_.clear();
	if (!bytes || size == 0 || size > 0x7fffffff) {
		error_ = "Ugo9: empty .ug9 data";
		return false;
	}
	data_.Resize(size);
	std::memcpy(data_.Data(), bytes, size);
	// the memory this file needs (format 1.1 expands curve keys when loading); 0: it cannot be read
	const uint32_t need = ugo_model_mem_size_for(data_.Data(), (uint32_t)size);
	if (need != 0) {
		mem_.Resize(need);
		model_ = ugo_model_init_sized(mem_.Data(), need, data_.Data(), (uint32_t)size);
	}
	if (!model_) {
		const int error = ugo_last_error();
		// why it could not be read, and what to do (as web/ugo.js and the Unity package say it)
		if (error == ErrVersion && size >= 8) {
			const int major = bytes[4] | (bytes[5] << 8), minor = bytes[6] | (bytes[7] << 8), reads = CoreMajor();
			const std::string v = std::to_string(major) + "." + std::to_string(minor);
			error_ = major == reads ? "Ugo9: this .ug9 (format " + v + ") uses something this plugin does not know: update the Ugo9 plugin"
				: major < reads ? "Ugo9: this .ug9 is format " + v + ", but this plugin reads " + std::to_string(reads) + ".x: compile it again from its authoring JSON"
								: "Ugo9: this .ug9 is format " + v + ", but this plugin reads " + std::to_string(reads) + ".x: update the Ugo9 plugin";
		} else {
			error_ = "Ugo9: not a valid .ug9 file (error " + std::to_string(error) + ")";
		}
		return false;
	}
	warnings_ = ugo_model_warnings(model_);
	const uint32_t format = ugo_model_format(model_);
	formatMajor_ = (int)(format >> 16);
	formatMinor_ = (int)(format & 0xffff);
	params_ = Names(model_, ugo_param_count(model_), ugo_param_name);
	anims_ = Names(model_, ugo_animation_count(model_), ugo_animation_name);
	parts_ = Names(model_, ugo_part_count(model_), ugo_part_name);
	bones_ = Names(model_, ugo_bone_count(model_), ugo_bone_name);
	textures_ = Names(model_, ugo_texture_count(model_), ugo_texture_name);
	exprs_ = Names(model_, ugo_expression_count(model_), ugo_expression_name);
	// hit areas: "hit:<name>", "当たり:<name>" (a full-width colon too)
	areas_.clear();
	areaOfPart_.assign(parts_.size(), std::string());
	areaMask_.assign(std::max<size_t>(1, parts_.size()), 0);
	for (size_t i = 0; i < parts_.size(); i++) {
		for (const char *pre : { "hit:", "\xE5\xBD\x93\xE3\x81\x9F\xE3\x82\x8A:", "\xE5\xBD\x93\xE3\x81\x9F\xE3\x82\x8A\xEF\xBC\x9A" }) {
			const size_t n = std::strlen(pre);
			if (parts_[i].compare(0, n, pre) == 0) areaOfPart_[i] = parts_[i].substr(n);
		}
		if (areaOfPart_[i].empty()) continue;
		areaMask_[i] = 1;
		if (std::find(areas_.begin(), areas_.end(), areaOfPart_[i]) == areas_.end()) areas_.push_back(areaOfPart_[i]);
	}
	return true;
}

std::string Model::WarningText() const {
	if (warnings_ == 0) return std::string();
	const bool t = (warnings_ & WarnSkippedTable) != 0, k = (warnings_ & WarnSkippedTracks) != 0;
	const char *what = t && k ? "tables and animation tracks" : t ? "tables" : "animation tracks";
	const uint32_t v = ugo_version();
	return "Ugo9: this .ug9 is format " + std::to_string(formatMajor_) + "." + std::to_string(formatMinor_) + ", newer than this plugin (" +
		std::to_string(v >> 16) + "." + std::to_string(v & 0xffff) + "): it skipped " + what +
		" it does not know, so the picture may differ. Update the Ugo9 plugin.";
}

int Model::FindParameter(const std::string &name) const { return model_ ? ugo_find_param(model_, name.c_str()) : -1; }
int Model::FindAnimation(const std::string &name) const { return model_ ? ugo_find_animation(model_, name.c_str()) : -1; }
int Model::FindPart(const std::string &name) const { return model_ ? ugo_find_part(model_, name.c_str()) : -1; }
int Model::FindBone(const std::string &name) const { return model_ ? ugo_find_bone(model_, name.c_str()) : -1; }
float Model::ParameterMin(int i) const { return model_ && i >= 0 ? ugo_param_min(model_, (uint32_t)i) : 0.0f; }
float Model::ParameterMax(int i) const { return model_ && i >= 0 ? ugo_param_max(model_, (uint32_t)i) : 0.0f; }
float Model::ParameterDefault(int i) const { return model_ && i >= 0 ? ugo_param_default(model_, (uint32_t)i) : 0.0f; }
float Model::AnimationDuration(int i) const { return model_ && i >= 0 ? ugo_animation_duration(model_, (uint32_t)i) : 0.0f; }
bool Model::AnimationLoops(int i) const { return model_ && i >= 0 && ugo_animation_loop(model_, (uint32_t)i) != 0; }
void Model::Canvas(float out[4]) const {
	const float *c = model_ ? ugo_canvas(model_) : nullptr;
	for (int k = 0; k < 4; k++) out[k] = c ? c[k] : 0.0f;
}
uint32_t Model::VertexCount() const { return model_ ? ugo_vertex_count(model_) : 0; }
uint32_t Model::FrameFloats() const { return model_ ? ugo_frame_float_count(model_) : 0; }
bool Model::HasDrawOrder() const { return model_ && ugo_has_draw_order(model_) != 0; }

static uint32_t Bits(float f) { uint32_t u; std::memcpy(&u, &f, 4); return u; }

const GpuTables &Model::Tables() const {
	if (tables_) return *tables_;
	tables_.reset(new GpuTables());
	GpuTables &t = *tables_;
	const UgoModel *m = model_;
	if (!m) return t;
	const uint32_t nv = ugo_vertex_count(m), np = ugo_part_count(m), ne = ugo_entry_count(m), nx = ugo_extra_weight_count(m);
	const float *pos = ugo_positions(m), *uv = ugo_uvs(m), *w = ugo_weights(m);
	const uint16_t *joints = ugo_joints(m);
	const uint32_t *vparts = ugo_vertex_parts(m), *csr = ugo_csr_starts(m), *xs = ugo_extra_weight_starts(m), *indices = ugo_indices(m);
	float canvas[4];
	Canvas(canvas);
	t.minX = -canvas[2]; t.minY = -canvas[3]; t.maxX = canvas[0] - canvas[2]; t.maxY = canvas[1] - canvas[3];
	t.positions.assign(pos, pos + 2 * nv);
	t.uvs.assign(uv, uv + 2 * nv);
	t.vertices.assign(16 * (size_t)nv, 0.0f);
	for (uint32_t i = 0; i < nv; i++) {
		float *v = &t.vertices[16 * (size_t)i];
		for (int j = 0; j < 4; j++) { v[j] = joints[4 * i + j]; v[4 + j] = w[4 * i + j]; }
		v[8] = (float)vparts[i]; v[9] = (float)csr[i]; v[10] = (float)(csr[i + 1] - csr[i]);
		v[12] = (float)xs[i]; v[13] = (float)(xs[i + 1] - xs[i]);
		t.minX = std::min(t.minX, pos[2 * i]); t.maxX = std::max(t.maxX, pos[2 * i]);
		t.minY = std::min(t.minY, pos[2 * i + 1]); t.maxY = std::max(t.maxY, pos[2 * i + 1]);
	}
	const float *e = ugo_entries(m); // morph as u32 bits, dx, dy
	t.entries.assign(4 * (size_t)ne, 0.0f);
	for (uint32_t i = 0; i < ne; i++) {
		t.entries[4 * i] = (float)Bits(e[3 * i]);
		t.entries[4 * i + 1] = e[3 * i + 1];
		t.entries[4 * i + 2] = e[3 * i + 2];
	}
	const float *x = ugo_extra_weights(m); // bone as u32 bits, weight
	t.xweights.assign(4 * (size_t)nx, 0.0f);
	for (uint32_t i = 0; i < nx; i++) {
		t.xweights[4 * i] = (float)Bits(x[2 * i]);
		t.xweights[4 * i + 1] = x[2 * i + 1];
	}
	// masks: which channels each part writes
	std::vector<uint32_t> written(np, 0);
	std::vector<bool> isMask(np, false);
	for (uint32_t k = 0, nm = ugo_mask_count(m); k < nm; k++) {
		uint32_t count = 0;
		const uint32_t *list = ugo_mask_parts(m, k, &count);
		for (uint32_t j = 0; j < count; j++) { written[list[j]] |= 1u << ugo_mask_channel(m, k); isMask[list[j]] = true; }
	}
	t.maskChannels = (int)ugo_mask_channel_count(m);
	t.textureCount = std::max<int>(1, (int)ugo_texture_count(m));
	t.parts.assign(8 * (size_t)np, 0.0f);
	for (uint32_t i = 0; i < np; i++) {
		const uint32_t flags = ugo_part_flags(m, i), blend = ugo_part_blend(m, i);
		const int mask = ugo_part_mask(m, i), warp = ugo_part_warp(m, i);
		const uint32_t tex = std::min<uint32_t>(ugo_part_texture(m, i), (uint32_t)t.textureCount - 1);
		float *p = &t.parts[8 * (size_t)i];
		p[0] = (float)written[i];
		if (mask >= 0) p[1] = (float)(ugo_mask_channel(m, (uint32_t)mask) | ((flags & UGO_PART_MASK_INVERT) ? 16u : 0u) | 32u);
		p[2] = (float)(flags | (blend << 8) | (tex << 16));
		p[3] = (float)(ugo_part_color(m, i) + 1);
		if (warp >= 0) {
			uint32_t info[3];
			ugo_warp_info(m, (uint32_t)warp, info); // cols, rows, offset of its points (floats)
			p[4] = (float)(info[2] / 4 + 1); p[5] = (float)info[0]; p[6] = (float)info[1];
		}
		uint32_t range[4];
		ugo_part_range(m, i, range);
		if (isMask[i]) t.maskIndices.insert(t.maskIndices.end(), indices + range[2], indices + range[2] + range[3]);
	}
	t.frameFloats = ugo_frame_float_count(m);
	t.skinOffset = ugo_frame_skin_offset(m);
	t.opacityOffset = ugo_frame_opacity_offset(m);
	t.morphOffset = ugo_frame_morph_offset(m);
	t.colorOffset = ugo_frame_color_offset(m);
	t.runs = RunsFor(nullptr);
	return t;
}

std::vector<GpuTables::Run> Model::RunsFor(const uint32_t *order) const {
	std::vector<GpuTables::Run> runs;
	if (!model_) return runs;
	const uint32_t *indices = ugo_indices(model_);
	for (uint32_t j = 0, np = ugo_part_count(model_); j < np; j++) {
		const uint32_t i = order ? order[j] : j;
		uint32_t range[4];
		ugo_part_range(model_, i, range);
		if (range[3] == 0 || (ugo_part_flags(model_, i) & UGO_PART_HIDDEN)) continue;
		const uint32_t blend = ugo_part_blend(model_, i);
		const GpuTables::BlendClass cls = blend == UGO_BLEND_MULTIPLY ? GpuTables::Multiply : blend == UGO_BLEND_SCREEN ? GpuTables::Screen : GpuTables::Normal;
		if (runs.empty() || runs.back().blend != cls) runs.push_back({ cls, {} });
		runs.back().indices.insert(runs.back().indices.end(), indices + range[2], indices + range[2] + range[3]);
	}
	return runs;
}

Instance::Instance(const Model &model) : model_(model) {
	if (!model.IsLoaded()) return;
	mem_.Resize(ugo_instance_mem_size(model.Core()));
	in_ = ugo_instance_init(mem_.Data(), model.Core());
}

void Instance::ResetParams() { if (in_) ugo_reset_params(in_); }
void Instance::SetParam(int i, float value) { if (in_ && i >= 0) ugo_set_param(in_, (uint32_t)i, value); }
float Instance::GetParam(int i) const { return in_ && i >= 0 ? ugo_get_param(in_, (uint32_t)i) : 0.0f; }
void Instance::ApplyAnimation(int anim, float time, float weight) { if (in_ && anim >= 0) ugo_apply_animation(in_, (uint32_t)anim, time, weight); }
void Instance::SetTransform(float a, float b, float c, float d, float tx, float ty) { if (in_) ugo_set_transform(in_, a, b, c, d, tx, ty); }
void Instance::Update(float dt) { if (in_) ugo_update(in_, dt); }
const float *Instance::Frame() const { return in_ ? ugo_frame(in_) : nullptr; }
int Instance::PickPart(float x, float y, float minOpacity) const { return in_ ? ugo_pick_part(in_, nullptr, x, y, minOpacity) : -1; }
bool Instance::BoundsEstimate(float box[4]) { return in_ && ugo_bounds_estimate(in_, box) != 0; }
uint32_t Instance::DrawOrderKey() const { return in_ ? ugo_draw_order_key(in_) : 0; }
const uint32_t *Instance::DrawOrder() const { return in_ ? ugo_draw_order(in_) : nullptr; }

// ---- stage 4: expressions, hit areas, layers' masks, instance calls ----

int Model::FindExpression(const std::string &name) const {
	for (size_t i = 0; i < exprs_.size(); i++) if (exprs_[i] == name) return (int)i;
	return -1;
}
void Model::ExpressionFade(int expr, float &fadeIn, float &fadeOut) const {
	float f[2] = { 0, 0 };
	if (model_ && expr >= 0 && (size_t)expr < exprs_.size()) ugo_expression_fade(model_, (uint32_t)expr, f);
	fadeIn = f[0]; fadeOut = f[1];
}
std::vector<int> Model::ResolveParams(const std::vector<std::string> &names) const {
	std::vector<int> index(names.size(), -1);
	if (!model_ || names.empty()) return index;
	std::vector<const char *> ptrs;
	for (const std::string &n : names) ptrs.push_back(n.c_str());
	std::vector<int32_t> out(names.size(), -1);
	ugo_resolve_params(model_, ptrs.data(), (uint32_t)names.size(), out.data());
	for (size_t i = 0; i < names.size(); i++) index[i] = out[i];
	return index;
}
const std::string &Model::AreaOfPart(int part) const {
	static const std::string none;
	return part >= 0 && (size_t)part < areaOfPart_.size() ? areaOfPart_[part] : none;
}

bool AnimMask::Make(const Model &model, const std::vector<std::string> &bones, const std::vector<std::string> &parts,
                    const std::vector<std::string> &params, std::string &error) {
	made_ = false;
	auto fill = [&](const std::vector<std::string> &names, const std::vector<std::string> &all, const char *kind, std::vector<uint8_t> &out) {
		out.clear();
		if (names.empty()) return true;
		out.assign(std::max<size_t>(1, all.size()), 0);
		for (const std::string &n : names) {
			size_t i = 0;
			while (i < all.size() && all[i] != n) i++;
			if (i == all.size()) { error = std::string("Ugo9: the mask names the ") + kind + " \"" + n + "\", which the model does not have"; return false; }
			out[i] = 1;
		}
		return true;
	};
	if (!model.IsLoaded() || !fill(bones, model.BoneNames(), "bone", bones_) || !fill(parts, model.PartNames(), "part", parts_)
	    || !fill(params, model.ParameterNames(), "parameter", params_)) return false;
	core_ = std::make_shared<UgoAnimMask>();
	*core_ = UgoAnimMask{};
	core_->bones = bones_.empty() ? nullptr : bones_.data();
	core_->parts = parts_.empty() ? nullptr : parts_.data();
	core_->params = params_.empty() ? nullptr : params_.data();
	made_ = true;
	return true;
}

void Instance::ApplyAnimation(int anim, float time, float weight, bool additive, const AnimMask *mask) {
	if (in_ && anim >= 0) ugo_apply_animation_ex(in_, (uint32_t)anim, time, weight, additive ? UGO_ANIM_ADD : 0u, mask ? mask->Core() : nullptr);
}
void Instance::ApplyExpression(int expr, float weight) { if (in_ && expr >= 0) ugo_apply_expression(in_, (uint32_t)expr, weight); }
void Instance::ApplyParams(const std::vector<int> &index, const std::vector<uint32_t> &ops, const std::vector<float> &values, float weight) {
	const size_t n = std::min(index.size(), std::min(ops.size(), values.size()));
	if (!in_ || n == 0) return;
	std::vector<int32_t> idx(index.begin(), index.begin() + n);
	ugo_apply_params(in_, idx.data(), ops.data(), values.data(), (uint32_t)n, weight);
}
void Instance::SetWind(float x, float y, float gust) { if (in_) ugo_set_wind(in_, x, y, gust); }
int Instance::PickArea(float x, float y) const {
	if (!in_ || model_.AreaNames().empty()) return -1;
	return ugo_pick_area(in_, nullptr, x, y, model_.AreaMask().data());
}
bool Instance::Bounds(int part, float box[4]) const { return in_ && ugo_bounds(in_, nullptr, part, box) != 0; }
bool Instance::BoneWorld(int bone, float world[6]) const {
	if (!in_ || bone < 0 || (size_t)bone >= model_.BoneNames().size()) return false;
	ugo_bone_world(in_, (uint32_t)bone, world);
	return true;
}
float Instance::SolveIK(int bone, int count, float x, float y, int iterations) {
	if (!in_ || bone < 0 || count <= 0) return -1.0f;
	return ugo_solve_ik_to(in_, (uint32_t)bone, (uint32_t)count, x, y, (uint32_t)std::max(1, iterations));
}

} // namespace ugo9core
