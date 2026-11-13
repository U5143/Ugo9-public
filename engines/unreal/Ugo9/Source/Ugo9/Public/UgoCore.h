/* SPDX-FileCopyrightText: 2026 U5143
 * SPDX-License-Identifier: MIT */
// The Ugo9 core (C) wrapped for C++ without Unreal's types, so it builds and is tested outside
// Unreal too (tests/unreal_core): a model loaded from .ug9 bytes and an instance of it. The
// Unreal classes (UUgoModelAsset, later the character component) hold these. Same behaviour and
// messages as the Unity package's UgoModelData / UgoInstanceData.
#pragma once

#include <cstddef>
#include <cstdint>
#include <memory>
#include <string>
#include <vector>

struct UgoModel;
struct UgoInstance;
struct UgoAnimMask;

namespace ugo9core {

// memory the core wants 16-byte aligned
class AlignedBlock {
public:
	void Resize(size_t bytes);
	uint8_t *Data() const { return data_; }
	size_t Size() const { return size_; }

private:
	std::unique_ptr<uint8_t[]> raw_;
	uint8_t *data_ = nullptr;
	size_t size_ = 0;
};

// What the GPU reads for one model (made once; the same tables as the Unity package's GpuTables,
// float4 elements): the shader deforms every vertex from these and each character's frame block.
struct GpuTables {
	enum BlendClass { Normal = 0, Multiply = 1, Screen = 2 }; // normal and add share one draw
	struct Run {
		BlendClass blend = Normal;
		std::vector<uint32_t> indices; // triangles of drawn parts that share a blend class, in draw order
	};
	std::vector<float> positions;   // 2 per vertex (model pixels, or cells of a warp grid)
	std::vector<float> uvs;         // 2 per vertex (v = 0 at the image's top row)
	std::vector<float> vertices;    // 16 per vertex: joints, weights, (part, first entry, count, 0), (first extra weight, count, 0, 0)
	std::vector<float> entries;     // 4 per entry: (morph, dx, dy, 0)
	std::vector<float> xweights;    // 4 per extra weight: (bone, weight, 0, 0)
	std::vector<float> parts;       // 8 per part: (mask channels written, mask read, flags + blend*256 + texture*65536, colour slot + 1),
	                                //             (warp points' first frame texel + 1 or 0, cols, rows, 0)
	std::vector<Run> runs;          // in the stored draw order
	std::vector<uint32_t> maskIndices;
	int maskChannels = 0, textureCount = 1;
	// frame block layout (floats), for the shader
	uint32_t frameFloats = 0, skinOffset = 0, opacityOffset = 0, morphOffset = 0, colorOffset = 0;
	float minX = 0, minY = 0, maxX = 0, maxY = 0; // rest-pose bounds with the canvas
};

class Model {
public:
	enum { ErrVersion = 3, WarnSkippedTable = 1, WarnSkippedTracks = 2 };

	// Validates and loads .ug9 bytes (safe on hostile input). False: Error() says why and what to do.
	bool Load(const uint8_t *bytes, size_t size);
	bool IsLoaded() const { return model_ != nullptr; }
	const std::string &Error() const { return error_; }
	// What a later 1.x file had that this core skipped (0: nothing), and the warning to show then ("" otherwise).
	uint32_t Warnings() const { return warnings_; }
	std::string WarningText() const;
	int FormatMajor() const { return formatMajor_; }
	int FormatMinor() const { return formatMinor_; }
	static int CoreMajor();

	const UgoModel *Core() const { return model_; }

