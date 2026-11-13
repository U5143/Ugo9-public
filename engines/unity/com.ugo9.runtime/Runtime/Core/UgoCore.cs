// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// Engine-independent wrappers around the C core: a loaded model (and the
// tables the GPU reads, built once) and a character instance. No UnityEngine
// here, so this part also runs under plain .NET (tests/unity_core_test).
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

namespace Ugo9.Core
{
    public enum BlendClass { Normal = 0, Multiply = 1, Screen = 2 } // normal and add share one draw

    /// <summary>A run of drawn parts that share a blend class, in draw order.</summary>
    public struct Run
    {
        public BlendClass Blend;
        public int[] Indices;
    }

    /// <summary>The tables the shader reads (see web/ugo.js and engines/godot/shaders/ugo9.gdshader).</summary>
    public sealed class GpuTables
    {
        public const int VertexW = 1024, EntryW = 2048, PartsW = 1024, FrameW = 1024;
        public float[] Positions;   // 2 per vertex (model space, or cells of a warp grid)
        public float[] Uvs;         // 2 per vertex (v = 0 at the image's top row, as in .ug9)
        public float[] TextureUvs;  // the same for Unity's textures, whose rows start at the bottom (v flipped)
        public float[] Vertices;    // 4 texels per vertex: joints, weights, (part, first entry, count, 0), (first extra weight, count, 0, 0)
        public float[] Entries;     // (morph, dx, dy, 0)
        public float[] XWeights;    // (bone, weight, 0, 0)
        public float[] Parts;       // 2 texels per part: (mask channels written, mask read, flags + blend*256 + texture*65536, colour slot + 1),
                                    // (warp points' first frame texel + 1 or 0, cols, rows, 0)
        public List<Run> Runs = new List<Run>();
        public int[] MaskIndices;   // the mask parts' triangles
        public int MaskChannels;
        public int TextureCount;
        public float MinX, MinY, MaxX, MaxY; // rest-pose bounds with the canvas, unpadded

        /// <summary>Rows needed for a texture of this many RGBA texels in rows of width.</summary>
        public static int Rows(int texels, int width) => Math.Max(1, (texels + width - 1) / width);
    }

    public sealed class UgoModelData : IDisposable
    {
        // format numbers, as in core/include/ugo.h (UGO_PART_*, UGO_BLEND_*); tests/constants_test.mjs compares them
        public const uint PartMaskInvert = 1, PartHidden = 2, PartSolid = 4;
        public const uint BlendNormal = 0, BlendAdd = 1, BlendMultiply = 2, BlendScreen = 3;
        public const uint ExprSet = 0, ExprAdd = 1, ExprMultiply = 2;

        IntPtr data_, mem_, model_;
        GpuTables tables_;

        public IntPtr Handle => model_;
        public readonly int ParameterCount, BoneCount, PartCount, VertexCount, IndexCount, MorphCount, AnimationCount, TextureCount;
        public readonly int FrameFloats, SkinOffset, OpacityOffset, MorphOffset, ColorOffset;
        public readonly float CanvasWidth, CanvasHeight, OriginX, OriginY;
        public readonly string[] ParameterNames, AnimationNames, TextureNames, PartNames, ExpressionNames, BoneNames;

        static IntPtr Aligned(IntPtr raw) => new IntPtr((raw.ToInt64() + 15) & ~15L);

        public const int ErrVersion = 3;                              // UGO_ERR_VERSION
        public const uint WarnSkippedTable = 1, WarnSkippedTracks = 2; // UGO_WARN_*
        /// <summary>What this core skipped in a file from a later 1.x (WarnSkipped*; 0: nothing).</summary>
        public readonly uint Warnings;
        /// <summary>The file's format version.</summary>
        public readonly int FormatMajor, FormatMinor;
        /// <summary>The format this core reads (major).</summary>
        public static int CoreMajor => (int)(Native.ugo_version() >> 16);

