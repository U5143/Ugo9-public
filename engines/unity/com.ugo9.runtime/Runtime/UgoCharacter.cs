// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// UgoCharacter: one Ugo9 character. Under a UgoBatch it is drawn together with
// the batch's other characters; on its own it draws itself. The model's origin
// (0, 0) sits at the transform's position; model pixels become units through
// the model's pixelsPerUnit (y up).
using System;
using System.Collections.Generic;
using UnityEngine;
using Ugo9.Core;

namespace Ugo9
{
    [DefaultExecutionOrder(1000)] // after game scripts, so values set in Update/LateUpdate show this frame
    [ExecuteAlways]
    public sealed class UgoCharacter : MonoBehaviour
    {
        public UgoModel model;
        [Tooltip("The animation that plays (its name).")]
        public string animation = "";
        public bool playing = true;
        public float speed = 1;
        public float time;
        [Tooltip("The clock and physics move only with Advance() (lockstep games, replays, tests).")]
        public bool manual;
        [Tooltip("Parameter values set in the Inspector (kept, like SetParam; applied before it).")]
        public List<ParamValue> parameters = new List<ParamValue>();
        [Tooltip("An expression shown from the start (the model's, or a loaded preset's).")]
        public string expression = "";
        [Tooltip("Play the animation in the Scene view while not in Play mode.")]
        public bool previewInEditor = true;
        [Tooltip("The whole character's colour and transparency (multiplied with every part, like SpriteRenderer.color).")]
        public Color color = Color.white;
        [Tooltip("Under a UgoBatch: characters with a higher order draw in front (equal orders keep the hierarchy order). With Sort With Sprites: the Order in Layer.")]
        public int sortingOrder;
        [Tooltip("Not under a UgoBatch: draw as an ordinary renderer, so the character sorts with sprites by Sorting Layer and Order in Layer (one draw per run of parts; a UgoBatch draws many characters in fewer).")]
        public bool sortWithSprites;
        [Tooltip("The Sorting Layer when Sort With Sprites is on.")]
        public string sortingLayerName = "Default";
        [Tooltip("Wind on the swaying chains (hair, cloth): model pixels per second², x right, y up. Not on parameter physics.")]
        public Vector2 wind;
        [Tooltip("How much the wind's strength wavers over time (0: steady).")]
        public float windGust;

        [Header("Helpers")]
        [Tooltip("Face, eyes and a little of the body turn towards this (AngleX/Y, EyeBallX/Y, BodyAngleX).")]
        public Transform lookTarget;
        [Tooltip("Where the face is, in model pixels from the model's origin (y down); (0, 0): a quarter down the canvas.")]
        public Vector2 lookFrom;
        [Tooltip("Blink on its own (EyeOpenL/EyeOpenR).")]
        public bool autoBlink;
        [Tooltip("The mouth (MouthOpen) follows this sound's loudness while it plays.")]
        public AudioSource lipSyncSource;
        [Tooltip("Loudness is multiplied by this before the gate (2: +6 dB).")]
        public float lipSyncGain = 1;
        [Tooltip("The noise gate: sounds quieter than this (dB) leave the mouth shut; the mouth is fully open this many dB above it.")]
        public float lipSyncGateDb = -45, lipSyncRangeDb = 25;
        /// <summary>The lip-sync's noise gate (attack and hold times too).</summary>
        public UgoVoiceGate VoiceGate { get; } = new UgoVoiceGate();
        /// <summary>The helpers' settings (names of the parameters they move, ranges, smoothing).</summary>
        public UgoHelpers Helpers { get; } = new UgoHelpers();
        Vector3? lookPoint_;
        float[] audio_;

        /// <summary>Looks at this world point until StopLooking (lookTarget, when set, wins).</summary>
        public void LookAt(Vector3 worldPoint) => lookPoint_ = worldPoint;
        public void StopLooking() { lookPoint_ = null; lookTarget = null; }
        /// <summary>The mouth's opening, 0..1 (e.g. from your own audio analysis); negative: back to the animation.</summary>
        public void SetMouthLevel(float level) { lipSyncSource = null; Helpers.MouthLevel = level; }

