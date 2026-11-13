// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// UgoDrawer: draws many characters of one model with a few procedural draws:
// one per run of parts that share a blend class. With masks, every character
// first draws its mask parts into its own slices of a mask texture array: one
// draw per 4 mask channels where the GPU can pick the slice in the vertex
// shader (D3D11, Vulkan, Metal), else one small draw per character. Placement is relative to the owner's transform and travels
// in the frame blocks.
using System;
using System.Collections.Generic;
using UnityEngine;
using UnityEngine.Rendering;
using Ugo9.Core;

namespace Ugo9
{
    internal sealed class UgoDrawer : IDisposable
    {
        readonly UgoModel model_;
        readonly UgoGpuModel gpu_;
        readonly MaterialPropertyBlock props_ = new MaterialPropertyBlock();
        readonly MaterialPropertyBlock maskProps_ = new MaterialPropertyBlock();
        readonly CommandBuffer maskCmd_ = new CommandBuffer { name = "Ugo9 masks" };
        Texture2D frameTex_;
        float[] staging_ = Array.Empty<float>();
        RenderTexture masks_;
        int maskSlices_;

        public UgoModel Model => model_;
        /// <summary>False when the model built its GPU data again (make a new drawer then).</summary>
        public bool Current => model_ != null && model_.Gpu == gpu_;

        // a texture array to bind when there are no masks (an unset one would be a 2D texture)
        static Texture2DArray noMasks_;
        static Texture2DArray NoMasks
        {
            get
            {
                if (noMasks_ == null)
                {
                    noMasks_ = new Texture2DArray(1, 1, 1, TextureFormat.RGBA32, false) { hideFlags = HideFlags.HideAndDontSave };
                    noMasks_.SetPixels32(new[] { new Color32(0, 0, 0, 0) }, 0);
                    noMasks_.Apply(false, true);
                }
                return noMasks_;
            }
        }
        /// <summary>The first render queue (from Transparent) of this drawer's runs (UgoQueues), and how many it used last.</summary>
        public int QueueBase;
        public int QueuesUsed { get; private set; } = 1;
        /// <summary>Where the characters were in the last frame (the middle of their box).</summary>
        public Vector3 Center { get; private set; }
        /// <summary>Draw calls of the last frame: one per run, plus the mask draws.</summary>
        public int DrawCount { get; private set; }

        public UgoDrawer(UgoModel model)
        {
            model_ = model;
            gpu_ = model.Gpu;
            gpu_.Fill(props_);
            props_.SetTexture("_UgoMask", NoMasks); // replaced by the real mask images when the model has masks
            gpu_.Fill(maskProps_);
        }

        // ---- models whose draw order changes (format 0.8) ----
        // Characters next to each other with the same draw order are drawn together: one draw per run of
        // their order, reading their frame blocks from _UgoInstanceBase on. Orders in use are kept (8 at most).
        sealed class Order { public uint key; public uint[] list; public Mesh[] meshes; public BlendClass[] classes; public long used; }
        const int OrderSlots = 8; // as web/ugo.js
        readonly List<Order> orders_ = new List<Order>();
        readonly List<MaterialPropertyBlock> groupProps_ = new List<MaterialPropertyBlock>();
        long orderUse_;
        uint[] listA_ = Array.Empty<uint>(), listB_ = Array.Empty<uint>();

        Order OrderFor(uint key, uint[] list)
        {
            long use = ++orderUse_;
            foreach (var o in orders_)
            {
                if (o.key == key && SameList(o.list, list)) { o.used = use; return o; }
            }
            Order slot;
            if (orders_.Count < OrderSlots) { slot = new Order(); orders_.Add(slot); }
            else
            {
                slot = orders_[0];
                foreach (var o in orders_) if (o.used < slot.used) slot = o;
                foreach (var m in slot.meshes) Destroy(m);
            }
            var runs = gpu_.Data.RunsFor(key == 0 ? null : list);
            slot.key = key;
            slot.list = (uint[])list.Clone();
            slot.used = use;
            slot.meshes = new Mesh[runs.Count];
            slot.classes = new BlendClass[runs.Count];
            for (int r = 0; r < runs.Count; r++) { slot.meshes[r] = gpu_.MakeOrderMesh(runs[r].Indices); slot.classes[r] = runs[r].Blend; }
            return slot;
        }