        /// <summary>A warning to show when Warnings is not 0 (null otherwise).</summary>
        public string WarningText
        {
            get
            {
                if (Warnings == 0) return null;
                string what = (Warnings & WarnSkippedTable) != 0 && (Warnings & WarnSkippedTracks) != 0 ? "tables and animation tracks"
                    : (Warnings & WarnSkippedTable) != 0 ? "tables" : "animation tracks";
                uint v = Native.ugo_version();
                return $"Ugo9: this .ug9 is format {FormatMajor}.{FormatMinor}, newer than this plugin ({v >> 16}.{v & 0xffff}): it skipped {what} it does not know, so the picture may differ. Update the Ugo9 plugin.";
            }
        }

        // why a file could not be read, and what to do (as web/ugo.js says it)
        static string LoadError(int error, byte[] b)
        {
            if (error == ErrVersion && b.Length >= 8)
            {
                int major = b[4] | (b[5] << 8), minor = b[6] | (b[7] << 8), reads = CoreMajor;
                return major == reads ? $"Ugo9: this .ug9 (format {major}.{minor}) uses something this plugin does not know: update the Ugo9 plugin"
                    : major < reads ? $"Ugo9: this .ug9 is format {major}.{minor}, but this plugin reads {reads}.x: compile it again from its authoring JSON"
                    : $"Ugo9: this .ug9 is format {major}.{minor}, but this plugin reads {reads}.x: update the Ugo9 plugin";
            }
            return $"Ugo9: not a valid .ug9 file (error {error})";
        }

        /// <summary>Validates and loads .ug9 bytes (safe on hostile input).</summary>
        public UgoModelData(byte[] bytes)
        {
            if (bytes == null || bytes.Length == 0) throw new ArgumentException("Ugo9: empty .ug9 data");
            data_ = Marshal.AllocHGlobal(bytes.Length + 16);
            Marshal.Copy(bytes, 0, Aligned(data_), bytes.Length);
            // the memory this file needs (format 1.1 expands curve keys when loading); 0: it cannot be read
            uint need = Native.ugo_model_mem_size_for(Aligned(data_), (uint)bytes.Length);
            if (need != 0)
            {
                mem_ = Marshal.AllocHGlobal((int)need + 16);
                model_ = Native.ugo_model_init_sized(Aligned(mem_), need, Aligned(data_), (uint)bytes.Length);
            }
            if (model_ == IntPtr.Zero)
            {
                int error = Native.ugo_last_error();
                Dispose();
                throw new FormatException(LoadError(error, bytes));
            }
            Warnings = Native.ugo_model_warnings(model_);
            uint format = Native.ugo_model_format(model_);
            FormatMajor = (int)(format >> 16);
            FormatMinor = (int)(format & 0xffff);
            ParameterCount = (int)Native.ugo_param_count(model_);
            BoneCount = (int)Native.ugo_bone_count(model_);
            PartCount = (int)Native.ugo_part_count(model_);
            VertexCount = (int)Native.ugo_vertex_count(model_);
            IndexCount = (int)Native.ugo_index_count(model_);
            MorphCount = (int)Native.ugo_morph_count(model_);
            AnimationCount = (int)Native.ugo_animation_count(model_);
            TextureCount = (int)Native.ugo_texture_count(model_);
            FrameFloats = (int)Native.ugo_frame_float_count(model_);
            SkinOffset = (int)Native.ugo_frame_skin_offset(model_);
            OpacityOffset = (int)Native.ugo_frame_opacity_offset(model_);
            MorphOffset = (int)Native.ugo_frame_morph_offset(model_);
            ColorOffset = (int)Native.ugo_frame_color_offset(model_);
            var canvas = Floats(Native.ugo_canvas(model_), 4);
            CanvasWidth = canvas[0]; CanvasHeight = canvas[1]; OriginX = canvas[2]; OriginY = canvas[3];
            ParameterNames = Names(ParameterCount, Native.ugo_param_name);
            AnimationNames = Names(AnimationCount, Native.ugo_animation_name);
            TextureNames = Names(TextureCount, Native.ugo_texture_name);
            PartNames = Names(PartCount, Native.ugo_part_name);
            ExpressionNames = Names((int)Native.ugo_expression_count(model_), Native.ugo_expression_name);
            BoneNames = Names(BoneCount, Native.ugo_bone_name);
            // hit areas: parts named "hit:<name>" or "当たり:<name>" (full-width colon too)
            var areas = new List<string>();
            AreaMask = new byte[Math.Max(1, PartCount)];
            AreaOfPart = new string[PartCount];
            for (int i = 0; i < PartCount; i++)
            {
                string n = PartNames[i], area = null;
                foreach (var pre in new[] { "hit:", "当たり:", "当たり：" }) if (n.StartsWith(pre, StringComparison.Ordinal)) area = n.Substring(pre.Length);
                if (area == null) continue;
                AreaMask[i] = 1;
                AreaOfPart[i] = area;
                if (!areas.Contains(area)) areas.Add(area);
            }
            AreaNames = areas.ToArray();
        }