        [Serializable] public sealed class ParamValue { public string name; public float value; }
        string exprShown_;

        UgoInstanceData instance_;
        UgoModelData built_;
        int anim_ = -1;
        string animBuilt_;
        float pendingDt_;
        readonly Dictionary<int, float> overrides_ = new Dictionary<int, float>();
        readonly List<(int anim, float time, float weight)> blends_ = new List<(int, float, float)>();
        readonly UgoExpressionMixer expressions_ = new UgoExpressionMixer();
        // animation switching: the animation fading out, the queue, the end of a non-looping one
        int fromAnim_ = -1;
        float fromTime_, fadeT_, fadeTotal_;
        bool finished_;
        readonly List<(string name, float fade)> queue_ = new List<(string, float)>();
        UgoDrawer drawer_; // only when not under a batch
        readonly List<UgoCharacter> self_ = new List<UgoCharacter>(1);

        UgoModelData Data => model != null ? model.Data : null;

        bool Ready()
        {
            var data = Data;
            if (data == null) { instance_?.Dispose(); instance_ = null; built_ = null; return false; }
            if (built_ != data)
            {
                // parameter numbers belong to a model: forget them only when the model changes
                // (values set before the first update, e.g. right after AddComponent, stay)
                if (built_ != null) overrides_.Clear();
                instance_?.Dispose();
                instance_ = new UgoInstanceData(data);
                built_ = data;
                expressions_.Bind(data);
                layers_.Bind(data);
                animBuilt_ = null;
                exprShown_ = null;
            }
            if (animBuilt_ != animation) { anim_ = data.FindAnimation(animation); animBuilt_ = animation; finished_ = false; }
            if (exprShown_ != expression)
            {
                if (!string.IsNullOrEmpty(exprShown_)) expressions_.Hide(exprShown_, 0);
                if (!string.IsNullOrEmpty(expression)) expressions_.Show(expression, 0);
                exprShown_ = expression;
            }
            return true;
        }

        /// <summary>
        /// Plays an animation from fromTime. fade &gt; 0: the animation playing now keeps going and is
        /// blended out over that many seconds (the new one is blended in over the same time).
        /// </summary>
        public void Play(string name, float fromTime = 0, float fade = 0)
        {
            if (fade > 0 && Ready() && anim_ >= 0) { fromAnim_ = anim_; fromTime_ = time; fadeTotal_ = fade; fadeT_ = 0; }
            else fromAnim_ = -1;
            animation = name; time = fromTime; playing = true; finished_ = false;
            queue_.Clear();
        }
        /// <summary>Plays this animation when the current one (not looping) ends, blending over fade seconds.</summary>
        public void PlayNext(string name, float fade = 0) => queue_.Add((name, fade));
        public void Stop() => playing = false;
        /// <summary>The current animation, if it does not loop, has reached its end.</summary>
        public bool IsFinished => finished_;
        /// <summary>A non-looping animation reached its end (its name). Raised from Update / Advance.</summary>
        public event Action<string> AnimationFinished;

        /// <summary>A value set here stays until cleared (applied after the animations).</summary>
        public void SetParam(string name, float value)
        {
            int i = Data?.FindParameter(name) ?? -1;
            if (i >= 0) overrides_[i] = value;
        }
        public void ClearParam(string name) { int i = Data?.FindParameter(name) ?? -1; overrides_.Remove(i); }
        public void ClearParams() => overrides_.Clear();
        /// <summary>The value after the last update (animation, SetParam and physics).</summary>
        public float GetParam(string name) => Ready() ? instance_.GetParam(Data.FindParameter(name)) : 0;
        /// <summary>An extra animation blended over the main one at the next update only (call it every frame).</summary>
        public void AddBlend(string name, float atTime, float weight)
        {
            int a = Data?.FindAnimation(name) ?? -1;
            if (a >= 0) blends_.Add((a, atTime, weight));
        }
        public void ResetPhysics() { if (Ready()) instance_.ResetPhysics(); }

