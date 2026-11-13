// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// Ugo9 demo: a crowd drawn by one UgoBatch (a few draw calls for all of them)
// and a large character that looks at the mouse. Put this on an empty
// GameObject in an empty 2D scene with an orthographic camera, set the model,
// press Play.   Up / Down: double / halve the crowd    Space: idle <-> talk
using UnityEngine;

namespace Ugo9.Samples
{
    public sealed class UgoDemo : MonoBehaviour
    {
        public UgoModel model;
        public int count = 50;

        UgoBatch batch_;
        UgoCharacter hero_;

        void Start()
        {
            batch_ = new GameObject("crowd").AddComponent<UgoBatch>();
            hero_ = new GameObject("hero").AddComponent<UgoCharacter>();
            hero_.model = model;
            hero_.autoBlink = true;
            hero_.Play("idle");
            Rebuild();
        }

        void Rebuild()
        {
            foreach (Transform t in batch_.transform) Destroy(t.gameObject);
            var cam = Camera.main;
            float h = cam.orthographicSize * 2, w = h * cam.aspect;
            int cols = Mathf.CeilToInt(Mathf.Sqrt(count * w / h)), rows = Mathf.CeilToInt((float)count / cols);
            float cellW = w / cols, cellH = h / rows;
            float s = Mathf.Min(cellW / (420 / model.pixelsPerUnit), cellH / (600 / model.pixelsPerUnit)) * 0.9f;
            Vector3 corner = cam.transform.position - new Vector3(w / 2, h / 2, -10);
            for (int i = 0; i < count; i++)
            {
                var c = new GameObject("c" + i).AddComponent<UgoCharacter>();
                c.transform.SetParent(batch_.transform, false);
                c.transform.position = corner + new Vector3((i % cols + 0.5f) * cellW, (rows - 1 - i / cols) * cellH + cellH * 0.05f, 0);
                c.transform.localScale = new Vector3(s, s, 1);
                c.model = model;
                c.Play("idle", Random.value * 6);
                c.speed = Random.Range(0.8f, 1.2f);
            }
        }

        void Update()
        {
            if (KeyDown(KeyCode.UpArrow)) { count = Mathf.Min(count * 2, 6400); Rebuild(); }
            if (KeyDown(KeyCode.DownArrow)) { count = Mathf.Max(count / 2, 1); Rebuild(); }
            if (KeyDown(KeyCode.Space)) hero_.Play(hero_.animation == "idle" ? "talk" : "idle");
            var cam = Camera.main;
            float h = cam.orthographicSize * 2;
            hero_.transform.position = cam.transform.position + new Vector3(0, -h / 2, 10);
            hero_.transform.localScale = Vector3.one * (h * model.pixelsPerUnit / 620);
            // look at the mouse (the helper turns face, eyes and a little of the body)
            hero_.LookAt(cam.ScreenToWorldPoint(MousePosition()));
        }

        // either input handling (Unity 6's templates use only the Input System package)
#if ENABLE_INPUT_SYSTEM && !ENABLE_LEGACY_INPUT_MANAGER
        static bool KeyDown(KeyCode k)
        {
            var kb = UnityEngine.InputSystem.Keyboard.current;
            if (kb == null) return false;
            var key = k == KeyCode.UpArrow ? kb.upArrowKey : k == KeyCode.DownArrow ? kb.downArrowKey : kb.spaceKey;
            return key.wasPressedThisFrame;
        }
        static Vector3 MousePosition()
        {
            var mouse = UnityEngine.InputSystem.Mouse.current;
            return mouse != null ? (Vector3)mouse.position.ReadValue() : Vector3.zero;
        }
#else
        static bool KeyDown(KeyCode k) => Input.GetKeyDown(k);
        static Vector3 MousePosition() => Input.mousePosition;
#endif

        void OnGUI()
        {
            string text = $"{1f / Time.smoothDeltaTime:0} fps   crowd {batch_.CharacterCount}   draw calls for the crowd: {batch_.DrawCount}   CPU: core {batch_.EvaluateMs:0.0} ms, upload {batch_.UploadMs:0.0} ms   (Up/Down: more/fewer, Space: talk)";
            var style = GUI.skin.label;
            var size = style.CalcSize(new GUIContent(text));
            GUI.color = new Color(1, 1, 1, 0.85f); // a light panel under the text, so the crowd does not hide it
            GUI.DrawTexture(new Rect(6, 4, size.x + 12, size.y + 8), Texture2D.whiteTexture);
            GUI.color = Color.black;
            GUI.Label(new Rect(12, 8, size.x + 4, size.y), text);
        }
    }
}
