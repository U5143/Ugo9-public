// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// Ugo9 playground: the sample character with a panel to try what the package does, in one place.
// Put this on an empty GameObject in a 2D scene with an orthographic camera, set the model
// (samples/basic), press Play.
//   left panel: an animation per button, a slider per parameter (moved ones override the animation
//   until Reset), blinking on its own, the microphone moving the mouth (through the noise gate)
//   click the character: the name of the part under the mouse
using System.Collections.Generic;
using UnityEngine;

namespace Ugo9.Samples
{
    public sealed class UgoPlayground : MonoBehaviour
    {
        public UgoModel model;

        UgoCharacter c_;
        readonly Dictionary<string, float> set_ = new Dictionary<string, float>();
        string picked_ = "-";
        Vector2 scroll_;
        AudioClip mic_;
        string micDevice_;
        readonly float[] micBuf_ = new float[512];

        void Start()
        {
            c_ = new GameObject("character").AddComponent<UgoCharacter>();
            c_.model = model;
            c_.autoBlink = true;
            var anims = model.AnimationNames;
            if (anims.Length > 0) c_.Play(anims[0]);
        }

        void Update()
        {
            var cam = Camera.main;
            float h = cam.orthographicSize * 2;
            // the character on the right two thirds of the view, feet at the bottom
            c_.transform.position = cam.transform.position + new Vector3(h * cam.aspect / 6, -h / 2 * 0.98f, 10);
            c_.transform.localScale = Vector3.one * (h * 0.95f * model.pixelsPerUnit / model.Data.CanvasHeight);
            foreach (var kv in set_) c_.SetParam(kv.Key, kv.Value);

            if (MouseDown() && MousePosition().x > PanelWidth)
                picked_ = c_.PartAt(cam.ScreenToWorldPoint(MousePosition())) ?? "(nothing)";

            // the microphone: the latest samples' loudness -> the character's noise gate -> the mouth
            if (mic_ != null)
            {
                int pos = Microphone.GetPosition(micDevice_) - micBuf_.Length;
                if (pos < 0) pos += mic_.samples;
                mic_.GetData(micBuf_, pos);
                double sum = 0;
                foreach (var s in micBuf_) sum += s * s;
                float db = Mathf.Max(-100, 10 * Mathf.Log10((float)(sum / micBuf_.Length) + 1e-12f));
                c_.SetMouthLevel(c_.VoiceGate.Update(db, Time.deltaTime));
            }
        }

        const float PanelWidth = 300;

        void OnGUI()
        {
            GUI.color = new Color(1, 1, 1, 0.9f);
            GUI.DrawTexture(new Rect(0, 0, PanelWidth, Screen.height), Texture2D.whiteTexture);
            GUI.color = Color.white;
            GUI.contentColor = Color.black;
            GUILayout.BeginArea(new Rect(8, 8, PanelWidth - 16, Screen.height - 16));
            scroll_ = GUILayout.BeginScrollView(scroll_);
            GUILayout.Label($"clicked part: {picked_}");
            GUILayout.Label("animation");
            foreach (var a in model.AnimationNames)
                if (GUILayout.Button(a == c_.animation ? $"> {a}" : a)) c_.Play(a, 0, 0.3f);
            c_.autoBlink = GUILayout.Toggle(c_.autoBlink, "blink on its own");
            if (GUILayout.Button(mic_ == null ? "microphone: move the mouth" : "stop the microphone")) ToggleMic();
            GUILayout.Label("parameters (moved ones override the animation)");
            if (GUILayout.Button("Reset")) { foreach (var k in set_.Keys) c_.ClearParam(k); set_.Clear(); }
            var data = model.Data;
            for (int i = 0; i < data.ParameterCount; i++)
            {
                string n = data.ParameterNames[i];
                float v = set_.TryGetValue(n, out var s) ? s : c_.GetParam(n);
                GUILayout.Label($"{n}  {v:0.00}");
                float nv = GUILayout.HorizontalSlider(v, data.ParameterMin(i), data.ParameterMax(i));
                if (!Mathf.Approximately(nv, v)) set_[n] = nv;
            }
            GUILayout.EndScrollView();
            GUILayout.EndArea();
        }

        void ToggleMic()
        {
            if (mic_ != null) { Microphone.End(micDevice_); mic_ = null; c_.SetMouthLevel(-1); return; }
            if (Microphone.devices.Length == 0) { picked_ = "(no microphone)"; return; }
            micDevice_ = Microphone.devices[0];
            mic_ = Microphone.Start(micDevice_, true, 1, 44100);
        }

        // either input handling (Unity 6's templates use only the Input System package)
#if ENABLE_INPUT_SYSTEM && !ENABLE_LEGACY_INPUT_MANAGER
        static bool MouseDown() => UnityEngine.InputSystem.Mouse.current?.leftButton.wasPressedThisFrame ?? false;
        static Vector3 MousePosition()
        {
            var mouse = UnityEngine.InputSystem.Mouse.current;
            return mouse != null ? (Vector3)mouse.position.ReadValue() : Vector3.zero;
        }
#else
        static bool MouseDown() => Input.GetMouseButtonDown(0);
        static Vector3 MousePosition() => Input.mousePosition;
#endif
    }
}
