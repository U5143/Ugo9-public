// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// Helpers games use with most characters: looking at something (face, eyes and a little
// of the body turn towards it), blinking on its own, and the mouth following a level
// (lip-sync from a sound's loudness). They write the usual parameters by name: the standard
// names (docs/パラメータの名前.md: HeadTurnX/Y, PupilX/Y, BodyTurnX, EyeOpenL/R, MouthOpen) first,
// then the older ones (AngleX/Y, EyeBallX/Y, BodyAngleX); a model without either skips it.
// They run after the animations and SetParam and before the update, with the same rules as
// the Web's UgoLook. No Unity API here (tests run it against the C core).
using System.Collections.Generic;
using System;

namespace Ugo9.Core
{
    public sealed class UgoHelpers
    {
        // ---- names (change them for a model that uses others) ----
        public string AngleX = "HeadTurnX", AngleY = "HeadTurnY", EyeBallX = "PupilX", EyeBallY = "PupilY", BodyAngleX = "BodyTurnX";
        /// <summary>A standard name the model lacks is looked up again under its older name.</summary>
        public static readonly Dictionary<string, string> OlderNames = new Dictionary<string, string>
        {
            ["HeadTurnX"] = "AngleX", ["HeadTurnY"] = "AngleY", ["PupilX"] = "EyeBallX", ["PupilY"] = "EyeBallY", ["BodyTurnX"] = "BodyAngleX",
        };
        static int Find(UgoModelData model, string name)
        {
            int i = model.FindParameter(name);
            return i < 0 && OlderNames.TryGetValue(name, out var old) ? model.FindParameter(old) : i;
        }
        public string[] BlinkParams = { "EyeOpenL", "EyeOpenR" };
        public string MouthParam = "MouthOpen";

        // ---- looking ----
        /// <summary>Where the target is, from the face, in model pixels (x right, y down), and whether to look.</summary>
        public float LookX, LookY;
        public bool Looking;
        /// <summary>The distance (model pixels) at which the face turns all the way.</summary>
        public float LookRange = 400;
        /// <summary>Seconds to get most of the way there (0: at once).</summary>
        public float LookSmoothing = 0.12f;
        /// <summary>How much of BodyAngleX's range the body follows (0..1).</summary>
        public float LookBody = 0.3f;
        float lx_, ly_, lookWeight_;

        // ---- blinking ----
        public bool AutoBlink;
        /// <summary>Seconds between blinks (a random time in this range).</summary>
        public float BlinkMin = 2, BlinkMax = 6;
        public float BlinkClose = 0.07f, BlinkOpen = 0.12f;
        float blinkWait_ = -1, blinkT_ = -1;
        uint seed_ = 12345;

        // ---- mouth ----
        /// <summary>0..1, e.g. a sound's loudness; negative: the mouth is left to the animation.</summary>
        public float MouthLevel = -1;
        /// <summary>Seconds to follow the level (opening is quicker than closing).</summary>
        public float MouthSmoothing = 0.06f;
        float mouth_;

        /// <summary>The eyes' openness the blink gives now (1 open, 0 shut).</summary>
        public float BlinkOpenness { get; private set; } = 1;

        public void SetSeed(uint seed) { seed_ = seed == 0 ? 1 : seed; blinkWait_ = -1; }
        float Random01() { seed_ ^= seed_ << 13; seed_ ^= seed_ >> 17; seed_ ^= seed_ << 5; return (seed_ & 0xffffff) / 16777216f; }

        static float Follow(float current, float target, float smoothing, float dt) =>
            smoothing <= 0 ? target : current + (target - current) * (1 - (float)Math.Exp(-dt / smoothing));