        static bool SameList(uint[] a, uint[] b)
        {
            if (a.Length != b.Length) return false;
            for (int i = 0; i < a.Length; i++) if (a[i] != b[i]) return false;
            return true;
        }

        void DrawOrdered(List<UgoCharacter> characters, Bounds bounds, int layer, Matrix4x4 toWorld, float unitsPerPixel)
        {
            int n = characters.Count, np = gpu_.Data.PartCount, seq = QueueBase, group = 0;
            if (listA_.Length != np) { listA_ = new uint[np]; listB_ = new uint[np]; }
            for (int i = 0; i < n;)
            {
                uint key = characters[i].DrawOrderKey;
                characters[i].CopyDrawOrder(listA_);
                int j = i + 1;
                while (j < n && characters[j].DrawOrderKey == key)
                {
                    characters[j].CopyDrawOrder(listB_);
                    if (!SameList(listA_, listB_)) break;
                    j++;
                }
                var o = OrderFor(key, listA_);
                if (group == groupProps_.Count)
                {
                    var p = new MaterialPropertyBlock();
                    gpu_.Fill(p);
                    groupProps_.Add(p);
                }
                var props = groupProps_[group++];
                props.SetTexture("_UgoFrame", frameTex_);
                props.SetTexture("_UgoMask", masks_ != null ? (Texture)masks_ : NoMasks);
                props.SetMatrix("_UgoObjectToWorld", toWorld);
                props.SetFloat("_UgoUnitsPerPixel", unitsPerPixel);
                props.SetInteger("_UgoInstanceBase", i);
                for (int r = 0; r < o.meshes.Length; r++)
                {
                    var rp = new RenderParams(gpu_.RunMaterial(o.classes[r], seq++))
                    {
                        matProps = props,
                        worldBounds = bounds,
                        layer = layer,
                        shadowCastingMode = ShadowCastingMode.Off,
                        receiveShadows = false,
                    };
                    Graphics.RenderMeshPrimitives(rp, o.meshes[r], 0, j - i);
                    DrawCount++;
                }
                i = j;
            }
            QueuesUsed = Math.Max(1, seq - QueueBase);
        }

        public void Dispose()
        {
            Destroy(rendererMesh_);
            foreach (var o in orders_) foreach (var m in o.meshes) Destroy(m);
            orders_.Clear();
            Destroy(frameTex_);
            if (masks_ != null) { masks_.Release(); Destroy(masks_); }
            maskCmd_.Release();
        }

        static void Destroy(UnityEngine.Object o)
        {
            if (o == null) return;
            if (Application.isPlaying) UnityEngine.Object.Destroy(o);
            else UnityEngine.Object.DestroyImmediate(o);
        }

        /// <summary>Uploads the frame blocks of these (already evaluated) characters and draws them in this order.</summary>
        public void Draw(List<UgoCharacter> characters, Transform owner, int layer)
        {
            int n = characters.Count;
            DrawCount = 0;
            if (n == 0 || gpu_ == null) return;
            Upload(characters, owner, out float unitsPerPixel, out Matrix4x4 toWorld);

            // the area the characters can cover, for culling
            Bounds bounds = default;
            for (int i = 0; i < n; i++)
            {
                var b = characters[i].WorldBounds(gpu_.LocalBounds, unitsPerPixel);
                if (i == 0) bounds = b; else bounds.Encapsulate(b);
            }
            Center = bounds.center;
            if (gpu_.Data.HasDrawOrder) { DrawOrdered(characters, bounds, layer, toWorld, unitsPerPixel); return; }
            for (int r = 0; r < gpu_.RunMeshes.Length; r++)
            {
                var rp = new RenderParams(gpu_.RunMaterial(gpu_.Tables.Runs[r].Blend, QueueBase + r))
                {
                    matProps = props_,
                    worldBounds = bounds,
                    layer = layer,
                    shadowCastingMode = ShadowCastingMode.Off,
                    receiveShadows = false,
                };
                Graphics.RenderMeshPrimitives(rp, gpu_.RunMeshes[r], 0, n);
                DrawCount++;
            }
            QueuesUsed = Math.Max(1, gpu_.RunMeshes.Length);
        }

