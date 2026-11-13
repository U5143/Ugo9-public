// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// Picture test for Unity (run on a PC; see docs/エンジン.md「PC での確認」).
// Draws the scenes of tests/engine_scenes.mjs (written for Unity by
// `node tests/unity_test.mjs prepare`) and saves one PNG per scene, plus
// results.json (draw calls), for `node tests/unity_test.mjs compare`.
// Put this on an empty GameObject in an empty scene, fill the fields, press Play.
using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using UnityEngine;

namespace Ugo9.Samples
{
    public sealed class UgoRenderTest : MonoBehaviour
    {
        [Tooltip("scene_unity.json from `node tests/unity_test.mjs prepare`.")]
        public TextAsset spec;
        [Tooltip("The test models, in this order: basic, editor, rig, warp, order.")]
        public UgoModel[] models = new UgoModel[5];
        [Tooltip("Where the PNGs go, an absolute path, e.g. <repository>/build/unity")]
        public string outputFolder = "";

        [Serializable] class Param { public string name; public float value; }
        [Serializable] class Character { public float x, y, rotation, scaleX = 1, scaleY = 1, time; public string anim = ""; public Param[] parameters = Array.Empty<Param>(); }
        [Serializable] class Case { public string name; public string modelName = "basic"; public bool save = true; public bool standalone; public Character[] characters = Array.Empty<Character>(); }
        [Serializable] class Spec { public int width, height; public float[] background; public Case[] cases; }
        [Serializable] class Result { public string name; public int batchDraws, characters; }
        [Serializable] class Results { public string unity; public string graphics; public string colorSpace; public List<Result> cases = new List<Result>(); }

        static readonly string[] ModelNames = { "basic", "editor", "rig", "warp", "order" };

        IEnumerator Start()
        {
            var s = JsonUtility.FromJson<Spec>(spec.text);
            Directory.CreateDirectory(outputFolder);
            var results = new Results { unity = Application.unityVersion, graphics = SystemInfo.graphicsDeviceName, colorSpace = QualitySettings.activeColorSpace.ToString() };

            var rt = new RenderTexture(s.width, s.height, 24, RenderTextureFormat.ARGB32);
            var cam = new GameObject("Ugo9 test camera").AddComponent<Camera>();
            cam.orthographic = true;
            cam.clearFlags = CameraClearFlags.SolidColor;
            cam.backgroundColor = new Color(s.background[0], s.background[1], s.background[2], 1);
            cam.targetTexture = rt;

            foreach (var c in s.cases)
            {
                var model = models[Math.Max(0, Array.IndexOf(ModelNames, c.modelName))];
                float ppu = model.pixelsPerUnit;
                // the view: x right and y down in pixels, its top-left corner at the world origin
                cam.orthographicSize = s.height / 2f / ppu;
                cam.transform.position = new Vector3(s.width / 2f / ppu, -s.height / 2f / ppu, -10);

                var root = new GameObject(c.name);
                UgoBatch batch = c.standalone ? null : root.AddComponent<UgoBatch>();
                foreach (var ch in c.characters)
                {
                    var go = new GameObject("character");
                    go.transform.SetParent(root.transform, false);
                    go.transform.localPosition = new Vector3(ch.x / ppu, -ch.y / ppu, 0);
                    go.transform.localRotation = Quaternion.Euler(0, 0, -ch.rotation * Mathf.Rad2Deg);
                    go.transform.localScale = new Vector3(ch.scaleX, ch.scaleY, 1);
                    var u = go.AddComponent<UgoCharacter>();
                    u.model = model;
                    u.manual = true;
                    u.playing = false;
                    u.animation = ch.anim;
                    u.time = ch.time;
                    foreach (var p in ch.parameters) u.SetParam(p.name, p.value);
                }
                for (int i = 0; i < 3; i++) yield return new WaitForEndOfFrame();
                if (c.save)
                {
                    var prev = RenderTexture.active;
                    RenderTexture.active = rt;
                    var img = new Texture2D(s.width, s.height, TextureFormat.RGBA32, false);
                    img.ReadPixels(new Rect(0, 0, s.width, s.height), 0, 0);
                    img.Apply();
                    RenderTexture.active = prev;
                    File.WriteAllBytes(Path.Combine(outputFolder, c.name + ".png"), img.EncodeToPNG());
                    Destroy(img);
                }
                results.cases.Add(new Result { name = c.name, batchDraws = batch != null ? batch.DrawCount : -1, characters = batch != null ? batch.CharacterCount : c.characters.Length });
                Destroy(root);
                yield return null;
            }
            File.WriteAllText(Path.Combine(outputFolder, "results.json"), JsonUtility.ToJson(results, true));
            Debug.Log($"Ugo9 render test: wrote {s.cases.Length} scenes to {outputFolder}");
#if UNITY_EDITOR
            UnityEditor.EditorApplication.isPlaying = false;
#else
            Application.Quit();
#endif
        }
    }
}