        /// <summary>Moves the helpers on by dt and writes their parameters (after SetParam, before Update).</summary>
        public void Apply(UgoModelData model, UgoInstanceData instance, float dt)
        {
            // looking: fade in and out with the same smoothing, so turning away is gentle too
            lookWeight_ = Follow(lookWeight_, Looking ? 1 : 0, LookSmoothing, dt);
            float nx = Looking ? Math.Max(-1, Math.Min(1, LookX / Math.Max(1, LookRange))) : lx_;
            float ny = Looking ? Math.Max(-1, Math.Min(1, LookY / Math.Max(1, LookRange))) : ly_;
            lx_ = Follow(lx_, nx, LookSmoothing, dt);
            ly_ = Follow(ly_, ny, LookSmoothing, dt);
            if (lookWeight_ > 1e-4f)
            {
                Blend(model, instance, AngleX, lx_, 1, lookWeight_);
                Blend(model, instance, AngleY, -ly_, 1, lookWeight_);
                Blend(model, instance, EyeBallX, lx_, 1, lookWeight_);
                Blend(model, instance, EyeBallY, -ly_, 1, lookWeight_);
                Blend(model, instance, BodyAngleX, lx_, LookBody, lookWeight_);
            }

            // blinking: wait, close, open
            if (AutoBlink)
            {
                if (blinkWait_ < 0) blinkWait_ = BlinkMin + (BlinkMax - BlinkMin) * Random01();
                if (blinkT_ < 0)
                {
                    blinkWait_ -= dt;
                    if (blinkWait_ <= 0) blinkT_ = 0;
                    BlinkOpenness = 1;
                }
                if (blinkT_ >= 0)
                {
                    blinkT_ += dt;
                    BlinkOpenness = blinkT_ < BlinkClose ? 1 - blinkT_ / BlinkClose : Math.Min(1, (blinkT_ - BlinkClose) / BlinkOpen);
                    if (blinkT_ >= BlinkClose + BlinkOpen) { blinkT_ = -1; blinkWait_ = -1; BlinkOpenness = 1; }
                }
                foreach (var n in BlinkParams)
                {
                    int i = model.FindParameter(n);
                    if (i >= 0) instance.SetParam(i, instance.GetParam(i) * BlinkOpenness);
                }
            }
            else BlinkOpenness = 1;

            // the mouth follows the level: quick to open, slower to close
            if (MouthLevel >= 0)
            {
                float target = Math.Max(0, Math.Min(1, MouthLevel));
                mouth_ = Follow(mouth_, target, target > mouth_ ? MouthSmoothing * 0.5f : MouthSmoothing, dt);
                int i = model.FindParameter(MouthParam);
                if (i >= 0) instance.SetParam(i, model.ParameterMin(i) + (model.ParameterMax(i) - model.ParameterMin(i)) * mouth_);
            }
        }

        // v <- v + (range * amount * part - v) * weight, where range is the parameter's reach on that side
        static void Blend(UgoModelData model, UgoInstanceData instance, string name, float amount, float part, float weight)
        {
            int i = Find(model, name);
            if (i < 0) return;
            float lo = model.ParameterMin(i), hi = model.ParameterMax(i), def = model.ParameterDefault(i);
            float target = def + (amount >= 0 ? (hi - def) : (def - lo)) * amount * part;
            float v = instance.GetParam(i);
            instance.SetParam(i, v + (target - v) * weight);
        }
    }

    /// <summary>
    /// A noise gate for lip-sync (the same numbers as the Web's VoiceLevel): the mouth opens once the voice stays above
    /// GateDb for Attack seconds, stays open until it has been below GateDb - 4 dB for Hold seconds, and opens by how far
    /// above the gate it is over RangeDb. Keyboard clicks and breathing stay shut.
    /// </summary>
    public sealed class UgoVoiceGate
    {
        public float GateDb = -45, RangeDb = 25, Attack = 0.05f, Hold = 0.12f;
        float above_, since_ = 1e9f;
        public bool Open { get; private set; }
        public float Level { get; private set; }

        /// <summary>Loudness now (dB of the RMS) and the time since the last call; returns the mouth's level 0..1.</summary>
        public float Update(float db, float dt)
        {
            above_ = db > GateDb ? above_ + dt : 0;
            if (!Open && above_ >= Attack) Open = true;
            if (Open)
            {
                since_ = db > GateDb - 4 ? 0 : since_ + dt;
                if (since_ > Hold) { Open = false; since_ = 1e9f; }
            }
            Level = Open ? Math.Max(0, Math.Min(1, (db - GateDb) / Math.Max(1e-3f, RangeDb))) : 0;
            return Level;
        }
    }

}
