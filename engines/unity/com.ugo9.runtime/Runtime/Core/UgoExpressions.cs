// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// Expressions (format 0.8): a smile, anger, ... that change parameters by name.
// The model's own expressions and presets read from JSON
//   { "format": "ugo9-expressions", "version": 1, "expressions": [
//       { "id": "smile", "fadeIn": 0.5, "fadeOut": 0.5, "params": { "MouthForm": ["set", 1] } } ] }
// are shown and hidden with fades by UgoExpressionMixer; the core matches the names
// and does the arithmetic. No Unity API here (tests run it against the C core).
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;

namespace Ugo9.Core
{
    /// <summary>Expressions read from a preset JSON, bound to one model's parameters.</summary>
    public sealed class UgoExpressionPreset
    {
        public sealed class Expression
        {
            public string Id;
            public float FadeIn = 0.5f, FadeOut = 0.5f;
            public string[] Names = Array.Empty<string>();
            public uint[] Ops = Array.Empty<uint>();
            public float[] Values = Array.Empty<float>();
            internal int[] Index = Array.Empty<int>();
        }

        public readonly List<Expression> Expressions = new List<Expression>();
        /// <summary>Parameter names the preset uses that the model does not have (each once).</summary>
        public readonly List<string> Missing = new List<string>();

        /// <summary>Reads the JSON and binds its names to the model's parameters (FormatException if it is not a preset).</summary>
        public UgoExpressionPreset(string json, UgoModelData model)
        {
            if (!(MiniJson.Parse(json) is Dictionary<string, object> root) || !(root.TryGetValue("format", out var f) && f as string == "ugo9-expressions"))
                throw new FormatException("Ugo9: not an expression preset (format \"ugo9-expressions\")");
            if (!(root.TryGetValue("expressions", out var list) && list is List<object> items)) return;
            foreach (var item in items)
            {
                if (!(item is Dictionary<string, object> e) || !(e.TryGetValue("id", out var id) && id is string sid)) continue;
                var x = new Expression { Id = sid };
                if (e.TryGetValue("fadeIn", out var fi) && fi is double fid) x.FadeIn = (float)fid;
                if (e.TryGetValue("fadeOut", out var fo) && fo is double fod) x.FadeOut = (float)fod;
                var names = new List<string>();
                var ops = new List<uint>();
                var values = new List<float>();
                if (e.TryGetValue("params", out var ps) && ps is Dictionary<string, object> pd)
                {
                    foreach (var kv in pd)
                    {
                        if (!(kv.Value is List<object> pair) || pair.Count < 2 || !(pair[1] is double v)) continue;
                        uint op = pair[0] as string == "set" ? UgoModelData.ExprSet : pair[0] as string == "add" ? UgoModelData.ExprAdd
                                : pair[0] as string == "multiply" ? UgoModelData.ExprMultiply : uint.MaxValue; // unknown: skipped by the core
                        names.Add(kv.Key); ops.Add(op); values.Add((float)v);
                    }
                }
                x.Names = names.ToArray(); x.Ops = ops.ToArray(); x.Values = values.ToArray();
                x.Index = new int[x.Names.Length];
                model.ResolveParams(x.Names, x.Index);
                for (int i = 0; i < x.Names.Length; i++) if (x.Index[i] < 0 && !Missing.Contains(x.Names[i])) Missing.Add(x.Names[i]);
                Expressions.Add(x);
            }
        }

        public Expression Find(string id) => Expressions.Find(x => x.Id == id);
    }

    /// <summary>
    /// Expressions shown on one character with fades: Show/Hide move each one's weight towards 1 or 0
    /// over its fade time (Update), Apply puts them on the instance in the order they were shown.
    /// Names are looked up in the loaded presets first, then in the model's own expressions.
    /// </summary>
    public sealed class UgoExpressionMixer
    {
        sealed class Active { public string name; public float weight, target, fade; }
        readonly List<Active> active_ = new List<Active>();
        readonly List<UgoExpressionPreset> presets_ = new List<UgoExpressionPreset>();
        UgoModelData model_;

        /// <summary>Forgets everything when the model changes.</summary>
        public void Bind(UgoModelData model)
        {
            if (model_ == model) return;
            model_ = model;
            active_.Clear();
            presets_.Clear();
        }

        /// <summary>Loads a preset (its names override the model's expressions of the same name). Returns the parameters the model lacks.</summary>
        public List<string> Load(string json)
        {
            if (model_ == null) throw new InvalidOperationException("Ugo9: no model");
            var p = new UgoExpressionPreset(json, model_);
            presets_.Insert(0, p);
            return p.Missing;
        }

        UgoExpressionPreset.Expression FindPreset(string name)
        {
            foreach (var p in presets_) { var x = p.Find(name); if (x != null) return x; }
            return null;
        }

        /// <summary>True when the model or a loaded preset has an expression of this name.</summary>
        public bool Has(string name) => FindPreset(name) != null || (model_ != null && model_.FindExpression(name) >= 0);

        (float fadeIn, float fadeOut) FadeOf(string name)
        {
            var x = FindPreset(name);
            if (x != null) return (x.FadeIn, x.FadeOut);
            int e = model_ != null ? model_.FindExpression(name) : -1;
            return e >= 0 ? model_.ExpressionFade(e) : (0, 0);
        }