        /// <summary>The hit areas' names (parts named "hit:head" give "head"), and per part: 1 for an area part / its area's name.</summary>
        public readonly string[] AreaNames;
        public readonly byte[] AreaMask;
        public readonly string[] AreaOfPart;
        public int FindBone(string name) => Array.IndexOf(BoneNames, name);

        /// <summary>
        /// A mask for a layer: only these bones, parts and parameters (by name) take the animation. A list left
        /// null takes all of its kind; an empty one takes none. Morphs, constraints and colours: all, or none (false).
        /// Throws for a name the model does not have.
        /// </summary>
        public UgoAnimMask MakeMask(string[] bones = null, string[] parts = null, string[] parameters = null,
                                    bool morphs = true, bool constraints = true, bool colors = true)
            => new UgoAnimMask(this, bones, parts, parameters, morphs, constraints, colors);

        string[] Names(int n, Func<IntPtr, uint, IntPtr> get)
        {
            var names = new string[n];
            for (int i = 0; i < n; i++) names[i] = Utf8(get(model_, (uint)i));
            return names;
        }

        static string Utf8(IntPtr p)
        {
            if (p == IntPtr.Zero) return "";
            int len = 0;
            while (Marshal.ReadByte(p, len) != 0) len++;
            var buf = new byte[len];
            Marshal.Copy(p, buf, 0, len);
            return System.Text.Encoding.UTF8.GetString(buf);
        }

        static float[] Floats(IntPtr p, int n) { var a = new float[n]; if (n > 0) Marshal.Copy(p, a, 0, n); return a; }
        static int[] Ints(IntPtr p, int n) { var a = new int[n]; if (n > 0) Marshal.Copy(p, a, 0, n); return a; }
        static short[] Shorts(IntPtr p, int n) { var a = new short[n]; if (n > 0) Marshal.Copy(p, a, 0, n); return a; }

        public int FindParameter(string name) => Array.IndexOf(ParameterNames, name);
        /// <summary>The model's expression with this name, or -1 (format 0.8).</summary>
        public int FindExpression(string name) => Array.IndexOf(ExpressionNames, name);
        /// <summary>The expression's stored fade-in and fade-out times (seconds).</summary>
        public (float fadeIn, float fadeOut) ExpressionFade(int expr)
        {
            var f = new float[2];
            if (expr >= 0 && expr < ExpressionNames.Length) Native.ugo_expression_fade(model_, (uint)expr, f);
            return (f[0], f[1]);
        }
        /// <summary>Parameter names to the model's numbers (-1 where it has none). Returns how many were missing.</summary>
        public int ResolveParams(string[] names, int[] index)
        {
            var ptrs = new IntPtr[names.Length];
            try
            {
                for (int i = 0; i < names.Length; i++)
                {
                    var b = System.Text.Encoding.UTF8.GetBytes(names[i] + "\0");
                    ptrs[i] = Marshal.AllocHGlobal(b.Length);
                    Marshal.Copy(b, 0, ptrs[i], b.Length);
                }
                return (int)Native.ugo_resolve_params(model_, ptrs, (uint)names.Length, index);
            }
            finally { foreach (var p in ptrs) if (p != IntPtr.Zero) Marshal.FreeHGlobal(p); }
        }
        public int FindAnimation(string name) => Array.IndexOf(AnimationNames, name);
        public float ParameterMin(int i) => Native.ugo_param_min(model_, (uint)i);
        public float ParameterMax(int i) => Native.ugo_param_max(model_, (uint)i);
        public float ParameterDefault(int i) => Native.ugo_param_default(model_, (uint)i);
        public float AnimationDuration(int i) => Native.ugo_animation_duration(model_, (uint)i);
        public bool AnimationLoops(int i) => Native.ugo_animation_loop(model_, (uint)i) != 0;

