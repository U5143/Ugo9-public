// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// Imports a .ug9x expression preset (JSON, "ugo9-expressions") as a TextAsset,
// for UgoCharacter.LoadExpressions.
using System.IO;
using UnityEditor.AssetImporters;
using UnityEngine;

namespace Ugo9.Editor
{
    [ScriptedImporter(1, "ug9x")]
    public sealed class UgoExpressionsImporter : ScriptedImporter
    {
        public override void OnImportAsset(AssetImportContext ctx)
        {
            var text = new TextAsset(File.ReadAllText(ctx.assetPath)) { name = Path.GetFileNameWithoutExtension(ctx.assetPath) };
            ctx.AddObjectToAsset("preset", text);
            ctx.SetMainObject(text);
        }
    }
}