        // ---- expressions (format 0.8) ----
        /// <summary>The model's own expressions.</summary>
        public string[] ExpressionNames => Data?.ExpressionNames ?? Array.Empty<string>();
        /// <summary>Fades an expression in (the model's, or one from LoadExpressions); fade &lt; 0: its own fade-in time.</summary>
        public void ShowExpression(string name, float fade = -1) { if (Ready()) expressions_.Show(name, fade); }
        /// <summary>Fades an expression out; fade &lt; 0: its own fade-out time.</summary>
        public void HideExpression(string name, float fade = -1) { if (Ready()) expressions_.Hide(name, fade); }
        /// <summary>Shows only these expressions; the others fade out.</summary>
        public void OnlyExpressions(params string[] names) { if (Ready()) expressions_.Only(names); }
        public float ExpressionWeight(string name) => expressions_.Weight(name);
        /// <summary>Loads an expression preset (JSON, "ugo9-expressions"). Returns the parameter names this model lacks.</summary>
        public List<string> LoadExpressions(string json) => Ready() ? expressions_.Load(json) : new List<string>();
        /// <summary>Loads an expression preset imported from a .ug9x file.</summary>
        public List<string> LoadExpressions(TextAsset preset) => LoadExpressions(preset.text);

        // ---- layers above the main animation (1, 2, ...): added or mixed on top, on all tracks or a mask's ----
        readonly UgoLayers layers_ = new UgoLayers();
        /// <summary>A layer's animation that does not loop reached its end: (layer, name).</summary>
        public event Action<int, string> LayerFinished
        {
            add => layers_.Finished += Wrap(value);
            remove => layers_.Finished -= Wrap(value);
        }
        readonly Dictionary<Action<int, string>, Action<int, string>> wrapped_ = new Dictionary<Action<int, string>, Action<int, string>>();
        Action<int, string> Wrap(Action<int, string> f)
        {
            if (!wrapped_.TryGetValue(f, out var w)) wrapped_[f] = w = (i, n) => f(i + 1, n);
            return w;
        }

        static int LayerIndex(int layer)
        {
            if (layer < 1) throw new ArgumentOutOfRangeException(nameof(layer), "Ugo9: layers start at 1 (layer 0 is the main animation: Play)");
            return layer - 1;
        }

        /// <summary>
        /// Plays an animation on a layer above the main one (1, 2, ...), mixing in over fade seconds. additive: adds its change
        /// from the rest pose (e.g. a nod on top of any pose); mask (MakeMask): only those bones / parts / parameters. False: no such animation.
        /// </summary>
        public bool PlayLayer(int layer, string name, float fade = 0.25f, bool additive = false, UgoAnimMask mask = null, float weight = 1, bool? loop = null, float layerSpeed = 1)
            => Ready() && layers_.Play(LayerIndex(layer), name, fade, loop, layerSpeed, weight, additive, mask) != null;
        /// <summary>Plays it on the layer after the current one ends (a looping one: at the end of its loop).</summary>
        public bool QueueLayer(int layer, string name, float fade = 0.25f, bool additive = false, UgoAnimMask mask = null, float weight = 1, bool? loop = null, float layerSpeed = 1)
            => Ready() && layers_.Queue(LayerIndex(layer), name, fade, loop, layerSpeed, weight, additive, mask) != null;
        /// <summary>Fades the layer out over fade seconds (and drops its queue).</summary>
        public void StopLayer(int layer, float fade = 0.25f) => layers_.Stop(LayerIndex(layer), fade);
        /// <summary>The whole layer's weight (0..1), e.g. to fade a masked arm in and out.</summary>
        public void SetLayerWeight(int layer, float weight) => layers_.SetWeight(LayerIndex(layer), weight);
        public float GetLayerWeight(int layer) => layers_.GetWeight(LayerIndex(layer));
        /// <summary>The animation playing on the layer, or null.</summary>
        public string LayerAnimation(int layer) => layers_.Current(LayerIndex(layer))?.Name;
        /// <summary>A mask for PlayLayer: only these bones, parts and parameters (null: all of that kind). Keep it and reuse it.</summary>
        public UgoAnimMask MakeMask(string[] bones = null, string[] parts = null, string[] parameters = null)
            => Ready() ? Data.MakeMask(bones, parts, parameters) : null;

