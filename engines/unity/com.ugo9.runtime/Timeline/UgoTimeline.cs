// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// Timeline: an "Ugo9 Animation" track bound to a UgoCharacter, with clips that each play one of
// the model's animations by name. Overlapping clips cross-fade (Timeline's blend curves), a clip
// easing in mixes over whatever the character shows already, clip-in and speed work as for
// any clip (a looping animation keeps looping however long the clip is), and scrubbing shows
// the pose in the editor. Only when the Timeline package is in the project
// (Ugo9.Timeline.asmdef: UGO9_TIMELINE from com.unity.timeline).
using System;
using UnityEngine;
using UnityEngine.Playables;
using UnityEngine.Timeline;
using Ugo9.Core;

namespace Ugo9
{
    [Serializable]
    public sealed class UgoAnimationBehaviour : PlayableBehaviour
    {
        public string animation = "";
    }

    /// <summary>A clip on an Ugo9 Animation track: one of the model's animations, by name.</summary>
    [Serializable]
    public sealed class UgoAnimationClip : PlayableAsset, ITimelineClipAsset
    {
        [Tooltip("The model's animation to play (its name).")]
        public string animation = "";

        public ClipCaps clipCaps => ClipCaps.Blending | ClipCaps.ClipIn | ClipCaps.SpeedMultiplier | ClipCaps.Extrapolation; // loops: the core wraps a looping animation itself;

        public override Playable CreatePlayable(PlayableGraph graph, GameObject owner)
        {
            var p = ScriptPlayable<UgoAnimationBehaviour>.Create(graph);
            p.GetBehaviour().animation = animation;
            return p;
        }
    }

    /// <summary>A track that plays the bound character's animations from its clips.</summary>
    [TrackColor(0.95f, 0.55f, 0.35f)]
    [TrackClipType(typeof(UgoAnimationClip))]
    [TrackBindingType(typeof(UgoCharacter))]
    public sealed class UgoAnimationTrack : TrackAsset
    {
        public override Playable CreateTrackMixer(PlayableGraph graph, GameObject go, int inputCount)
        {
            foreach (var c in GetClips())
            {
                if (c.asset is UgoAnimationClip a && !string.IsNullOrEmpty(a.animation)) c.displayName = a.animation;
            }
            return ScriptPlayable<UgoAnimationMixer>.Create(graph, inputCount);
        }
    }

    /// <summary>Each frame: the clips under the playhead, as weighted blends on the character (UgoCharacter.AddBlend).</summary>
    public sealed class UgoAnimationMixer : PlayableBehaviour
    {
        float[] weights_ = Array.Empty<float>(), applied_ = Array.Empty<float>();

        public override void ProcessFrame(Playable playable, FrameData info, object playerData)
        {
            var c = playerData as UgoCharacter;
            if (c == null) return;
            int n = playable.GetInputCount();
            if (weights_.Length < n) { weights_ = new float[n]; applied_ = new float[n]; }
            for (int i = 0; i < n; i++) weights_[i] = playable.GetInputWeight(i);
            UgoMix.Sequential(weights_, n, applied_);
            bool any = false;
            for (int i = 0; i < n; i++)
            {
                if (applied_[i] <= 0) continue;
                var input = (ScriptPlayable<UgoAnimationBehaviour>)playable.GetInput(i);
                var b = input.GetBehaviour();
                if (b == null || string.IsNullOrEmpty(b.animation)) continue;
                c.AddBlend(b.animation, (float)input.GetTime(), applied_[i]);
                any = true;
            }
#if UNITY_EDITOR
            // scrubbing outside Play mode: run the player loop once more so the character draws this pose
            if (any && !Application.isPlaying) UnityEditor.EditorApplication.QueuePlayerLoopUpdate();
#endif
        }
    }
}