        /// <summary>Fades the expression in (fade &lt; 0: its own fade-in time).</summary>
        public void Show(string name, float fade = -1)
        {
            var a = active_.Find(x => x.name == name);
            if (a == null) active_.Add(a = new Active { name = name });
            a.target = 1;
            a.fade = fade >= 0 ? fade : FadeOf(name).fadeIn;
        }

        /// <summary>Fades the expression out (fade &lt; 0: its own fade-out time).</summary>
        public void Hide(string name, float fade = -1)
        {
            var a = active_.Find(x => x.name == name);
            if (a == null) return;
            a.target = 0;
            a.fade = fade >= 0 ? fade : FadeOf(name).fadeOut;
        }

        /// <summary>Shows only these; the others fade out.</summary>
        public void Only(params string[] names)
        {
            foreach (var a in active_) if (Array.IndexOf(names, a.name) < 0) Hide(a.name);
            foreach (var n in names) Show(n);
        }

        public void HideAll() { foreach (var a in active_) Hide(a.name); }

        /// <summary>The current weight of the expression (0 when not shown).</summary>
        public float Weight(string name) => active_.Find(x => x.name == name)?.weight ?? 0;

        public void Update(float dt)
        {
            foreach (var a in active_)
            {
                float step = a.fade > 0 ? dt / a.fade : 1;
                a.weight = a.target > a.weight ? Math.Min(a.target, a.weight + step) : Math.Max(a.target, a.weight - step);
            }
            active_.RemoveAll(a => a.weight <= 0 && a.target <= 0);
        }

        /// <summary>Applies the shown expressions (after the animations and SetParam, before Update).</summary>
        public void Apply(UgoInstanceData instance)
        {
            foreach (var a in active_)
            {
                if (a.weight <= 0) continue;
                var x = FindPreset(a.name);
                if (x != null) instance.ApplyParams(x.Index, x.Ops, x.Values, a.weight);
                else instance.ApplyExpression(model_.FindExpression(a.name), a.weight);
            }
        }
    }

    /// <summary>A small JSON reader: objects (Dictionary), arrays (List), strings, numbers (double), true/false, null.</summary>
    public static class MiniJson
    {
        public static object Parse(string s)
        {
            int i = 0;
            var v = Value(s, ref i);
            Space(s, ref i);
            if (i != s.Length) throw new FormatException($"Ugo9: unexpected text in JSON at {i}");
            return v;
        }

        static void Space(string s, ref int i) { while (i < s.Length && char.IsWhiteSpace(s[i])) i++; }

        static object Value(string s, ref int i)
        {
            Space(s, ref i);
            if (i >= s.Length) throw new FormatException("Ugo9: JSON ends early");
            char c = s[i];
            if (c == '{')
            {
                var d = new Dictionary<string, object>();
                i++; Space(s, ref i);
                if (i < s.Length && s[i] == '}') { i++; return d; }
                while (true)
                {
                    Space(s, ref i);
                    string k = Str(s, ref i);
                    Space(s, ref i);
                    Expect(s, ref i, ':');
                    d[k] = Value(s, ref i);
                    Space(s, ref i);
                    if (i < s.Length && s[i] == ',') { i++; continue; }
                    Expect(s, ref i, '}');
                    return d;
                }
            }
            if (c == '[')
            {
                var l = new List<object>();
                i++; Space(s, ref i);
                if (i < s.Length && s[i] == ']') { i++; return l; }
                while (true)
                {
                    l.Add(Value(s, ref i));
                    Space(s, ref i);
                    if (i < s.Length && s[i] == ',') { i++; continue; }
                    Expect(s, ref i, ']');
                    return l;
                }
            }
            if (c == '"') return Str(s, ref i);
            if (Word(s, ref i, "true")) return true;
            if (Word(s, ref i, "false")) return false;
            if (Word(s, ref i, "null")) return null;
            int start = i;
            while (i < s.Length && "+-0123456789.eE".IndexOf(s[i]) >= 0) i++;
            if (start == i || !double.TryParse(s.Substring(start, i - start), NumberStyles.Float, CultureInfo.InvariantCulture, out var d2))
                throw new FormatException($"Ugo9: bad JSON value at {start}");
            return d2;
        }

        static bool Word(string s, ref int i, string w)
        {
            if (string.CompareOrdinal(s, i, w, 0, w.Length) != 0) return false;
            i += w.Length;
            return true;
        }

        static void Expect(string s, ref int i, char c)
        {
            if (i >= s.Length || s[i] != c) throw new FormatException($"Ugo9: expected '{c}' in JSON at {i}");
            i++;
        }

        static string Str(string s, ref int i)
        {
            Expect(s, ref i, '"');
            var b = new StringBuilder();
            while (i < s.Length && s[i] != '"')
            {
                char c = s[i++];
                if (c != '\\') { b.Append(c); continue; }
                if (i >= s.Length) break;
                char e = s[i++];
                switch (e)
                {
                    case 'n': b.Append('\n'); break;
                    case 't': b.Append('\t'); break;
                    case 'r': b.Append('\r'); break;
                    case 'b': b.Append('\b'); break;
                    case 'f': b.Append('\f'); break;
                    case 'u':
                        if (i + 4 > s.Length) throw new FormatException("Ugo9: bad \\u escape in JSON");
                        b.Append((char)Convert.ToInt32(s.Substring(i, 4), 16));
                        i += 4;
                        break;
                    default: b.Append(e); break;
                }
            }
            Expect(s, ref i, '"');
            return b.ToString();
        }
    }
}
