// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// Measures Ugo9 the same way for every character count (docs/比較_Live2D.md):
// for each count, the characters stand in a grid filling a 1280 x 720 view, play
// "idle" (head turn, blinks, breathing, hair physics), and after `warmup` seconds
// the next `measure` seconds are averaged: frames per second, main-thread CPU time,
// draw calls and memory. Results go to <outputFolder>/ugo_bench.json and .csv, then
// the player quits (the editor stops playing).
//
// The grid (the other runtime's scene must do the same):
//   cols = ceil(sqrt(n * (1280 / 720) / 0.6)), rows = ceil(n / cols), cell = 720 / rows px high,
//   cell width = 1280 / cols px; each character is 0.95 x cell high (its 600 x 1000 canvas,
//   or the other model's canvas, scaled to that height), centred in its cell, its feet at
//   the bottom of the cell minus 2.5 %. Characters start the animation at times i * 0.37 s.
using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Text;
using Unity.Profiling;
using UnityEngine;

namespace Ugo9.Samples
{
    public sealed class UgoBench : MonoBehaviour
    {
        public UgoModel model;
        public int[] counts = { 50, 400, 1600, 6400 };
        [Tooltip("Seconds to wait after placing the characters, before measuring.")]
        public float warmup = 3;
        [Tooltip("Seconds measured for each count.")]
        public float measure = 10;
        [Tooltip("Where ugo_bench.json and ugo_bench.csv go (an absolute path); empty: Application.persistentDataPath.")]
        public string outputFolder = "";

        [Serializable] public class Row
        {
            public int characters, frames;
            public float fps, cpuMainMs, cpuMainMsMax, frameMsMax, drawCalls, ugoDraws, ugoCoreMs, ugoUploadMs;
            public long systemMemoryMB, totalUsedMemoryMB, gcMemoryMB;
        }
        [Serializable] class Results
        {
            public string unity, graphics, cpu, os, renderPipeline;
            public int width, height, vSyncCount;
            public bool frameTimingStats, developmentBuild;
            public List<Row> rows = new List<Row>();
        }

        UgoBatch batch_;
        string status_ = "";

        IEnumerator Start()
        {
            QualitySettings.vSyncCount = 0;
            Application.targetFrameRate = -1;
            var cam = Camera.main;
            if (cam == null) cam = new GameObject("Main Camera") { tag = "MainCamera" }.AddComponent<Camera>();
            cam.orthographic = true;
            float ppu = model.pixelsPerUnit;
            // the view: 1280 x 720 px of the grid, whatever the window's size (keep the window 16:9)
            cam.orthographicSize = 360 / ppu;
            cam.transform.position = new Vector3(640 / ppu, -360 / ppu, -10);

            var res = new Results
            {
                unity = Application.unityVersion, graphics = SystemInfo.graphicsDeviceName + " (" + SystemInfo.graphicsDeviceType + ")",
                cpu = SystemInfo.processorType, os = SystemInfo.operatingSystem,
                renderPipeline = UnityEngine.Rendering.GraphicsSettings.currentRenderPipeline != null ? UnityEngine.Rendering.GraphicsSettings.currentRenderPipeline.name : "Built-in",
                width = Screen.width, height = Screen.height, vSyncCount = QualitySettings.vSyncCount, developmentBuild = Debug.isDebugBuild,
            };
            batch_ = new GameObject("Ugo9 bench").AddComponent<UgoBatch>();
            foreach (int n in counts)
            {
                Place(n, ppu);
                status_ = $"{n} characters: warming up";
                float t0 = Time.realtimeSinceStartup;
                while (Time.realtimeSinceStartup - t0 < warmup) yield return null;

                var row = new Row { characters = n };
                using var draws = ProfilerRecorder.StartNew(ProfilerCategory.Render, "Draw Calls Count");
                using var sysMem = ProfilerRecorder.StartNew(ProfilerCategory.Memory, "System Used Memory");
                using var usedMem = ProfilerRecorder.StartNew(ProfilerCategory.Memory, "Total Used Memory");
                using var gcMem = ProfilerRecorder.StartNew(ProfilerCategory.Memory, "GC Used Memory");
                var timings = new FrameTiming[1];
                double cpuSum = 0, drawSum = 0, coreSum = 0, uploadSum = 0;
                int cpuFrames = 0, drawFrames = 0;
                status_ = $"{n} characters: measuring";
                t0 = Time.realtimeSinceStartup;
                yield return null;
                float start = Time.realtimeSinceStartup;
                while (Time.realtimeSinceStartup - start < measure)
                {
                    yield return null;
                    row.frames++;
                    row.frameMsMax = Mathf.Max(row.frameMsMax, Time.unscaledDeltaTime * 1000);
                    FrameTimingManager.CaptureFrameTimings();
                    if (FrameTimingManager.GetLatestTimings(1, timings) > 0 && timings[0].cpuMainThreadFrameTime > 0)
                    {
                        cpuSum += timings[0].cpuMainThreadFrameTime;
                        row.cpuMainMsMax = Mathf.Max(row.cpuMainMsMax, (float)timings[0].cpuMainThreadFrameTime);
                        cpuFrames++;
                        res.frameTimingStats = true;
                    }
                    if (draws.Valid && draws.LastValue > 0) { drawSum += draws.LastValue; drawFrames++; }
                    coreSum += batch_.EvaluateMs;
                    uploadSum += batch_.UploadMs;
                }
                float elapsed = Time.realtimeSinceStartup - start;
                row.fps = row.frames / elapsed;
                row.cpuMainMs = cpuFrames > 0 ? (float)(cpuSum / cpuFrames) : -1;
                row.drawCalls = drawFrames > 0 ? (float)(drawSum / drawFrames) : -1; // -1: not counted in this build
                row.ugoDraws = batch_.DrawCount;
                row.ugoCoreMs = (float)(coreSum / Math.Max(1, row.frames));
                row.ugoUploadMs = (float)(uploadSum / Math.Max(1, row.frames));
                row.systemMemoryMB = sysMem.Valid ? sysMem.LastValue >> 20 : -1;
                row.totalUsedMemoryMB = usedMem.Valid ? usedMem.LastValue >> 20 : -1;
                row.gcMemoryMB = gcMem.Valid ? gcMem.LastValue >> 20 : -1;
                res.rows.Add(row);
                Debug.Log($"Ugo9 bench: {n} characters, {row.fps:0.0} fps, main thread {row.cpuMainMs:0.00} ms, draw calls {row.drawCalls:0}, Ugo9 draws {row.ugoDraws}, system memory {row.systemMemoryMB} MB");
            }
            Write(res);
            status_ = "done";
            yield return new WaitForSeconds(1);
#if UNITY_EDITOR
            UnityEditor.EditorApplication.isPlaying = false;
#else
            Application.Quit();
#endif
        }