        /// <summary>Moves the clock and the physics (manual mode, or called by Update otherwise).</summary>
        public void Advance(float delta)
        {
            pendingDt_ += delta;
            if (!playing || !Ready()) return;
            time += delta * speed;
            layers_.Update(delta * speed);
            if (fromAnim_ >= 0)
            {
                fromTime_ += delta * speed;
                fadeT_ += delta;
                if (fadeT_ >= fadeTotal_) fromAnim_ = -1;
            }
            float d = anim_ >= 0 ? Data.AnimationDuration(anim_) : 0;
            if (anim_ >= 0 && d > 0 && !Data.AnimationLoops(anim_) && time >= d && !finished_)
            {
                finished_ = true;
                string ended = animation;
                AnimationFinished?.Invoke(ended);
                if (queue_.Count > 0 && animation == ended) // (a handler may have started something else)
                {
                    var (next, fade) = queue_[0];
                    queue_.RemoveAt(0);
                    var rest = new List<(string, float)>(queue_);
                    Play(next, 0, fade);
                    queue_.AddRange(rest);
                }
            }
            if (d > 0 && time > 2 * d) time = d + (time - d) % d; // keep the clock small: looping and clamped look the same
        }

        void Update()
        {
            if (!manual && Application.isPlaying) Advance(Time.deltaTime);
        }

#if UNITY_EDITOR
        // outside Play mode: the editor's clock moves the animation (previewInEditor), and the views repaint
        double editorLast_;
        void OnEnable()
        {
            if (Application.isPlaying) return;
            editorLast_ = UnityEditor.EditorApplication.timeSinceStartup;
            UnityEditor.EditorApplication.update += EditorTick;
        }
        void EditorTick()
        {
            if (this == null) { UnityEditor.EditorApplication.update -= EditorTick; return; }
            double now = UnityEditor.EditorApplication.timeSinceStartup;
            float dt = (float)Math.Min(0.1, now - editorLast_);
            editorLast_ = now;
            if (Application.isPlaying || !previewInEditor || manual || !isActiveAndEnabled) return;
            Advance(dt);
            UnityEditor.EditorApplication.QueuePlayerLoopUpdate();
        }
#endif

        /// <summary>Runs the core now (normally done just before drawing), e.g. to read GetParam in the same frame.</summary>
        public void UpdateNow() => Evaluate(Matrix4x4.identity);