        /// <summary>The tables for the GPU, built on first use.</summary>
        public GpuTables Tables => tables_ ?? (tables_ = BuildTables());

        GpuTables BuildTables()
        {
            var m = model_;
            int nv = VertexCount, np = PartCount, ne = (int)Native.ugo_entry_count(m), nx = (int)Native.ugo_extra_weight_count(m);
            var t = new GpuTables();
            t.Positions = Floats(Native.ugo_positions(m), 2 * nv);
            t.Uvs = Floats(Native.ugo_uvs(m), 2 * nv);
            t.TextureUvs = new float[2 * nv];
            for (int i = 0; i < nv; i++) { t.TextureUvs[2 * i] = t.Uvs[2 * i]; t.TextureUvs[2 * i + 1] = 1 - t.Uvs[2 * i + 1]; }
            var joints = Shorts(Native.ugo_joints(m), 4 * nv);
            var weights = Floats(Native.ugo_weights(m), 4 * nv);
            var parts = Ints(Native.ugo_vertex_parts(m), nv);
            var csr = Ints(Native.ugo_csr_starts(m), nv + 1);
            var xs = Ints(Native.ugo_extra_weight_starts(m), nv + 1);
            var indices = Ints(Native.ugo_indices(m), IndexCount);

            t.MinX = -OriginX; t.MinY = -OriginY; t.MaxX = CanvasWidth - OriginX; t.MaxY = CanvasHeight - OriginY;
            t.Vertices = new float[16 * nv];
            for (int i = 0; i < nv; i++)
            {
                for (int j = 0; j < 4; j++)
                {
                    t.Vertices[16 * i + j] = (ushort)joints[4 * i + j];
                    t.Vertices[16 * i + 4 + j] = weights[4 * i + j];
                }
                t.Vertices[16 * i + 8] = parts[i];
                t.Vertices[16 * i + 9] = csr[i];
                t.Vertices[16 * i + 10] = csr[i + 1] - csr[i];
                t.Vertices[16 * i + 12] = xs[i];
                t.Vertices[16 * i + 13] = xs[i + 1] - xs[i];
                float x = t.Positions[2 * i], y = t.Positions[2 * i + 1];
                t.MinX = Math.Min(t.MinX, x); t.MaxX = Math.Max(t.MaxX, x);
                t.MinY = Math.Min(t.MinY, y); t.MaxY = Math.Max(t.MaxY, y);
            }

            var raw = Ints(Native.ugo_entries(m), 3 * ne); // morph as u32 bits, dx, dy as float bits
            t.Entries = new float[4 * ne];
            for (int i = 0; i < ne; i++)
            {
                t.Entries[4 * i] = raw[3 * i];
                t.Entries[4 * i + 1] = BitConverter.Int32BitsToSingle(raw[3 * i + 1]);
                t.Entries[4 * i + 2] = BitConverter.Int32BitsToSingle(raw[3 * i + 2]);
            }
            var xraw = Ints(Native.ugo_extra_weights(m), 2 * nx);
            t.XWeights = new float[4 * nx];
            for (int i = 0; i < nx; i++)
            {
                t.XWeights[4 * i] = xraw[2 * i];
                t.XWeights[4 * i + 1] = BitConverter.Int32BitsToSingle(xraw[2 * i + 1]);
            }

            // masks: which channels each part writes
            int nmask = (int)Native.ugo_mask_count(m);
            var written = new int[np];
            var isMask = new bool[np];
            for (int k = 0; k < nmask; k++)
            {
                var list = Ints(Native.ugo_mask_parts(m, (uint)k, out uint count), (int)count);
                foreach (int p in list) { written[p] |= 1 << (int)Native.ugo_mask_channel(m, (uint)k); isMask[p] = true; }
            }
            t.MaskChannels = (int)Native.ugo_mask_channel_count(m);
            t.TextureCount = Math.Max(1, TextureCount);

            t.Parts = new float[8 * np];
            var range = new uint[4];
            var info = new uint[3];
            var maskIdx = new List<int>();
            for (int i = 0; i < np; i++)
            {
                uint flags = Native.ugo_part_flags(m, (uint)i), blend = Native.ugo_part_blend(m, (uint)i);
                int mask = Native.ugo_part_mask(m, (uint)i), warp = Native.ugo_part_warp(m, (uint)i);
                int tex = Math.Min((int)Native.ugo_part_texture(m, (uint)i), t.TextureCount - 1);
                t.Parts[8 * i] = written[i];
                if (mask >= 0) t.Parts[8 * i + 1] = Native.ugo_mask_channel(m, (uint)mask) | ((flags & PartMaskInvert) != 0 ? 16u : 0u) | 32u;
                t.Parts[8 * i + 2] = flags | (blend << 8) | ((uint)tex << 16);
                t.Parts[8 * i + 3] = Native.ugo_part_color(m, (uint)i) + 1;
                if (warp >= 0)
                {
                    Native.ugo_warp_info(m, (uint)warp, info); // cols, rows, offset of its points (floats)
                    t.Parts[8 * i + 4] = info[2] / 4 + 1;
                    t.Parts[8 * i + 5] = info[0];
                    t.Parts[8 * i + 6] = info[1];
                }

                // triangles of every mask part (the drawn parts' runs: RunsFor)
                Native.ugo_part_range(m, (uint)i, range);
                if (isMask[i]) for (uint k = 0; k < range[3]; k++) maskIdx.Add(indices[range[2] + k]);
            }
            t.MaskIndices = maskIdx.ToArray();
            indices_ = indices;
            t.Runs = RunsFor(null);
            return t;
        }

