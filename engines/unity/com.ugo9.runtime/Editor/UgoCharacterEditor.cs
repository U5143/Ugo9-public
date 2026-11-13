// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// The UgoCharacter Inspector: the animation and the expression picked from the model's
// names, a slider per parameter (kept in `parameters`), and the preview clock.
using System;
using System.Linq;
using UnityEditor;
using UnityEngine;

namespace Ugo9.Editor
{
    [CustomEditor(typeof(UgoCharacter))]
    public sealed class UgoCharacterEditor : UnityEditor.Editor
    {
        bool showParams_ = true;

        public override void OnInspectorGUI()
        {
            var c = (UgoCharacter)target;
            serializedObject.Update();
            DrawPropertiesExcluding(serializedObject, "animation", "expression", "parameters", "m_Script");
            serializedObject.ApplyModifiedProperties();
            var data = c.model != null ? c.model.Data : null;
            if (data == null) { EditorGUILayout.HelpBox("Set a model (a .ug9 asset).", MessageType.Info); return; }

            // the animation and the expression, by name ("(none)" first)
            string Pick(string label, string current, string[] names)
            {
                var options = new[] { "(none)" }.Concat(names).ToArray();
                int at = Math.Max(0, Array.IndexOf(options, current));
                int chosen = EditorGUILayout.Popup(label, string.IsNullOrEmpty(current) ? 0 : at, options);
                return chosen == 0 ? "" : options[chosen];
            }
            EditorGUI.BeginChangeCheck();
            string anim = Pick("Animation", c.animation, data.AnimationNames);
            string expr = Pick("Expression", c.expression, data.ExpressionNames);
            if (EditorGUI.EndChangeCheck())
            {
                Undo.RecordObject(c, "Ugo9 animation / expression");
                c.animation = anim;
                c.expression = expr;
                EditorUtility.SetDirty(c);
            }
            if (!Application.isPlaying && !c.previewInEditor)
            {
                EditorGUI.BeginChangeCheck();
                int a = data.FindAnimation(c.animation);
                float t = EditorGUILayout.Slider("Time", c.time, 0, a >= 0 ? Math.Max(0.01f, data.AnimationDuration(a)) : 1);
                if (EditorGUI.EndChangeCheck()) { Undo.RecordObject(c, "Ugo9 time"); c.time = t; EditorUtility.SetDirty(c); }
            }

            // a slider per parameter: moving one keeps the value in `parameters`
            showParams_ = EditorGUILayout.Foldout(showParams_, $"Parameters ({c.parameters.Count} set)");
            if (!showParams_) return;
            for (int i = 0; i < data.ParameterCount; i++)
            {
                string name = data.ParameterNames[i];
                var set = c.parameters.Find(p => p != null && p.name == name);
                float shown = set != null ? set.value : (Application.isPlaying ? c.GetParam(name) : data.ParameterDefault(i));
                EditorGUI.BeginChangeCheck();
                float v = EditorGUILayout.Slider(set != null ? name + " *" : name, shown, data.ParameterMin(i), data.ParameterMax(i));
                if (!EditorGUI.EndChangeCheck()) continue;
                Undo.RecordObject(c, "Ugo9 parameter");
                if (set == null) c.parameters.Add(set = new UgoCharacter.ParamValue { name = name });
                set.value = v;
                EditorUtility.SetDirty(c);
            }
            if (c.parameters.Count > 0 && GUILayout.Button("Clear the parameters set here"))
            {
                Undo.RecordObject(c, "Ugo9 parameters");
                c.parameters.Clear();
                EditorUtility.SetDirty(c);
            }
        }
    }
}