        // placement: this transform relative to the drawing owner, turned into model pixels (y down)
        internal void Evaluate(Matrix4x4 relative)
        {
            if (!Ready()) return;
            instance_.ResetParams();
            if (fromAnim_ >= 0 && fadeTotal_ > 0)
            {
                // a cross-fade: the one before at full weight, the new one over it
                instance_.ApplyAnimation(fromAnim_, fromTime_, 1);
                if (anim_ >= 0) instance_.ApplyAnimation(anim_, time, Math.Min(1, fadeT_ / fadeTotal_));
            }
            else if (anim_ >= 0) instance_.ApplyAnimation(anim_, time, 1);
            foreach (var b in blends_) instance_.ApplyAnimation(b.anim, b.time, b.weight);
            blends_.Clear();
            layers_.Apply(instance_);
            foreach (var p in parameters) if (p != null) instance_.SetParam(Data.FindParameter(p.name), p.value);
            foreach (var kv in overrides_) instance_.SetParam(kv.Key, kv.Value);
            // expressions after the animations and SetParam, before the update (physics follows them)
            expressions_.Update(pendingDt_);
            expressions_.Apply(instance_);
            ApplyHelpers();
            // placement before the update: swaying chains feel how far the character moved
            float ppu = model.pixelsPerUnit;
            instance_.SetTransform(relative.m00, -relative.m10, -relative.m01, relative.m11, relative.m03 * ppu, -relative.m13 * ppu);
            instance_.SetWind(wind.x, -wind.y, windGust);
            instance_.Update(pendingDt_);
            pendingDt_ = 0;
            // reaching: from the pose just made, then once more to show it (and let constraints follow)
            if (reach_.Count > 0)
            {
                foreach (var r in reach_) instance_.SolveIK(r.bone, r.chain, r.target.x, r.target.y);
                reach_.Clear();
                instance_.Update(0);
            }
        }

        void ApplyHelpers()
        {
            var data = Data;
            float ppu = model.pixelsPerUnit;
            Vector3? at = lookTarget != null ? lookTarget.position : lookPoint_;
            Helpers.Looking = at.HasValue;
            if (at.HasValue)
            {
                Vector3 local = transform.InverseTransformPoint(at.Value); // units, y up
                Vector2 face = lookFrom != Vector2.zero ? lookFrom : new Vector2(data.CanvasWidth / 2 - data.OriginX, data.CanvasHeight / 4 - data.OriginY);
                Helpers.LookX = local.x * ppu - face.x;
                Helpers.LookY = -local.y * ppu - face.y;
            }
            Helpers.AutoBlink = autoBlink;
            if (lipSyncSource != null)
            {
                float db = -100;
                if (lipSyncSource.isPlaying)
                {
                    if (audio_ == null) audio_ = new float[256];
                    lipSyncSource.GetOutputData(audio_, 0);
                    double sum = 0;
                    foreach (var s in audio_) sum += s * s;
                    db = Math.Max(-100, 10 * (float)Math.Log10(sum / audio_.Length + 1e-12) + 20 * (float)Math.Log10(Math.Max(1e-6f, lipSyncGain)));
                }
                VoiceGate.GateDb = lipSyncGateDb;
                VoiceGate.RangeDb = lipSyncRangeDb;
                Helpers.MouthLevel = VoiceGate.Update(db, pendingDt_);
            }
            Helpers.Apply(data, instance_, pendingDt_);
        }

        internal bool CanDraw => isActiveAndEnabled && Ready();
        // ---- picking (clicks, taps) and bounds, by part name ----

        /// <summary>A world point in model pixels (x right, y down), through this character's transform.</summary>
        public Vector2 WorldToModel(Vector3 worldPoint)
        {
            Vector3 local = transform.InverseTransformPoint(worldPoint);
            float ppu = model != null ? model.pixelsPerUnit : 100;
            return new Vector2(local.x * ppu, -local.y * ppu);
        }

        /// <summary>A point in model pixels back to the world.</summary>
        public Vector3 ModelToWorld(Vector2 modelPoint)
        {
            float upp = 1f / Mathf.Max(1e-6f, model != null ? model.pixelsPerUnit : 100);
            return transform.TransformPoint(new Vector3(modelPoint.x * upp, -modelPoint.y * upp, 0));
        }

        /// <summary>
        /// The name of the part drawn in front at this world point (e.g. the mouse's, through Camera.ScreenToWorldPoint),
        /// or null. As drawn in the last frame: draw order, masks; hidden parts and parts at minOpacity or below are skipped.
        /// </summary>
        public string PartAt(Vector3 worldPoint, float minOpacity = 0.01f)
        {
            if (!Ready()) return null;
            Vector2 p = WorldToModel(worldPoint);
            int part = instance_.PickPart(p.x, p.y, minOpacity);
            return part >= 0 ? Data.PartNames[part] : null;
        }