        int[] indices_;

        /// <summary>True when the parts' draw order can change (format 0.8): draw each character with RunsFor(its DrawOrder).</summary>
        public bool HasDrawOrder => Native.ugo_has_draw_order(model_) != 0;

        /// <summary>Runs of drawn parts that share a blend class, with the parts in this order (part numbers; null: the stored order).</summary>
        public List<Run> RunsFor(uint[] order)
        {
            if (indices_ == null) { var _ = Tables; } // builds indices_
            var runs = new List<Run>();
            var range = new uint[4];
            int np = PartCount;
            for (int j = 0; j < np; j++)
            {
                uint i = order != null ? order[j] : (uint)j;
                Native.ugo_part_range(model_, i, range);
                if (range[3] == 0 || (Native.ugo_part_flags(model_, i) & PartHidden) != 0) continue;
                uint blend = Native.ugo_part_blend(model_, i);
                var cls = blend == BlendMultiply ? BlendClass.Multiply : blend == BlendScreen ? BlendClass.Screen : BlendClass.Normal;
                if (runs.Count == 0 || runs[runs.Count - 1].Blend != cls) runs.Add(new Run { Blend = cls, Indices = Array.Empty<int>() });
                var last = runs[runs.Count - 1];
                int at = last.Indices.Length;
                Array.Resize(ref last.Indices, at + (int)range[3]);
                Array.Copy(indices_, range[2], last.Indices, at, range[3]);
                runs[runs.Count - 1] = last;
            }
            return runs;
        }

        public void Dispose()
        {
            model_ = IntPtr.Zero;
            if (mem_ != IntPtr.Zero) { Marshal.FreeHGlobal(mem_); mem_ = IntPtr.Zero; }
            if (data_ != IntPtr.Zero) { Marshal.FreeHGlobal(data_); data_ = IntPtr.Zero; }
        }
    }

    /// <summary>One character: parameters, animation, physics, and its frame block.</summary>
    /// <summary>Which tracks a layer applies (UgoModelData.MakeMask): one byte per bone / part / parameter / ..., in unmanaged memory.</summary>
    public sealed class UgoAnimMask : IDisposable
    {
        IntPtr mem_;
        public IntPtr Handle => mem_;
        public readonly UgoModelData Model;

