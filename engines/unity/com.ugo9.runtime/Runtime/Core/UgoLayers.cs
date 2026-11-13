// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// Animation layers on top of a character's main animation (the same rules as the Web's
// UgoAnimator): each layer plays one animation at a time, cross-fades to the next, can wait
// in a queue, and is applied over the layers below it, either mixed towards (weight) or added
// (the animation's change from the rest pose), on all tracks or only those a mask names
// (e.g. waving with the right arm while walking, blinking or breathing on top).
// No Unity API here (tests run it against the C core).
using System;
using System.Collections.Generic;

namespace Ugo9.Core
{
    public sealed class UgoLayers
    {
        public sealed class Entry
        {
            public int Animation;
            public string Name;
            public float Time, Speed = 1, Weight = 1;
            public bool Loop, Additive, Done;
            public UgoAnimMask Mask;
            internal float Fade, From, To;
        }

        sealed class Layer
        {
            public Entry current, old;
            public float mix = 1, fadeTime, weight = 1;
            public readonly List<Entry> queue = new List<Entry>();
        }

        readonly List<Layer> layers_ = new List<Layer>();
        UgoModelData model_;

        /// <summary>Called when a layer's animation that does not loop reaches its end: (layer, name).</summary>
        public event Action<int, string> Finished;

        /// <summary>Forgets every layer when the model changes.</summary>
        public void Bind(UgoModelData model)
        {
            if (model_ == model) return;
            model_ = model;
            layers_.Clear();
        }

        Layer At(int i)
        {
            if (i < 0) throw new ArgumentOutOfRangeException(nameof(i));
            while (layers_.Count <= i) layers_.Add(null);
            return layers_[i] ??= new Layer();
        }

        Entry Make(string name, float fade, bool? loop, float speed, float weight, bool additive, UgoAnimMask mask)
        {
            int a = model_?.FindAnimation(name) ?? -1;
            if (a < 0) return null;
            float d = model_.AnimationDuration(a);
            return new Entry
            {
                Animation = a, Name = name, Loop = loop ?? model_.AnimationLoops(a), Speed = speed, Weight = weight,
                Additive = additive, Mask = mask, Fade = Math.Max(0, fade), From = 0, To = d,
            };
        }

        void Start(Layer l, Entry e)
        {
            if (l.current != null && e.Fade > 0) { l.old = l.current; l.mix = 0; l.fadeTime = e.Fade; }
            else { l.old = null; l.mix = 1; }
            l.current = e;
        }

        /// <summary>Plays an animation on a layer now, mixing in over fade seconds (null: no such animation).</summary>
        public Entry Play(int layer, string name, float fade = 0.25f, bool? loop = null, float speed = 1, float weight = 1, bool additive = false, UgoAnimMask mask = null)
        {
            var e = Make(name, fade, loop, speed, weight, additive, mask);
            if (e == null) return null;
            var l = At(layer);
            l.queue.Clear();
            Start(l, e);
            return e;
        }

        /// <summary>Plays it after the layer's current animation ends (a looping one ends at the end of its loop).</summary>
        public Entry Queue(int layer, string name, float fade = 0.25f, bool? loop = null, float speed = 1, float weight = 1, bool additive = false, UgoAnimMask mask = null)
        {
            var e = Make(name, fade, loop, speed, weight, additive, mask);
            if (e == null) return null;
            var l = At(layer);
            if (l.current == null) Start(l, e); else l.queue.Add(e);
            return e;
        }

        /// <summary>Fades the layer out over fade seconds and drops its queue.</summary>
        public void Stop(int layer, float fade = 0.25f)
        {
            if (layer < 0 || layer >= layers_.Count || layers_[layer] == null) return;
            var l = layers_[layer];
            l.queue.Clear();
            if (l.current == null) return;
            l.old = l.current; l.current = null; l.mix = 0; l.fadeTime = Math.Max(0, fade);
            if (l.fadeTime <= 0) { l.old = null; l.mix = 1; }
        }

        /// <summary>The whole layer's weight (0..1), on top of each animation's own.</summary>
        public void SetWeight(int layer, float weight) => At(layer).weight = Math.Max(0, Math.Min(1, weight));
        public float GetWeight(int layer) => layer >= 0 && layer < layers_.Count && layers_[layer] != null ? layers_[layer].weight : 1;

        /// <summary>The animation playing on the layer (null when none).</summary>
        public Entry Current(int layer) => layer >= 0 && layer < layers_.Count ? layers_[layer]?.current : null;

        public int Count => layers_.Count;

        /// <summary>Moves the clocks by dt seconds: speeds, loops, ends, fades, the queues.</summary>
        public void Update(float dt)
        {
            for (int i = 0; i < layers_.Count; i++)
            {
                var l = layers_[i];
                if (l == null) continue;
                foreach (var e in new[] { l.old, l.current })
                {
                    if (e == null || e.Done) continue;
                    e.Time += dt * e.Speed;
                    float len = e.To - e.From;
                    if (e.Loop && len > 0)
                    {
                        if (e.Time - e.From >= len && e == l.current && l.queue.Count > 0) { e.Time = e.To; e.Done = true; }
                        else e.Time = e.From + (((e.Time - e.From) % len) + len) % len;
                    }
                    else if (e.Time >= e.To || e.Time < e.From)
                    {
                        e.Time = Math.Min(e.To, Math.Max(e.From, e.Time));
                        if (!e.Done) { e.Done = true; if (e == l.current) Finished?.Invoke(i, e.Name); }
                    }
                }
                if (l.old != null)
                {
                    l.mix = l.fadeTime > 0 ? Math.Min(1, l.mix + dt / l.fadeTime) : 1;
                    if (l.mix >= 1) l.old = null;
                }
                if (l.current != null && l.current.Done && l.queue.Count > 0) { var n = l.queue[0]; l.queue.RemoveAt(0); Start(l, n); }
            }
        }

        /// <summary>Applies the layers in order (after the main animation, before SetParam and Update).</summary>
        public void Apply(UgoInstanceData instance)
        {
            foreach (var l in layers_)
            {
                if (l == null || l.weight <= 0) continue;
                if (l.old != null) // cross-fading: the old one in full under the new one; stopping: the old one fading out
                {
                    float w = l.weight * l.old.Weight * (l.old.Additive || l.current == null ? 1 - l.mix : 1);
                    if (w > 0) instance.ApplyAnimation(l.old.Animation, l.old.Time, w, l.old.Additive, l.old.Mask);
                }
                if (l.current != null)
                {
                    float w = l.weight * l.current.Weight * (l.old != null ? l.mix : 1);
                    if (w > 0) instance.ApplyAnimation(l.current.Animation, l.current.Time, w, l.current.Additive, l.current.Mask);
                }
            }
        }
    }

    /// <summary>
    /// Weights for applying clips one after another (v += (clip - v) · w) so that the result is their weighted
    /// average, with the rest (whatever was there before) keeping 1 - Σw when the clips' weights add up to less
    /// than 1 (a clip easing in from nothing). Used by the Timeline track.
    /// </summary>
    public static class UgoMix
    {
        public static void Sequential(float[] weights, int count, float[] applied)
        {
            float total = 0;
            for (int i = 0; i < count; i++) total += Math.Max(0, weights[i]);
            float sum = Math.Max(0, 1 - total); // the rest's share
            for (int i = 0; i < count; i++)
            {
                float w = Math.Max(0, weights[i]);
                sum += w;
                applied[i] = sum > 0 ? w / sum : 0;
            }
        }
    }
}
