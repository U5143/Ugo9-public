// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// P/Invoke declarations for the Ugo9 C core (core/include/ugo.h).
// Desktop and Android load the shared library (ugo.dll, libugo.dylib,
// libugo.so); iOS and WebGL link the C sources into the player (__Internal).
using System;
using System.Runtime.InteropServices;

namespace Ugo9.Core
{
    internal static class Native
    {
#if (UNITY_IOS || UNITY_WEBGL) && !UNITY_EDITOR
        const string Lib = "__Internal";
#else
        const string Lib = "ugo";
#endif
        const CallingConvention C = CallingConvention.Cdecl;

        // model
        [DllImport(Lib, CallingConvention = C)] public static extern uint ugo_model_mem_size();
        [DllImport(Lib, CallingConvention = C)] public static extern IntPtr ugo_model_init(IntPtr mem, IntPtr data, uint size);
        // format 1.1: the memory a file needs (curve keys are expanded when loading); 0 for a broken file
        [DllImport(Lib, CallingConvention = C)] public static extern uint ugo_model_mem_size_for(IntPtr data, uint size);
        [DllImport(Lib, CallingConvention = C)] public static extern IntPtr ugo_model_init_sized(IntPtr mem, uint memSize, IntPtr data, uint size);
        [DllImport(Lib, CallingConvention = C)] public static extern int ugo_last_error();
        // format versions (1.0)
        [DllImport(Lib, CallingConvention = C)] public static extern uint ugo_version();
        [DllImport(Lib, CallingConvention = C)] public static extern uint ugo_model_format(IntPtr model);
        [DllImport(Lib, CallingConvention = C)] public static extern uint ugo_model_warnings(IntPtr model);
        [DllImport(Lib, CallingConvention = C)] public static extern uint ugo_param_count(IntPtr m);
        [DllImport(Lib, CallingConvention = C)] public static extern uint ugo_bone_count(IntPtr m);
        [DllImport(Lib, CallingConvention = C)] public static extern uint ugo_part_count(IntPtr m);
        [DllImport(Lib, CallingConvention = C)] public static extern uint ugo_vertex_count(IntPtr m);
        [DllImport(Lib, CallingConvention = C)] public static extern uint ugo_index_count(IntPtr m);
        [DllImport(Lib, CallingConvention = C)] public static extern uint ugo_morph_count(IntPtr m);
        [DllImport(Lib, CallingConvention = C)] public static extern uint ugo_entry_count(IntPtr m);
        [DllImport(Lib, CallingConvention = C)] public static extern uint ugo_animation_count(IntPtr m);
        [DllImport(Lib, CallingConvention = C)] public static extern uint ugo_texture_count(IntPtr m);
        [DllImport(Lib, CallingConvention = C)] public static extern IntPtr ugo_param_name(IntPtr m, uint i);
        [DllImport(Lib, CallingConvention = C)] public static extern float ugo_param_min(IntPtr m, uint i);
        [DllImport(Lib, CallingConvention = C)] public static extern float ugo_param_max(IntPtr m, uint i);
        [DllImport(Lib, CallingConvention = C)] public static extern float ugo_param_default(IntPtr m, uint i);
        [DllImport(Lib, CallingConvention = C)] public static extern IntPtr ugo_animation_name(IntPtr m, uint i);
        [DllImport(Lib, CallingConvention = C)] public static extern float ugo_animation_duration(IntPtr m, uint i);
        [DllImport(Lib, CallingConvention = C)] public static extern int ugo_animation_loop(IntPtr m, uint i);
        [DllImport(Lib, CallingConvention = C)] public static extern IntPtr ugo_texture_name(IntPtr m, uint i);
        [DllImport(Lib, CallingConvention = C)] public static extern IntPtr ugo_part_name(IntPtr m, uint i);
        [DllImport(Lib, CallingConvention = C)] public static extern IntPtr ugo_canvas(IntPtr m);