	const std::vector<std::string> &ParameterNames() const { return params_; }
	const std::vector<std::string> &AnimationNames() const { return anims_; }
	const std::vector<std::string> &PartNames() const { return parts_; }
	const std::vector<std::string> &BoneNames() const { return bones_; }
	const std::vector<std::string> &TextureNames() const { return textures_; }
	const std::vector<std::string> &ExpressionNames() const { return exprs_; }
	int FindParameter(const std::string &name) const;
	int FindAnimation(const std::string &name) const;
	int FindPart(const std::string &name) const;
	int FindBone(const std::string &name) const;
	int FindExpression(const std::string &name) const;
	// the expression's stored fade-in and fade-out times (seconds)
	void ExpressionFade(int expr, float &fadeIn, float &fadeOut) const;
	// parameter names to the model's numbers (-1 where it has none)
	std::vector<int> ResolveParams(const std::vector<std::string> &names) const;
	// hit areas: parts named "hit:<name>" or "当たり:<name>" give the area "<name>"
	const std::vector<std::string> &AreaNames() const { return areas_; }
	const std::vector<uint8_t> &AreaMask() const { return areaMask_; } // 1 per area part
	const std::string &AreaOfPart(int part) const;
	float ParameterMin(int i) const;
	float ParameterMax(int i) const;
	float ParameterDefault(int i) const;
	float AnimationDuration(int i) const;
	bool AnimationLoops(int i) const;
	// width, height, origin x, origin y (model pixels, y down)
	void Canvas(float out[4]) const;
	uint32_t VertexCount() const;
	uint32_t FrameFloats() const;
	bool HasDrawOrder() const;
	// The GPU's tables (made on first use).
	const GpuTables &Tables() const;
	// Runs of drawn parts in this order (part numbers; null: the stored order).
	std::vector<GpuTables::Run> RunsFor(const uint32_t *order) const;

private:
	AlignedBlock data_, mem_;
	UgoModel *model_ = nullptr;
	std::string error_;
	uint32_t warnings_ = 0;
	int formatMajor_ = 0, formatMinor_ = 0;
	std::vector<std::string> params_, anims_, parts_, bones_, textures_, exprs_;
	std::vector<std::string> areas_, areaOfPart_;
	std::vector<uint8_t> areaMask_;
	mutable std::unique_ptr<GpuTables> tables_;
};

// Which tracks a layer applies: only the named bones / parts / parameters (an empty list: all of that kind).
class AnimMask {
public:
	// False: a name the model does not have (error says which).
	bool Make(const Model &model, const std::vector<std::string> &bones, const std::vector<std::string> &parts,
	          const std::vector<std::string> &params, std::string &error);
	const UgoAnimMask *Core() const { return made_ ? core_.get() : nullptr; }

private:
	std::vector<uint8_t> bones_, parts_, params_;
	std::shared_ptr<UgoAnimMask> core_;
	bool made_ = false;
};

// One character's state: parameters, animation time, physics. The model must outlive it.
class Instance {
public:
	explicit Instance(const Model &model);
	bool IsValid() const { return in_ != nullptr; }
	UgoInstance *Core() const { return in_; }

	void ResetParams();
	void SetParam(int i, float value);
	float GetParam(int i) const;
	void ApplyAnimation(int anim, float time, float weight);
	// layers: additive adds the animation's change from the rest pose; a mask applies only some tracks
	void ApplyAnimation(int anim, float time, float weight, bool additive, const AnimMask *mask);
	// expressions (after the animations and SetParam, before Update)
	void ApplyExpression(int expr, float weight);
	void ApplyParams(const std::vector<int> &index, const std::vector<uint32_t> &ops, const std::vector<float> &values, float weight);
	// wind on the swaying chains: model pixels/s² (y down), gust 0 steady; stays until set again
	void SetWind(float x, float y, float gust);
	// placement in model pixels: (x, y) -> (a·x + c·y + tx, b·x + d·y + ty)
	void SetTransform(float a, float b, float c, float d, float tx, float ty);
	void Update(float dt);
	const float *Frame() const;
	// after Update: the part drawn in front at (x, y) model pixels, or -1; a box sure to hold every vertex
	int PickPart(float x, float y, float minOpacity = 0.01f) const;
	// after Update: of the hit areas, the one in front at (x, y) (its part), or -1
	int PickArea(float x, float y) const;
	// after Update: the box around a part (-1: every part drawn), model pixels. False: nothing.
	bool Bounds(int part, float box[4]) const;
	// after Update: the bone's world matrix in model pixels (a, b, c, d, tx, ty), before the placement
	bool BoneWorld(int bone, float world[6]) const;
	// after Update: turns the bone and up to count - 1 of its parents so its tip reaches (x, y). Update again to see it.
	float SolveIK(int bone, int count, float x, float y, int iterations = 16);
	bool BoundsEstimate(float box[4]);
	// after Update (models with a draw order): a value that changes with the order (0: stored), and the order
	uint32_t DrawOrderKey() const;
	const uint32_t *DrawOrder() const;

private:
	const Model &model_;
	AlignedBlock mem_;
	UgoInstance *in_ = nullptr;
};

} // namespace ugo9core
