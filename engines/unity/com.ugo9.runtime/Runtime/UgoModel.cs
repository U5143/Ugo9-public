// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// UgoModel: a .ug9 file and its textures, shared by every character that uses
// it. Made by the .ug9 importer (drop the file and its PNGs into the project),
// or at run time with UgoModel.FromBytes.
using System;
using System.Collections.Generic;
using UnityEngine;
using UnityEngine.Rendering;
using Ugo9.Core;

namespace Ugo9
{
    [CreateAssetMenu(menuName = "Ugo9/Model")]
    public sealed class UgoModel : ScriptableObject
    {
        [SerializeField, HideInInspector] byte[] bytes;
        [Tooltip("One per texture of the model, in its order (the PNGs next to the .ug9), with premultiplied alpha (see LoadTexture).")]
        public Texture2D[] textures = Array.Empty<Texture2D>();
        [Tooltip("Model pixels per Unity unit.")]
        public float pixelsPerUnit = 100;

        [NonSerialized] UgoModelData data_;
        [NonSerialized] UgoGpuModel gpu_;

        public static UgoModel FromBytes(byte[] ugo, Texture2D[] textures, float pixelsPerUnit = 100)
        {
            var m = CreateInstance<UgoModel>();
            m.SetBytes(ugo);
            m.textures = textures ?? Array.Empty<Texture2D>();
            m.pixelsPerUnit = pixelsPerUnit;
            return m;
        }

        /// <summary>
        /// A model texture from a PNG's bytes: premultiplied alpha (as the shader reads it; filtering
        /// straight alpha would darken the edges), mipmaps, no compression. The importer makes the
        /// .ug9's textures this way; use it for textures given to FromBytes.
        /// </summary>
        public static Texture2D LoadTexture(byte[] png, string name = "", bool pixelArt = false)
        {
            // pixelArt: read texel by texel (Point, no mipmaps), as the core's and the Web runtime's nearest sampling
            var t = new Texture2D(2, 2, TextureFormat.RGBA32, !pixelArt) { name = name };
            if (!t.LoadImage(png, false)) { DestroyImmediate(t); return null; }
            var px = t.GetPixels32();
            for (int i = 0; i < px.Length; i++)
            {
                var c = px[i];
                px[i] = new Color32((byte)((c.r * c.a + 127) / 255), (byte)((c.g * c.a + 127) / 255), (byte)((c.b * c.a + 127) / 255), c.a);
            }
            t.SetPixels32(px);
            t.wrapMode = TextureWrapMode.Clamp;
            t.filterMode = pixelArt ? FilterMode.Point : FilterMode.Trilinear;
            t.Apply(!pixelArt, false);
            return t;
        }

        public void SetBytes(byte[] ugo)
        {
            bytes = ugo;
            Release();
        }

        /// <summary>The loaded model (null if the bytes are not a valid .ug9).</summary>
        public UgoModelData Data
        {
            get
            {
                if (data_ == null && bytes != null && bytes.Length > 0)
                {
                    try
                    {
                        data_ = new UgoModelData(bytes);
                        if (data_.WarningText != null) Debug.LogWarning(data_.WarningText, this);
                    }
                    catch (FormatException e) { Debug.LogError(e.Message, this); }
                }
                return data_;
            }
        }

        public string[] ParameterNames => Data?.ParameterNames ?? Array.Empty<string>();
        public string[] AnimationNames => Data?.AnimationNames ?? Array.Empty<string>();
        public string[] TextureNames => Data?.TextureNames ?? Array.Empty<string>();

        internal UgoGpuModel Gpu
        {
            get
            {
                // Unity may destroy what the GPU model made (e.g. leaving play mode when the
                // domain is not reloaded): build it again then
                if (gpu_ != null && !gpu_.Alive) { gpu_.Dispose(); gpu_ = null; }
                return gpu_ ?? (Data != null ? gpu_ = new UgoGpuModel(this, Data) : null);
            }
        }

        void OnDisable() => Release();

        void Release()
        {
            gpu_?.Dispose();
            gpu_ = null;
            data_?.Dispose();
            data_ = null;
        }
    }

    /// <summary>GPU data of one model, built once: meshes per blend run, tables, materials.</summary>
    internal sealed class UgoGpuModel : IDisposable
    {
        public readonly UgoModelData Data;
        public readonly GpuTables Tables;
        public readonly Mesh[] RunMeshes;
        public readonly Material[] RunMaterials;
        public readonly Mesh MaskMesh;
        public readonly Material MaskMaterial;      // one character per draw
        public readonly Material MaskArrayMaterial; // every character in one draw (null if the GPU cannot)
        public readonly Texture2D Vertices, Entries, XWeights, Parts;
        public readonly Texture[] Atlases;
        public readonly int MaskGroups;
        public readonly Bounds LocalBounds; // model pixels, padded for deformation
        readonly List<UnityEngine.Object> owned_ = new List<UnityEngine.Object>();