        // ---- one character as an ordinary MeshRenderer: it sorts with sprites by Sorting Layer and Order in Layer ----
        Mesh rendererMesh_;
        uint rendererKey_ = uint.MaxValue;
        uint[] rendererList_ = Array.Empty<uint>();

        /// <summary>
        /// Uploads one (already evaluated) character's frame block and sets the renderer up to draw it: one submesh per
        /// run of parts, the runs' materials (their render queues keep the parts' order) and this drawer's properties.
        /// Unity then draws it in its transparent pass, sorted with sprites by the renderer's sorting layer and order.
        /// </summary>
        public void PrepareRenderer(UgoCharacter character, MeshFilter filter, MeshRenderer renderer)
        {
            DrawCount = 0;
            if (gpu_ == null) return;
            single_.Clear();
            single_.Add(character);
            Upload(single_, null, out float unitsPerPixel, out _);
            var data = gpu_.Data;
            // the runs for this frame's draw order (models without one: the stored order, made once)
            uint key = data.HasDrawOrder ? character.DrawOrderKey : 0;
            if (data.HasDrawOrder)
            {
                if (listA_.Length != data.PartCount) { listA_ = new uint[data.PartCount]; listB_ = new uint[data.PartCount]; }
                character.CopyDrawOrder(listA_);
            }
            if (rendererMesh_ == null || key != rendererKey_ || (data.HasDrawOrder && !SameList(rendererList_, listA_)))
            {
                Destroy(rendererMesh_);
                var runs = data.RunsFor(key == 0 ? null : listA_);
                var indices = new List<int[]>();
                var mats = new Material[runs.Count];
                for (int r = 0; r < runs.Count; r++) { indices.Add(runs[r].Indices); mats[r] = gpu_.RunMaterial(runs[r].Blend, r); }
                rendererMesh_ = gpu_.MakeSubmeshMesh(indices);
                rendererKey_ = key;
                rendererList_ = data.HasDrawOrder ? (uint[])listA_.Clone() : Array.Empty<uint>();
                renderer.sharedMaterials = mats;
            }
            filter.sharedMesh = rendererMesh_;
            props_.SetInteger("_UgoInstanceBase", 0);
            renderer.SetPropertyBlock(props_);
            // where it can be: the core's box around this frame's vertices, in the renderer's own space
            var wb = character.WorldBounds(gpu_.LocalBounds, unitsPerPixel);
            renderer.localBounds = new Bounds(renderer.transform.InverseTransformPoint(wb.center), wb.size * 1.01f / Mathf.Max(1e-6f, renderer.transform.lossyScale.x));
            DrawCount = rendererMesh_.subMeshCount;
        }
        readonly List<UgoCharacter> single_ = new List<UgoCharacter>();