        internal UgoAnimMask(UgoModelData m, string[] bones, string[] parts, string[] parameters, bool morphs, bool constraints, bool colors)
        {
            Model = m;
            int nc = (int)Native.ugo_constraint_count(m.Handle), nk = (int)Native.ugo_color_count(m.Handle);
            var lists = new byte[][]
            {
                Bytes(bones, m.BoneNames, "bone"), Bytes(parts, m.PartNames, "part"), Bytes(parameters, m.ParameterNames, "parameter"),
                morphs ? null : new byte[Math.Max(1, m.MorphCount)], constraints ? null : new byte[Math.Max(1, nc)], colors ? null : new byte[Math.Max(1, nk)],
            };
            int head = IntPtr.Size * 6, size = head;
            foreach (var l in lists) if (l != null) size += l.Length;
            mem_ = Marshal.AllocHGlobal(size);
            int at = head;
            for (int k = 0; k < 6; k++)
            {
                IntPtr p = IntPtr.Zero;
                if (lists[k] != null) { p = new IntPtr(mem_.ToInt64() + at); Marshal.Copy(lists[k], 0, p, lists[k].Length); at += lists[k].Length; }
                Marshal.WriteIntPtr(mem_, k * IntPtr.Size, p);
            }
        }

        static byte[] Bytes(string[] names, string[] all, string kind)
        {
            if (names == null) return null;
            var b = new byte[Math.Max(1, all.Length)];
            foreach (var n in names)
            {
                int i = Array.IndexOf(all, n);
                if (i < 0) throw new ArgumentException($"Ugo9: the mask names the {kind} \"{n}\", which the model does not have");
                b[i] = 1;
            }
            return b;
        }

        public void Dispose() { if (mem_ != IntPtr.Zero) { Marshal.FreeHGlobal(mem_); mem_ = IntPtr.Zero; } }
        ~UgoAnimMask() => Dispose();
    }

    public sealed class UgoInstanceData : IDisposable
    {
        readonly UgoModelData model_;
        IntPtr mem_, inst_;

        public UgoModelData Model => model_;

        public UgoInstanceData(UgoModelData model)
        {
            model_ = model;
            mem_ = Marshal.AllocHGlobal((int)Native.ugo_instance_mem_size(model.Handle) + 16);
            inst_ = Native.ugo_instance_init(new IntPtr((mem_.ToInt64() + 15) & ~15L), model.Handle);
        }

        public void ResetParams() => Native.ugo_reset_params(inst_);
        public void SetParam(int i, float value) { if (i >= 0) Native.ugo_set_param(inst_, (uint)i, value); }
        public float GetParam(int i) => i >= 0 ? Native.ugo_get_param(inst_, (uint)i) : 0f;
        public void ApplyAnimation(int anim, float time, float weight) { if (anim >= 0) Native.ugo_apply_animation(inst_, (uint)anim, time, weight); }
        /// <summary>The same with choices (layers): additive adds the animation's change from the rest pose; a mask applies only some tracks.</summary>
        public void ApplyAnimation(int anim, float time, float weight, bool additive, UgoAnimMask mask)
        {
            if (anim >= 0) Native.ugo_apply_animation_ex(inst_, (uint)anim, time, weight, additive ? 1u : 0u, mask?.Handle ?? IntPtr.Zero);
        }
        public void Update(float dt) => Native.ugo_update(inst_, dt);

        // ---- picking and boxes: the core places only the vertices it needs (deformed = NULL) ----
        readonly float[] box_ = new float[4];

        /// <summary>
        /// After Update: the part drawn in front at (x, y) in model pixels (y down), or -1. Follows the draw order
        /// and masks, skips hidden parts and parts at minOpacity or below; the texture's transparent pixels count as covered.
        /// </summary>
        public int PickPart(float x, float y, float minOpacity = 0.01f) => Native.ugo_pick_part(inst_, null, x, y, minOpacity);

        /// <summary>After Update: of the hit areas in only (one byte per part, UgoModelData.AreaMask), the one in front at (x, y), or -1.</summary>
        public int PickArea(float x, float y, byte[] only) => Native.ugo_pick_area(inst_, null, x, y, only);

        /// <summary>After Update: a box (model pixels) sure to hold every vertex, without placing them (for culling). False: nothing.</summary>
        public bool BoundsEstimate(out float x0, out float y0, out float x1, out float y1)
        {
            bool ok = Native.ugo_bounds_estimate(inst_, box_) != 0;
            x0 = box_[0]; y0 = box_[1]; x1 = box_[2]; y1 = box_[3];
            return ok;
        }