        void Place(int n, float ppu)
        {
            for (int i = batch_.transform.childCount - 1; i >= 0; i--) Destroy(batch_.transform.GetChild(i).gameObject);
            int cols = Mathf.CeilToInt(Mathf.Sqrt(n * (1280f / 720f) / 0.6f)), rows = Mathf.CeilToInt(n / (float)cols);
            float cellH = 720f / rows, cellW = 1280f / cols;
            var data = model.Data;
            float s = cellH * 0.95f / data.CanvasHeight; // the canvas scaled to 95 % of the cell's height
            for (int i = 0; i < n; i++)
            {
                var go = new GameObject("character");
                go.transform.SetParent(batch_.transform, false);
                float x = (i % cols + 0.5f) * cellW, feet = (i / cols + 1) * cellH - cellH * 0.025f;
                // the model's origin sits at (originX, originY) of its canvas: put the canvas' bottom centre at the feet
                float ox = (data.OriginX - data.CanvasWidth / 2f) * s, oy = (data.OriginY - data.CanvasHeight) * s;
                go.transform.localPosition = new Vector3((x + ox) / ppu, -(feet + oy) / ppu, 0);
                go.transform.localScale = new Vector3(s, s, 1);
                var c = go.AddComponent<UgoCharacter>();
                c.model = model;
                c.Play("idle", i * 0.37f);
            }
        }

        void Write(Results res)
        {
            string dir = string.IsNullOrEmpty(outputFolder) ? Application.persistentDataPath : outputFolder;
            Directory.CreateDirectory(dir);
            File.WriteAllText(Path.Combine(dir, "ugo_bench.json"), JsonUtility.ToJson(res, true));
            var csv = new StringBuilder("characters,fps,cpuMainMs,cpuMainMsMax,frameMsMax,drawCalls,ugoDraws,ugoCoreMs,ugoUploadMs,systemMemoryMB,totalUsedMemoryMB,gcMemoryMB,frames\n");
            foreach (var r in res.rows)
                csv.Append(FormattableString.Invariant($"{r.characters},{r.fps:0.0},{r.cpuMainMs:0.00},{r.cpuMainMsMax:0.00},{r.frameMsMax:0.00},{r.drawCalls:0},{r.ugoDraws},{r.ugoCoreMs:0.00},{r.ugoUploadMs:0.00},{r.systemMemoryMB},{r.totalUsedMemoryMB},{r.gcMemoryMB},{r.frames}\n"));
            File.WriteAllText(Path.Combine(dir, "ugo_bench.csv"), csv.ToString());
            Debug.Log($"Ugo9 bench: wrote {dir}/ugo_bench.json and .csv");
        }

        void OnGUI()
        {
            string text = $"{1f / Time.smoothDeltaTime:0} fps   {status_}";
            var size = GUI.skin.label.CalcSize(new GUIContent(text));
            GUI.color = new Color(1, 1, 1, 0.85f);
            GUI.DrawTexture(new Rect(6, 4, size.x + 12, size.y + 8), Texture2D.whiteTexture);
            GUI.color = Color.black;
            GUI.Label(new Rect(12, 8, size.x + 4, size.y), text);
        }
    }
}
