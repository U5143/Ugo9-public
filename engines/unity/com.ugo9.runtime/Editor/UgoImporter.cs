// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// Imports a .ug9 file as a UgoModel; its textures are the PNGs named in it,
// next to the .ug9, read into the model's own textures with premultiplied alpha
// (the PNGs' own import settings, e.g. a 2D template's sprites and compression, do not matter).
using System.IO;
using UnityEditor;
using UnityEditor.AssetImporters;
using UnityEngine;

namespace Ugo9.Editor
{
    [ScriptedImporter(3, new[] { "ug9", "ugo" })] // .ug9: the earlier name, read for now
    public sealed class UgoImporter : ScriptedImporter
    {
        [Tooltip("Model pixels per Unity unit.")]
        public float pixelsPerUnit = 100;
        [Tooltip("Pixel art: read the textures texel by texel (Point filter, no mipmaps).")]
        public bool pixelArt;

        public override void OnImportAsset(AssetImportContext ctx)
        {
            var model = UgoModel.FromBytes(File.ReadAllBytes(ctx.assetPath), null, pixelsPerUnit);
            var data = model.Data;
            if (data == null)
            {
                ctx.LogImportError($"Ugo9: {ctx.assetPath} could not be read (see the error above)");
                return;
            }
            if (data.WarningText != null) ctx.LogImportWarning($"{ctx.assetPath}: {data.WarningText}");
            string dir = Path.GetDirectoryName(ctx.assetPath);
            var textures = new Texture2D[data.TextureCount];
            for (int i = 0; i < textures.Length; i++)
            {
                string path = Path.Combine(dir, data.TextureNames[i]).Replace('\\', '/');
                ctx.DependsOnSourceAsset(path);
                textures[i] = File.Exists(path) ? UgoModel.LoadTexture(File.ReadAllBytes(path), data.TextureNames[i], pixelArt) : null;
                if (textures[i] == null) { ctx.LogImportWarning($"Ugo9: texture not found or not readable: {path}"); continue; }
                ctx.AddObjectToAsset("texture" + i, textures[i]);
            }
            model.textures = textures;
            model.name = Path.GetFileNameWithoutExtension(ctx.assetPath);
            ctx.AddObjectToAsset("model", model);
            ctx.SetMainObject(model);
        }
    }
}