        /// <summary>
        /// The hit area at this world point ("head" for a part named "hit:head" or "当たり:head"; the parts need not be drawn),
        /// or null. Areas are found on the meshes as of the last frame, whatever their opacity.
        /// </summary>
        public string AreaAt(Vector3 worldPoint)
        {
            if (!Ready() || Data.AreaNames.Length == 0) return null;
            Vector2 p = WorldToModel(worldPoint);
            int part = instance_.PickArea(p.x, p.y, Data.AreaMask);
            return part >= 0 ? Data.AreaOfPart[part] : null;
        }
        /// <summary>The model's hit areas, by name.</summary>
        public string[] AreaNames => Data?.AreaNames ?? Array.Empty<string>();

        // ---- bones in the world: attach things, reach for a point ----
        readonly float[] bone6_ = new float[6];
        readonly List<(int bone, int chain, Vector2 target)> reach_ = new List<(int, int, Vector2)>();

        /// <summary>Where the bone is in the world, as of the last frame (e.g. to put a sword in a hand). Null: no such bone.</summary>
        public Vector3? BonePosition(string bone)
        {
            int b = Ready() ? Data.FindBone(bone) : -1;
            if (b < 0) return null;
            instance_.BoneWorld(b, bone6_);
            return ModelToWorld(new Vector2(bone6_[4], bone6_[5]));
        }

        /// <summary>The bone's angle in the world, degrees (counter-clockwise, as Transform's z), as of the last frame.</summary>
        public float BoneRotation(string bone)
        {
            int b = Ready() ? Data.FindBone(bone) : -1;
            if (b < 0) return 0;
            instance_.BoneWorld(b, bone6_);
            // model pixels are y down: an angle there turns the other way on screen
            return -Mathf.Atan2(bone6_[1], bone6_[0]) * Mathf.Rad2Deg + transform.eulerAngles.z;
        }

        /// <summary>
        /// This frame, turn the bone and up to chain - 1 of its parents so its tip reaches the world point (an arm to a
        /// door handle, a head to a target). Call every frame while it should reach; after the animations and SetParam.
        /// </summary>
        public void ReachFor(string bone, Vector3 worldPoint, int chain = 2)
        {
            int b = Ready() ? Data.FindBone(bone) : -1;
            if (b >= 0) reach_.Add((b, Math.Max(1, chain), WorldToModel(worldPoint)));
        }

        /// <summary>True when some part is drawn at this world point.</summary>
        public bool HitTest(Vector3 worldPoint, float minOpacity = 0.01f) => PartAt(worldPoint, minOpacity) != null;

        /// <summary>The world-space box around a part (by name) as drawn in the last frame, or around the whole character (null). Null when there is nothing.</summary>
        public Bounds? PartBounds(string part = null)
        {
            if (!Ready()) return null;
            int i = part == null ? -1 : Array.IndexOf(Data.PartNames, part);
            if (part != null && i < 0) return null;
            if (!instance_.Bounds(i, out float x0, out float y0, out float x1, out float y1)) return null;
            var b = new Bounds(ModelToWorld(new Vector2(x0, y0)), Vector3.zero);
            b.Encapsulate(ModelToWorld(new Vector2(x1, y0)));
            b.Encapsulate(ModelToWorld(new Vector2(x0, y1)));
            b.Encapsulate(ModelToWorld(new Vector2(x1, y1)));
            return b;
        }

        internal void CopyFrame(float[] dst, int offset)
        {
            instance_.CopyFrame(dst, offset);
            UgoInstanceData.WriteTint(dst, offset, color.r, color.g, color.b, color.a);
        }
        internal uint DrawOrderKey => instance_.DrawOrderKey;
        internal void CopyDrawOrder(uint[] dst) => instance_.CopyDrawOrder(dst);