        // static mesh data
        [DllImport(Lib, CallingConvention = C)] public static extern IntPtr ugo_positions(IntPtr m);
        [DllImport(Lib, CallingConvention = C)] public static extern IntPtr ugo_uvs(IntPtr m);
        [DllImport(Lib, CallingConvention = C)] public static extern IntPtr ugo_joints(IntPtr m);
        [DllImport(Lib, CallingConvention = C)] public static extern IntPtr ugo_weights(IntPtr m);
        [DllImport(Lib, CallingConvention = C)] public static extern IntPtr ugo_vertex_parts(IntPtr m);
        [DllImport(Lib, CallingConvention = C)] public static extern IntPtr ugo_csr_starts(IntPtr m);
        [DllImport(Lib, CallingConvention = C)] public static extern IntPtr ugo_entries(IntPtr m);
        [DllImport(Lib, CallingConvention = C)] public static extern IntPtr ugo_indices(IntPtr m);
        [DllImport(Lib, CallingConvention = C)] public static extern uint ugo_extra_weight_count(IntPtr m);
        [DllImport(Lib, CallingConvention = C)] public static extern IntPtr ugo_extra_weight_starts(IntPtr m);
        [DllImport(Lib, CallingConvention = C)] public static extern IntPtr ugo_extra_weights(IntPtr m);
        [DllImport(Lib, CallingConvention = C)] public static extern uint ugo_part_texture(IntPtr m, uint part);
        [DllImport(Lib, CallingConvention = C)] public static extern void ugo_part_range(IntPtr m, uint part, [Out] uint[] range);

        // masks, blending, colours, warp grids
        [DllImport(Lib, CallingConvention = C)] public static extern uint ugo_part_blend(IntPtr m, uint part);
        [DllImport(Lib, CallingConvention = C)] public static extern uint ugo_part_flags(IntPtr m, uint part);
        [DllImport(Lib, CallingConvention = C)] public static extern int ugo_part_mask(IntPtr m, uint part);
        [DllImport(Lib, CallingConvention = C)] public static extern int ugo_part_color(IntPtr m, uint part);
        [DllImport(Lib, CallingConvention = C)] public static extern uint ugo_mask_count(IntPtr m);
        [DllImport(Lib, CallingConvention = C)] public static extern uint ugo_mask_channel_count(IntPtr m);
        [DllImport(Lib, CallingConvention = C)] public static extern uint ugo_mask_channel(IntPtr m, uint mask);
        [DllImport(Lib, CallingConvention = C)] public static extern IntPtr ugo_mask_parts(IntPtr m, uint mask, out uint count);
        [DllImport(Lib, CallingConvention = C)] public static extern uint ugo_warp_count(IntPtr m);
        [DllImport(Lib, CallingConvention = C)] public static extern int ugo_part_warp(IntPtr m, uint part);
        [DllImport(Lib, CallingConvention = C)] public static extern void ugo_warp_info(IntPtr m, uint warp, [Out] uint[] info);

        // frame block layout
        [DllImport(Lib, CallingConvention = C)] public static extern uint ugo_frame_float_count(IntPtr m);
        [DllImport(Lib, CallingConvention = C)] public static extern uint ugo_frame_skin_offset(IntPtr m);
        [DllImport(Lib, CallingConvention = C)] public static extern uint ugo_frame_opacity_offset(IntPtr m);
        [DllImport(Lib, CallingConvention = C)] public static extern uint ugo_frame_morph_offset(IntPtr m);
        [DllImport(Lib, CallingConvention = C)] public static extern uint ugo_frame_color_offset(IntPtr m);