        static Shader shader_;

        public UgoGpuModel(UgoModel model, UgoModelData data)
        {
            Data = data;
            Tables = data.Tables;
            if (shader_ == null) shader_ = Resources.Load<Shader>("Ugo9Character"); // in Resources so players include it

            Vertices = FloatTexture(Tables.Vertices, GpuTables.VertexW);
            Entries = FloatTexture(Tables.Entries, GpuTables.EntryW);
            XWeights = FloatTexture(Tables.XWeights, GpuTables.EntryW);
            Parts = FloatTexture(Tables.Parts, GpuTables.PartsW);

            RunMeshes = new Mesh[Tables.Runs.Count];
            RunMaterials = new Material[Tables.Runs.Count];
            for (int i = 0; i < Tables.Runs.Count; i++)
            {
                RunMeshes[i] = MakeMesh(Tables.Runs[i].Indices);
                RunMaterials[i] = MakeMaterial(Tables.Runs[i].Blend, false);
                // runs draw in order: same-depth transparent draws are otherwise sorted in no fixed order
                RunMaterials[i].renderQueue = (int)RenderQueue.Transparent + Math.Min(i, 499);
            }
            MaskGroups = (Tables.MaskChannels + 3) / 4;
            if (MaskGroups > 0)
            {
                MaskMesh = MakeMesh(Tables.MaskIndices);
                MaskMaterial = MakeMaterial(BlendClass.Normal, true);
                if (SystemInfo.supportsRenderTargetArrayIndexFromVertexShader)
                {
                    MaskArrayMaterial = MakeMaterial(BlendClass.Normal, true);
                    MaskArrayMaterial.DisableKeyword("UGO_MASK_PASS");
                    MaskArrayMaterial.EnableKeyword("UGO_MASK_ARRAY");
                }
            }

            Atlases = new Texture[8];
            for (int i = 0; i < Atlases.Length; i++)
            {
                var list = model.textures;
                Texture t = list != null && list.Length > 0 ? list[Math.Min(i, list.Length - 1)] : null;
                Atlases[i] = t != null ? t : Texture2D.whiteTexture;
            }

            float pad = 0.5f * Math.Max(Tables.MaxX - Tables.MinX, Tables.MaxY - Tables.MinY) + 64;
            LocalBounds = new Bounds(new Vector3((Tables.MinX + Tables.MaxX) / 2, (Tables.MinY + Tables.MaxY) / 2, 0),
                new Vector3(Tables.MaxX - Tables.MinX + 2 * pad, Tables.MaxY - Tables.MinY + 2 * pad, 1));
        }

        Texture2D FloatTexture(float[] texels, int width)
        {
            int rows = GpuTables.Rows(texels.Length / 4, width);
            var t = new Texture2D(width, rows, TextureFormat.RGBAFloat, false, true) { filterMode = FilterMode.Point, wrapMode = TextureWrapMode.Clamp, hideFlags = HideFlags.HideAndDontSave };
            var data = new float[width * rows * 4];
            Array.Copy(texels, data, texels.Length);
            t.SetPixelData(data, 0);
            t.Apply(false, true);
            owned_.Add(t);
            return t;
        }

        /// <summary>One mesh with a submesh per run (a MeshRenderer draws each with its own material); the caller destroys it.</summary>
        internal Mesh MakeSubmeshMesh(List<int[]> runs)
        {
            var mesh = MakeMesh(Array.Empty<int>(), false, false);
            mesh.subMeshCount = runs.Count;
            for (int r = 0; r < runs.Count; r++) mesh.SetIndices(runs[r], MeshTopology.Triangles, r, false);
            mesh.bounds = new Bounds(Vector3.zero, Vector3.one * 1e6f);
            mesh.UploadMeshData(true);
            return mesh;
        }

        /// <summary>A mesh of these triangles for one draw order (format 0.8); the caller destroys it.</summary>
        internal Mesh MakeOrderMesh(int[] indices) => MakeMesh(indices, false);

        /// <summary>The material of a run drawn as the seq-th draw of its drawer (models with a draw order):
        /// render queues in draw order keep Unity from sorting same-depth draws its own way.</summary>
        internal Material RunMaterial(BlendClass cls, int seq)
        {
            seq = Math.Max(0, Math.Min(seq, 999)); // up to Overlay (4000)
            int key = ((int)cls << 16) | seq;
            if (!queued_.TryGetValue(key, out var m))
            {
                m = MakeMaterial(cls, false);
                m.renderQueue = (int)RenderQueue.Transparent + seq;
                queued_[key] = m;
            }
            return m;
        }
        readonly Dictionary<int, Material> queued_ = new Dictionary<int, Material>();