        /// <summary>Wind on the swaying chains: model pixels/s² (y down), gust 0 steady. Stays until set again.</summary>
        public void SetWind(float x, float y, float gust) => Native.ugo_set_wind(inst_, x, y, gust);

        /// <summary>After Update: the bone's world matrix in model pixels (a, b, c, d, tx, ty), before the placement.</summary>
        public void BoneWorld(int bone, float[] world6) { if (bone >= 0) Native.ugo_bone_world(inst_, (uint)bone, world6); }

        /// <summary>
        /// After Update: turns the bone and up to count - 1 of its parents so its tip reaches (x, y) in model pixels.
        /// Update again to see it. Returns the distance left (-1: a bad call).
        /// </summary>
        public float SolveIK(int bone, int count, float x, float y, int iterations = 16)
            => bone >= 0 && count > 0 ? Native.ugo_solve_ik_to(inst_, (uint)bone, (uint)count, x, y, (uint)iterations) : -1;

        /// <summary>After Update: the box (x0, y0, x1, y1, model pixels) around a part, or (part -1) every part drawn. False: nothing.</summary>
        public bool Bounds(int part, out float x0, out float y0, out float x1, out float y1)
        {
            bool ok = Native.ugo_bounds(inst_, null, part, box_) != 0;
            x0 = box_[0]; y0 = box_[1]; x1 = box_[2]; y1 = box_[3];
            return ok;
        }
        public void ResetPhysics() => Native.ugo_reset_physics(inst_);
        /// <summary>Placement in model pixels (x right, y down): (x, y) → (a·x + c·y + tx, b·x + d·y + ty).</summary>
        public void SetTransform(float a, float b, float c, float d, float tx, float ty) => Native.ugo_set_transform(inst_, a, b, c, d, tx, ty);
        /// <summary>Copies the frame block (FrameFloats floats) into dst at offset.</summary>
        public void CopyFrame(float[] dst, int offset) => Marshal.Copy(Native.ugo_frame(inst_), dst, offset, model_.FrameFloats);

        /// <summary>
        /// Writes a whole-character colour into a copied frame block: the header's floats 6 and 7, which the
        /// core leaves at 0 (= white, opaque). Float 6 is how much darker each channel is, 8 bits each
        /// ((255-r)*65536 + (255-g)*256 + (255-b), exact in a float); float 7 is 1 - alpha. The shaders
        /// multiply every part's final colour (and opacity) by it.
        /// </summary>
        public static void WriteTint(float[] frame, int offset, float r, float g, float b, float a)
        {
            int Dark(float v) => (int)Math.Round((1 - Math.Max(0, Math.Min(1, v))) * 255);
            frame[offset + 6] = Dark(r) * 65536 + Dark(g) * 256 + Dark(b);
            frame[offset + 7] = 1 - Math.Max(0, Math.Min(1, a));
        }
        /// <summary>Applies the model's expression at a weight (0..1): after the animations and SetParam, before Update.</summary>
        public void ApplyExpression(int expr, float weight) { if (expr >= 0) Native.ugo_apply_expression(inst_, (uint)expr, weight); }
        /// <summary>Applies resolved expression items (UgoModelData.ResolveParams; ops: ExprSet, ExprAdd, ExprMultiply).</summary>
        public void ApplyParams(int[] index, uint[] ops, float[] values, float weight) => Native.ugo_apply_params(inst_, index, ops, values, (uint)index.Length, weight);
        /// <summary>After Update: 0 while the parts are drawn in their stored order, else a value that changes with the order (format 0.8).</summary>
        public uint DrawOrderKey => Native.ugo_draw_order_key(inst_);
        /// <summary>After Update: the part numbers in drawing order, into dst (PartCount of them).</summary>
        public void CopyDrawOrder(uint[] dst)
        {
            var tmp = new int[model_.PartCount];
            Marshal.Copy(Native.ugo_draw_order(inst_), tmp, 0, tmp.Length);
            for (int i = 0; i < tmp.Length; i++) dst[i] = (uint)tmp[i];
        }

        public void Dispose()
        {
            inst_ = IntPtr.Zero;
            if (mem_ != IntPtr.Zero) { Marshal.FreeHGlobal(mem_); mem_ = IntPtr.Zero; }
        }
    }
}
