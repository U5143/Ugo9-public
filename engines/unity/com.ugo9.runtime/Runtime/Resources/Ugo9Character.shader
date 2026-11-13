// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// Ugo9 for Unity: every vertex is deformed here, from the per-character frame
// blocks (one RGBAFloat texture for all characters of a draw). Same math as
// web/ugo.js. Drawn with Graphics.RenderMeshPrimitives (SV_InstanceID picks
// the character, SV_VertexID the vertex), so it does not depend on the render
// pipeline (built-in, URP). The blend function comes from the material:
// normal and add share one, multiply and screen have their own.
// UGO_MASK_PASS draws mask parts into each character's mask images, laid over
// the model's canvas (one slice per character and 4 channels), one character
// per draw; UGO_MASK_ARRAY draws every character at once, each into its own
// slice (needs the render target slice from the vertex shader).
Shader "Ugo9/Character"
{
    Properties
    {
        [HideInInspector] _SrcBlend ("", Float) = 1
        [HideInInspector] _DstBlend ("", Float) = 10
        [HideInInspector] _SrcBlendA ("", Float) = 1
        [HideInInspector] _DstBlendA ("", Float) = 10
        [HideInInspector] _BlendOp ("", Float) = 0
    }
    SubShader
    {
        Tags { "Queue" = "Transparent" "RenderType" = "Transparent" "IgnoreProjector" = "True" "PreviewType" = "Plane" }
        Pass
        {
            Blend [_SrcBlend] [_DstBlend], [_SrcBlendA] [_DstBlendA]
            BlendOp [_BlendOp]
            ZWrite Off
            Cull Off

            HLSLPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #pragma target 3.5
            // format numbers, as in core/include/ugo.h (UGO_PART_*, UGO_BLEND_*); tests/constants_test.mjs compares them
            #define UGO_PART_HIDDEN 2
            #define UGO_PART_SOLID 4
            #define UGO_BLEND_ADD 1
            #pragma multi_compile_local _ UGO_MASK_PASS UGO_MASK_ARRAY
            #pragma require setrtarrayindexfromanyshader UGO_MASK_ARRAY
            #if defined(UGO_MASK_ARRAY)
            #define UGO_MASK_PASS 1
            #endif

            float4x4 unity_MatrixVP;      // set by every render pipeline
            float4x4 _UgoObjectToWorld;   // the batch's transform
            float _UgoUnitsPerPixel;
            float4 _UgoCanvas;            // width, height, originX, originY
            float _UgoMaskFlip;           // 1 when render textures start at the top (D3D, Metal, Vulkan)

            Texture2D<float4> _UgoFrame;     // frame blocks, _UgoStride texels per character
            Texture2D<float4> _UgoVertices;  // 4 texels per vertex
            Texture2D<float4> _UgoEntries;   // (morph, dx, dy, 0)
            Texture2D<float4> _UgoXWeights;  // (bone, weight, 0, 0)
            Texture2D<float4> _UgoParts;     // 2 texels per part
            int _UgoFrameW, _UgoVertexW, _UgoEntryW, _UgoPartsW, _UgoStride, _UgoSkinT, _UgoOpF, _UgoMorphF, _UgoColorF;
            int _UgoInstanceBase, _UgoMaskGroup, _UgoMaskGroups;

            Texture2D _UgoAtlas0, _UgoAtlas1, _UgoAtlas2, _UgoAtlas3, _UgoAtlas4, _UgoAtlas5, _UgoAtlas6, _UgoAtlas7;
            SamplerState sampler_UgoAtlas0;
            Texture2DArray _UgoMask;
            SamplerState sampler_UgoMask;

            struct Attributes
            {
                float3 position : POSITION;  // model space pixels (or cells of a warp grid)
                float2 uv : TEXCOORD0;
                uint vertexID : SV_VertexID;
                uint instanceID : SV_InstanceID;
            };

            struct Varyings
            {
                float4 position : SV_POSITION;
                float2 uv : TEXCOORD0;
                float2 mask : TEXCOORD1;            // where the vertex is on the mask images (0..1 over the canvas)
                float opacity : TEXCOORD2;
                nointerpolation float4 info : TEXCOORD3;
                nointerpolation float3 x : TEXCOORD4;
                nointerpolation float3 y : TEXCOORD5;
                nointerpolation float slice : TEXCOORD6;
            #ifdef UGO_MASK_ARRAY
                uint layer : SV_RenderTargetArrayIndex;
            #endif
            };

            float4 Table(Texture2D<float4> t, int w, int i) { return t.Load(int3(i % w, i / w, 0)); }
            float4 FrameTexel(int i) { return Table(_UgoFrame, _UgoFrameW, i); }
            float FrameFloat(int baseTexel, int f)
            {
                float4 v = FrameTexel(baseTexel + (f >> 2));
                int c = f & 3;
                return c == 0 ? v.x : (c == 1 ? v.y : (c == 2 ? v.z : v.w));
            }
            float2 Skin(int baseTexel, int bone, float2 p)
            {
                int t = baseTexel + _UgoSkinT + 2 * bone;
                float4 m0 = FrameTexel(t), m1 = FrameTexel(t + 1);
                return float2(m0.x * p.x + m0.z * p.y + m1.x, m0.y * p.x + m0.w * p.y + m1.y);
            }

            // a warp grid's surface at cell coordinates p: uniform cubic B-spline over
            // the (cols+3) x (rows+3) points (2 per texel) from texel t, straight on outside
            float2 WarpPoint(int t, int k) { float4 v = FrameTexel(t + (k >> 1)); return (k & 1) == 0 ? v.xy : v.zw; }
            float4 BSpline(float t) { float s = 1.0 - t, t2 = t * t, t3 = t2 * t; return float4(s * s * s, 4.0 - 6.0 * t2 + 3.0 * t3, 1.0 + 3.0 * t + 3.0 * t2 - 3.0 * t3, t3) / 6.0; }
            float4 BSplineD(float t) { float s = 1.0 - t, t2 = t * t; return float4(-0.5 * s * s, -2.0 * t + 1.5 * t2, 0.5 + t - 1.5 * t2, 0.5 * t2); }
            float2 WarpAt(int t, float2 size, float2 p)
            {
                float2 q = clamp(p, 0.0, size), c = min(floor(q), size - 1.0), f = q - c, e = p - q;
                float4 bu = BSpline(f.x), bv = BSpline(f.y), du = BSplineD(f.x), dv = BSplineD(f.y);
                int w = (int)size.x + 3, k0 = (int)c.y * w + (int)c.x;
                float2 o = 0;
                for (int j = 0; j < 4; j++)
                    for (int i = 0; i < 4; i++)
                        o += (bu[i] * bv[j] + du[i] * bv[j] * e.x + bu[i] * dv[j] * e.y) * WarpPoint(t, k0 + j * w + i);
                return o;
            }

            Varyings vert(Attributes a)
            {
                Varyings v;
                int instance = (int)a.instanceID + _UgoInstanceBase;
                int baseTexel = instance * _UgoStride;
                int vid = (int)a.vertexID;
                float4 joints = Table(_UgoVertices, _UgoVertexW, 4 * vid);
                float4 weights = Table(_UgoVertices, _UgoVertexW, 4 * vid + 1);
                float4 info = Table(_UgoVertices, _UgoVertexW, 4 * vid + 2);
                float4 xinfo = Table(_UgoVertices, _UgoVertexW, 4 * vid + 3);
                int part = (int)info.x;
                v.info = Table(_UgoParts, _UgoPartsW, 2 * part);
                float4 warp = Table(_UgoParts, _UgoPartsW, 2 * part + 1);

                float2 p = a.position.xy;
                for (int e = 0; e < (int)info.z; e++)
                {
                    float4 en = Table(_UgoEntries, _UgoEntryW, (int)info.y + e);
                    p += FrameFloat(baseTexel, _UgoMorphF + (int)en.x) * en.yz;
                }
                float2 o = 0;
                if (warp.x > 0) o = WarpAt(baseTexel + (int)warp.x - 1, warp.yz, p); // in a warp grid: no bones
                else
                {
                    for (int j = 0; j < 4; j++) if (weights[j] > 0) o += weights[j] * Skin(baseTexel, (int)joints[j], p);
                    for (int k = 0; k < (int)xinfo.y; k++)
                    {
                        float4 xw = Table(_UgoXWeights, _UgoEntryW, (int)xinfo.x + k);
                        o += xw.y * Skin(baseTexel, (int)xw.x, p);
                    }
                }
                v.uv = a.uv;
                v.mask = (o + _UgoCanvas.zw) / _UgoCanvas.xy;
                v.slice = instance * _UgoMaskGroups;
                v.x = 1; v.y = 0;
                int bits = (int)v.info.z;
            #ifdef UGO_MASK_PASS
                v.opacity = 1; // masks ignore opacity (and hidden parts are masks too)
                float2 clip = v.mask * 2 - 1;
                if (_UgoMaskFlip > 0) clip.y = -clip.y;
                v.position = float4(clip, 0.5, 1);
            #ifdef UGO_MASK_ARRAY
                v.layer = (uint)(instance * _UgoMaskGroups + _UgoMaskGroup);
            #endif
            #else
                v.opacity = FrameFloat(baseTexel, _UgoOpF + part);
                if ((bits & UGO_PART_HIDDEN) != 0) v.opacity = 0; // hidden: only a mask
                if (v.info.w > 0)
                {
                    int c = (_UgoColorF >> 2) + 2 * ((int)v.info.w - 1);
                    v.x = FrameTexel(baseTexel + c).xyz;
                    v.y = FrameTexel(baseTexel + c + 1).xyz;
                }
                // placement (in the frame block), then pixels (y down) to units (y up)
                float4 x0 = FrameTexel(baseTexel), x1 = FrameTexel(baseTexel + 1);
                // the whole character's colour (header floats 6, 7; 0, 0 = white, opaque)
                float dark = x1.z, dr = floor(dark / 65536.0), dg = floor((dark - dr * 65536.0) / 256.0);
                float3 tint = 1.0 - float3(dr, dg, dark - dr * 65536.0 - dg * 256.0) / 255.0;
                v.x *= tint; v.y *= tint;
                v.opacity *= 1.0 - x1.w;
                float2 placed = float2(x0.x * o.x + x0.z * o.y + x1.x, x0.y * o.x + x0.w * o.y + x1.y);
                float4 world = mul(_UgoObjectToWorld, float4(placed.x * _UgoUnitsPerPixel, -placed.y * _UgoUnitsPerPixel, 0, 1));
                v.position = v.opacity > 0 ? mul(unity_MatrixVP, world) : float4(2, 2, 2, 1);
            #endif
                return v;
            }

            float4 Atlas(int i, float2 uv)
            {
                float4 c = i == 0 ? _UgoAtlas0.Sample(sampler_UgoAtlas0, uv) : i == 1 ? _UgoAtlas1.Sample(sampler_UgoAtlas0, uv)
                         : i == 2 ? _UgoAtlas2.Sample(sampler_UgoAtlas0, uv) : i == 3 ? _UgoAtlas3.Sample(sampler_UgoAtlas0, uv)
                         : i == 4 ? _UgoAtlas4.Sample(sampler_UgoAtlas0, uv) : i == 5 ? _UgoAtlas5.Sample(sampler_UgoAtlas0, uv)
                         : i == 6 ? _UgoAtlas6.Sample(sampler_UgoAtlas0, uv) : _UgoAtlas7.Sample(sampler_UgoAtlas0, uv);
                return c; // premultiplied (UgoModel.LoadTexture)
            }

            float4 frag(Varyings v) : SV_Target
            {
                int bits = (int)v.info.z;
                float4 c = Atlas(min(bits >> 16, 7), v.uv);
            #ifdef UGO_MASK_PASS
                float a = (bits & UGO_PART_SOLID) != 0 ? 1.0 : c.a; // solid: the whole mesh
                int w = (int)v.info.x >> (4 * _UgoMaskGroup);
                return float4(w & 1, (w >> 1) & 1, (w >> 2) & 1, (w >> 3) & 1) * a;
            #else
                c.rgb = c.rgb * v.x + c.a * v.y;
                float k = v.opacity;
                int read = (int)v.info.y;
                if ((read & 32) != 0)
                {
                    int ch = read & 15;
                    float4 m = _UgoMask.Sample(sampler_UgoMask, float3(v.mask, v.slice + (ch >> 2)));
                    int cc = ch & 3;
                    float mv = cc == 0 ? m.x : (cc == 1 ? m.y : (cc == 2 ? m.z : m.w));
                    k *= (read & 16) != 0 ? 1.0 - mv : mv;
                }
                c *= k;
                if (((bits >> 8) & 255) == UGO_BLEND_ADD) c.a = 0; // add: rgb = s + d, alpha unchanged
                return c; // multiply / screen: the material's blend function does the rest
            #endif
            }
            ENDHLSL
        }
    }
}