        // every vertex (VERTEX_ID stays the model's vertex number) with only these triangles
        Mesh MakeMesh(int[] indices, bool own = true, bool upload = true)
        {
            int nv = Data.VertexCount;
            var pos = new Vector3[nv];
            var uv = new Vector2[nv];
            for (int i = 0; i < nv; i++)
            {
                pos[i] = new Vector3(Tables.Positions[2 * i], Tables.Positions[2 * i + 1], 0);
                uv[i] = new Vector2(Tables.TextureUvs[2 * i], Tables.TextureUvs[2 * i + 1]); // Unity's textures start at the bottom row
            }
            var mesh = new Mesh { indexFormat = IndexFormat.UInt32, hideFlags = HideFlags.HideAndDontSave };
            mesh.vertices = pos;
            mesh.uv = uv;
            mesh.SetIndices(indices, MeshTopology.Triangles, 0, false);
            mesh.bounds = new Bounds(Vector3.zero, Vector3.one * 1e6f); // moved in the shader
            if (upload) mesh.UploadMeshData(true);
            if (own) owned_.Add(mesh);
            return mesh;
        }

        Material MakeMaterial(BlendClass blend, bool maskPass)
        {
            var m = new Material(shader_) { hideFlags = HideFlags.HideAndDontSave };
            BlendMode src = BlendMode.One, dst = BlendMode.OneMinusSrcAlpha, srcA = BlendMode.One, dstA = BlendMode.OneMinusSrcAlpha;
            BlendOp op = BlendOp.Add;
            if (maskPass) { dst = BlendMode.One; dstA = BlendMode.One; op = BlendOp.Max; m.EnableKeyword("UGO_MASK_PASS"); } // overlaps: max
            else if (blend == BlendClass.Multiply) { src = BlendMode.DstColor; srcA = BlendMode.Zero; dstA = BlendMode.One; }
            else if (blend == BlendClass.Screen) { dst = BlendMode.OneMinusSrcColor; }
            m.SetFloat("_SrcBlend", (float)src);
            m.SetFloat("_DstBlend", (float)dst);
            m.SetFloat("_SrcBlendA", (float)srcA);
            m.SetFloat("_DstBlendA", (float)dstA);
            m.SetFloat("_BlendOp", (float)op);
            owned_.Add(m);
            return m;
        }

        /// <summary>Sets what every draw of this model reads (the frame texture is set by the drawer).</summary>
        public void Fill(MaterialPropertyBlock p)
        {
            p.SetTexture("_UgoVertices", Vertices);
            p.SetTexture("_UgoEntries", Entries);
            p.SetTexture("_UgoXWeights", XWeights);
            p.SetTexture("_UgoParts", Parts);
            for (int i = 0; i < Atlases.Length; i++) p.SetTexture("_UgoAtlas" + i, Atlases[i]);
            p.SetInteger("_UgoFrameW", GpuTables.FrameW);
            p.SetInteger("_UgoVertexW", GpuTables.VertexW);
            p.SetInteger("_UgoEntryW", GpuTables.EntryW);
            p.SetInteger("_UgoPartsW", GpuTables.PartsW);
            p.SetInteger("_UgoStride", Data.FrameFloats / 4);
            p.SetInteger("_UgoSkinT", Data.SkinOffset / 4);
            p.SetInteger("_UgoOpF", Data.OpacityOffset);
            p.SetInteger("_UgoMorphF", Data.MorphOffset);
            p.SetInteger("_UgoColorF", Data.ColorOffset);
            p.SetInteger("_UgoMaskGroups", Math.Max(1, MaskGroups));
            p.SetVector("_UgoCanvas", new Vector4(Data.CanvasWidth, Data.CanvasHeight, Data.OriginX, Data.OriginY));
            p.SetFloat("_UgoMaskFlip", SystemInfo.graphicsUVStartsAtTop ? 1 : 0);
        }

        /// <summary>False once Unity has destroyed any of the objects made here.</summary>
        public bool Alive
        {
            get
            {
                foreach (var o in owned_) if (o == null) return false;
                foreach (var t in Atlases) if (t == null) return false;
                return true;
            }
        }

        public void Dispose()
        {
            foreach (var o in owned_)
            {
                if (o == null) continue;
                if (Application.isPlaying) UnityEngine.Object.Destroy(o);
                else UnityEngine.Object.DestroyImmediate(o);
            }
            owned_.Clear();
        }
    }
}
