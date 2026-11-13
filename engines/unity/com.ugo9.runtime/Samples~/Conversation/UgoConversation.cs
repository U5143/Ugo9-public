// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// Ugo9 sample: one character in a conversation scene, using only the parts games
// need most (no code of its own for looking, blinking or the mouth).
// Put this on an empty GameObject in a 2D scene with an orthographic camera, set
// the model (samples/basic) and the expression preset basic.ug9x next to this
// script (or one of your own), press Play.
//   mouse: the character looks at it    1-9: expressions (0: none)
//   hold Space: talk (the mouth follows a made-up voice; set lipSyncSource on the
//   character to use a real AudioSource instead)    A: next animation, mixed in 0.3 s
using UnityEngine;

namespace Ugo9.Samples
{
    public sealed class UgoConversation : MonoBehaviour
    {
        public UgoModel model;
        [Tooltip("Optional: an expression preset (.ug9x); its expressions come before the model's own.")]
        public TextAsset expressions;

        UgoCharacter c_;
        string[] exprs_ = new string[0];
        string[] anims_ = new string[0];
        int anim_, expr_ = -1;
        float voiceT_;

        void Start()
        {
            c_ = new GameObject("character").AddComponent<UgoCharacter>();
            c_.model = model;
            c_.autoBlink = true;
            anims_ = model.AnimationNames;
            if (anims_.Length > 0) c_.Play(anims_[0]);
            c_.UpdateNow(); // the model is bound now, so presets can be read
            if (expressions != null)
                foreach (var name in c_.LoadExpressions(expressions)) Debug.Log("Ugo9 sample: the model has no parameter " + name);
            var list = new System.Collections.Generic.List<string>();
            if (expressions != null) list.AddRange(new Ugo9.Core.UgoExpressionPreset(expressions.text, model.Data).Expressions.ConvertAll(x => x.Id));
            foreach (var n in c_.ExpressionNames) if (!list.Contains(n)) list.Add(n);
            exprs_ = list.ToArray();
        }

        void Update()
        {
            var cam = Camera.main;
            float h = cam.orthographicSize * 2;
            c_.transform.position = cam.transform.position + new Vector3(0, -h / 2, 10);
            c_.transform.localScale = Vector3.one * (h * model.pixelsPerUnit / model.Data.CanvasHeight);

            // looking: the helper turns face, eyes and body; it eases in and out by itself
            c_.LookAt(cam.ScreenToWorldPoint(MousePosition()));

            // expressions: 1..9 show one (the others fade out), 0 hides them all
            for (int i = 0; i <= 9; i++)
            {
                if (!KeyDown(KeyCode.Alpha0 + i)) continue;
                if (i == 0 || i > exprs_.Length) { c_.OnlyExpressions(); expr_ = -1; }
                else { c_.OnlyExpressions(exprs_[i - 1]); expr_ = i - 1; }
            }

            // talking: a made-up voice (syllables of 0.1-0.2 s); negative gives the mouth back to the animation
            if (KeyHeld(KeyCode.Space))
            {
                voiceT_ += Time.deltaTime;
                c_.SetMouthLevel(Mathf.Clamp01(0.55f + 0.45f * Mathf.Sin(voiceT_ * 31) * Mathf.Sin(voiceT_ * 7.3f)));
            }
            else c_.SetMouthLevel(-1);

            // animations: mixed over 0.3 s
            if (KeyDown(KeyCode.A) && anims_.Length > 0)
            {
                anim_ = (anim_ + 1) % anims_.Length;
                c_.Play(anims_[anim_], 0, 0.3f);
            }
        }

#if ENABLE_INPUT_SYSTEM && !ENABLE_LEGACY_INPUT_MANAGER
        static UnityEngine.InputSystem.Controls.KeyControl Key(KeyCode k)
        {
            var kb = UnityEngine.InputSystem.Keyboard.current;
            if (kb == null) return null;
            if (k == KeyCode.Alpha0) return kb[UnityEngine.InputSystem.Key.Digit0];
            if (k >= KeyCode.Alpha1 && k <= KeyCode.Alpha9) return kb[UnityEngine.InputSystem.Key.Digit1 + (k - KeyCode.Alpha1)]; // Digit0 comes after Digit9
            return k == KeyCode.A ? kb.aKey : kb.spaceKey;
        }
        static bool KeyDown(KeyCode k) => Key(k)?.wasPressedThisFrame ?? false;
        static bool KeyHeld(KeyCode k) => Key(k)?.isPressed ?? false;
        static Vector3 MousePosition()
        {
            var mouse = UnityEngine.InputSystem.Mouse.current;
            return mouse != null ? (Vector3)mouse.position.ReadValue() : Vector3.zero;
        }
#else
        static bool KeyDown(KeyCode k) => Input.GetKeyDown(k);
        static bool KeyHeld(KeyCode k) => Input.GetKey(k);
        static Vector3 MousePosition() => Input.mousePosition;
#endif

        void OnGUI()
        {
            string e = expr_ >= 0 ? exprs_[expr_] : "none";
            string a = anims_.Length > 0 ? anims_[anim_] : "-";
            string text = $"expression: {e} (1-{Mathf.Min(9, exprs_.Length)}, 0: none)   animation: {a} (A: next)   hold Space: talk   mouse: look";
            GUI.color = Color.black;
            GUI.Label(new Rect(12, 8, 900, 24), text);
        }
    }
}