        // the frame blocks into the frame texture, and the properties every draw shares
        void Upload(List<UgoCharacter> characters, Transform owner, out float unitsPerPixel, out Matrix4x4 toWorld)
        {
            int n = characters.Count;
            var data = gpu_.Data;
            int ff = data.FrameFloats;
            int rows = GpuTables.Rows(n * ff / 4, GpuTables.FrameW);
            if (frameTex_ == null || frameTex_.height < rows)
            {
                Destroy(frameTex_);
                int r = Math.Max(rows, frameTex_ != null ? frameTex_.height * 2 : 1);
                frameTex_ = new Texture2D(GpuTables.FrameW, r, TextureFormat.RGBAFloat, false, true) { filterMode = FilterMode.Point, wrapMode = TextureWrapMode.Clamp, hideFlags = HideFlags.HideAndDontSave };
                staging_ = new float[GpuTables.FrameW * r * 4];
                props_.SetTexture("_UgoFrame", frameTex_);
                maskProps_.SetTexture("_UgoFrame", frameTex_);
            }
            for (int i = 0; i < n; i++) characters[i].CopyFrame(staging_, i * ff);
            frameTex_.SetPixelData(staging_, 0);
            frameTex_.Apply(false, false);

            unitsPerPixel = 1f / Mathf.Max(1e-6f, model_.pixelsPerUnit);
            toWorld = owner != null ? owner.localToWorldMatrix : Matrix4x4.identity;
            props_.SetMatrix("_UgoObjectToWorld", toWorld);
            props_.SetFloat("_UgoUnitsPerPixel", unitsPerPixel);
            props_.SetInteger("_UgoInstanceBase", 0);

            if (gpu_.MaskGroups > 0) DrawMasks(n);
        }

        // each character's mask images: one slice per character and 4 channels, over the model's canvas
        void DrawMasks(int n)
        {
            int groups = gpu_.MaskGroups, slices = n * groups;
            if (masks_ == null || maskSlices_ < slices)
            {
                if (masks_ != null) { masks_.Release(); Destroy(masks_); }
                maskSlices_ = Math.Max(slices, maskSlices_ * 2);
                var data = gpu_.Data;
                masks_ = new RenderTexture((int)data.CanvasWidth, (int)data.CanvasHeight, 0, RenderTextureFormat.ARGB32, RenderTextureReadWrite.Linear)
                {
                    dimension = TextureDimension.Tex2DArray,
                    volumeDepth = maskSlices_,
                    filterMode = FilterMode.Bilinear,
                    wrapMode = TextureWrapMode.Clamp,
                    useMipMap = false,
                    hideFlags = HideFlags.HideAndDontSave,
                };
                masks_.Create();
                props_.SetTexture("_UgoMask", masks_);
            }
            maskCmd_.Clear();
            if (gpu_.MaskArrayMaterial != null)
            {
                // every character at once: the vertex shader picks each one's slice
                maskCmd_.SetRenderTarget(masks_, 0, CubemapFace.Unknown, -1);
                maskCmd_.ClearRenderTarget(false, true, Color.clear);
                maskCmd_.SetGlobalInteger("_UgoInstanceBase", 0);
                for (int g = 0; g < groups; g++)
                {
                    maskCmd_.SetGlobalInteger("_UgoMaskGroup", g);
                    maskCmd_.DrawMeshInstancedProcedural(gpu_.MaskMesh, 0, gpu_.MaskArrayMaterial, 0, n, maskProps_);
                    DrawCount++;
                }
            }
            else
            {
                for (int i = 0; i < n; i++)
                {
                    for (int g = 0; g < groups; g++)
                    {
                        maskCmd_.SetRenderTarget(masks_, 0, CubemapFace.Unknown, i * groups + g);
                        maskCmd_.ClearRenderTarget(false, true, Color.clear);
                        // per-draw values go into the command (the property block is read when the command runs)
                        maskCmd_.SetGlobalInteger("_UgoInstanceBase", i);
                        maskCmd_.SetGlobalInteger("_UgoMaskGroup", g);
                        maskCmd_.DrawMeshInstancedProcedural(gpu_.MaskMesh, 0, gpu_.MaskMaterial, 0, 1, maskProps_);
                        DrawCount++;
                    }
                }
            }
            Graphics.ExecuteCommandBuffer(maskCmd_);
        }
    }
}