        // instance
        [DllImport(Lib, CallingConvention = C)] public static extern uint ugo_instance_mem_size(IntPtr m);
        [DllImport(Lib, CallingConvention = C)] public static extern IntPtr ugo_instance_init(IntPtr mem, IntPtr m);
        [DllImport(Lib, CallingConvention = C)] public static extern void ugo_reset_params(IntPtr inst);
        [DllImport(Lib, CallingConvention = C)] public static extern void ugo_set_param(IntPtr inst, uint i, float value);
        [DllImport(Lib, CallingConvention = C)] public static extern float ugo_get_param(IntPtr inst, uint i);
        [DllImport(Lib, CallingConvention = C)] public static extern void ugo_apply_animation(IntPtr inst, uint anim, float time, float weight);
        [DllImport(Lib, CallingConvention = C)] public static extern void ugo_update(IntPtr inst, float dt);
        [DllImport(Lib, CallingConvention = C)] public static extern void ugo_reset_physics(IntPtr inst);
        [DllImport(Lib, CallingConvention = C)] public static extern void ugo_set_transform(IntPtr inst, float a, float b, float c, float d, float tx, float ty);
        [DllImport(Lib, CallingConvention = C)] public static extern IntPtr ugo_frame(IntPtr inst);
        // expressions (format 0.8)
        [DllImport(Lib, CallingConvention = C)] public static extern uint ugo_expression_count(IntPtr model);
        [DllImport(Lib, CallingConvention = C)] public static extern IntPtr ugo_expression_name(IntPtr model, uint expr);
        [DllImport(Lib, CallingConvention = C)] public static extern void ugo_expression_fade(IntPtr model, uint expr, [Out] float[] fade);
        [DllImport(Lib, CallingConvention = C)] public static extern void ugo_apply_expression(IntPtr inst, uint expr, float weight);
        [DllImport(Lib, CallingConvention = C)] public static extern uint ugo_resolve_params(IntPtr model, IntPtr[] names, uint n, [Out] int[] outIndex);
        [DllImport(Lib, CallingConvention = C)] public static extern void ugo_apply_params(IntPtr inst, int[] index, uint[] ops, float[] values, uint n, float weight);
        // draw order (format 0.8)
        [DllImport(Lib, CallingConvention = C)] public static extern int ugo_has_draw_order(IntPtr model);
        [DllImport(Lib, CallingConvention = C)] public static extern IntPtr ugo_draw_order(IntPtr inst);
        [DllImport(Lib, CallingConvention = C)] public static extern uint ugo_draw_order_key(IntPtr inst);
        // layers (1.1): an animation added on top, or only on some bones / parts / parameters
        [DllImport(Lib, CallingConvention = C)] public static extern IntPtr ugo_bone_name(IntPtr m, uint i);
        [DllImport(Lib, CallingConvention = C)] public static extern uint ugo_constraint_count(IntPtr m);
        [DllImport(Lib, CallingConvention = C)] public static extern uint ugo_color_count(IntPtr m);
        [DllImport(Lib, CallingConvention = C)] public static extern void ugo_apply_animation_ex(IntPtr inst, uint anim, float time, float weight, uint flags, IntPtr mask);
        // picking and bounds (1.1)
        [DllImport(Lib, CallingConvention = C)] public static extern void ugo_deform_cpu(IntPtr inst, [Out] float[] positions);
        [DllImport(Lib, CallingConvention = C)] public static extern int ugo_pick_part(IntPtr inst, float[] deformed, float x, float y, float minOpacity);
        [DllImport(Lib, CallingConvention = C)] public static extern int ugo_bounds(IntPtr inst, float[] deformed, int part, [Out] float[] box);
        [DllImport(Lib, CallingConvention = C)] public static extern int ugo_pick_area(IntPtr inst, float[] deformed, float x, float y, byte[] only);
        [DllImport(Lib, CallingConvention = C)] public static extern int ugo_bounds_estimate(IntPtr inst, [Out] float[] box);
        // wind on the swaying chains, bones in the world, reaching for a point (1.1)
        [DllImport(Lib, CallingConvention = C)] public static extern void ugo_set_wind(IntPtr inst, float x, float y, float gust);
        [DllImport(Lib, CallingConvention = C)] public static extern void ugo_bone_world(IntPtr inst, uint bone, [Out] float[] world);
        [DllImport(Lib, CallingConvention = C)] public static extern float ugo_solve_ik_to(IntPtr inst, uint bone, uint count, float x, float y, uint iterations);
    }
}