        // where the character can be, in world space (for culling)
        internal Bounds WorldBounds(Bounds localPixels, float unitsPerPixel)
        {
            // the core's box around this frame's vertices (cheap, never too small), else the model's padded one
            if (instance_ != null && instance_.BoundsEstimate(out float x0, out float y0, out float x1, out float y1))
                localPixels = new Bounds(new Vector3((x0 + x1) / 2, (y0 + y1) / 2, 0), new Vector3(x1 - x0, y1 - y0, 0));
            Vector3 c = localPixels.center, e = localPixels.extents;
            Matrix4x4 m = transform.localToWorldMatrix;
            Bounds b = default;
            for (int k = 0; k < 4; k++)
            {
                float x = c.x + ((k & 1) == 0 ? -e.x : e.x), y = c.y + ((k & 2) == 0 ? -e.y : e.y);
                var w = m.MultiplyPoint3x4(new Vector3(x * unitsPerPixel, -y * unitsPerPixel, 0));
                if (k == 0) b = new Bounds(w, Vector3.zero); else b.Encapsulate(w);
            }
            return b;
        }

        internal Matrix4x4 RelativeTo(Transform owner) => owner.worldToLocalMatrix * transform.localToWorldMatrix;

        // not under a batch: one character, placed in world space (so swaying chains feel it move)
        void LateUpdate()
        {
            if (GetComponentInParent<UgoBatch>() != null) { drawer_?.Dispose(); drawer_ = null; if (renderer_ != null) renderer_.enabled = false; return; }
            if (!CanDraw) return;
            if (drawer_ == null || drawer_.Model != model || !drawer_.Current) { drawer_?.Dispose(); drawer_ = new UgoDrawer(model); }
            Evaluate(transform.localToWorldMatrix);
            if (sortWithSprites)
            {
                // a hidden child holds the renderer (nothing is added to the scene's objects)
                if (rendererHost_ == null)
                {
                    rendererHost_ = new GameObject("Ugo9 renderer") { hideFlags = HideFlags.HideAndDontSave };
                    rendererHost_.transform.SetParent(transform, false);
                    rendererFilter_ = rendererHost_.AddComponent<MeshFilter>();
                    renderer_ = rendererHost_.AddComponent<MeshRenderer>();
                }
                rendererHost_.layer = gameObject.layer;
                renderer_.enabled = true;
                renderer_.sortingLayerName = sortingLayerName;
                renderer_.sortingOrder = sortingOrder;
                drawer_.PrepareRenderer(this, rendererFilter_, renderer_);
                return;
            }
            if (renderer_ != null) renderer_.enabled = false;
            self_.Clear();
            self_.Add(this);
            drawQueue_ ??= UgoQueues.Add();
            drawer_.QueueBase = UgoQueues.BaseFor(drawQueue_);
            drawer_.Draw(self_, null, gameObject.layer);
            drawQueue_.Order = sortingOrder;
            drawQueue_.Center = drawer_.Center;
            drawQueue_.Slots = drawer_.QueuesUsed;
        }
        UgoQueues.Owner drawQueue_;
        GameObject rendererHost_;
        MeshFilter rendererFilter_;
        MeshRenderer renderer_;

        void OnDisable()
        {
            if (rendererHost_ != null)
            {
                if (Application.isPlaying) Destroy(rendererHost_); else DestroyImmediate(rendererHost_);
                rendererHost_ = null; rendererFilter_ = null; renderer_ = null;
            }
#if UNITY_EDITOR
            UnityEditor.EditorApplication.update -= EditorTick;
#endif
            drawer_?.Dispose();
            drawer_ = null;
            UgoQueues.Remove(drawQueue_);
            drawQueue_ = null;
        }

        void OnDestroy()
        {
            instance_?.Dispose();
            instance_ = null;
        }
    }
}
