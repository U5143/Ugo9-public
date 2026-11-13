// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// Stand-ins for the few UnityEngine / UnityEditor members the Ugo9 package
// uses, with the same signatures as Unity's (2022.3 / 6), so the package's C#
// can be compile-checked without Unity: dotnet build tests/unity_compile.
// They do nothing; the real check is in Unity (docs/エンジン.md).
#pragma warning disable CS0626, CS0067, CS1591
using System;
using System.Collections.Generic;

namespace UnityEngine
{
    public class Object { public string name; public HideFlags hideFlags; public static void Destroy(Object o) { } public static void DestroyImmediate(Object o) { } public static implicit operator bool(Object o) => o != null; }
    public enum HideFlags { None = 0, HideAndDontSave = 61 }
    public class ScriptableObject : Object { public static T CreateInstance<T>() where T : ScriptableObject, new() => new T(); }
    public class Component : Object { Transform transform_; public Transform transform => transform_ ??= this as Transform ?? new Transform(); public GameObject gameObject => null; public T GetComponentInParent<T>() => default; public void GetComponentsInChildren<T>(bool includeInactive, List<T> result) { } }
    public class Behaviour : Component { public bool enabled; public bool isActiveAndEnabled => true; }
    public class MonoBehaviour : Behaviour { }
    public class GameObject : Object { public GameObject(string name) { } public int layer; public string tag; public Transform transform => null; public T AddComponent<T>() where T : Component, new() => new T(); }
    public class Transform : Component, System.Collections.IEnumerable
    {
        public Matrix4x4 localToWorldMatrix; public Matrix4x4 worldToLocalMatrix;
        public Vector3 position; public Vector3 forward; public Vector3 localPosition; public Quaternion localRotation; public Vector3 localScale;
        public void SetParent(Transform p, bool worldPositionStays) { }
        public Vector3 InverseTransformPoint(Vector3 p) => p; public Vector3 TransformPoint(Vector3 p) => p; public Vector3 eulerAngles; public Vector3 lossyScale => Vector3.one;
        public int childCount => 0; public Transform GetChild(int i) => null;
        public System.Collections.IEnumerator GetEnumerator() => null;
    }
    public struct Quaternion { public static Quaternion Euler(float x, float y, float z) => default; }
    public struct Rect { public Rect(float x, float y, float w, float h) { } }
    public enum CameraClearFlags { SolidColor = 2 }
    public class Camera : Behaviour { public static Camera main => null; public bool orthographic; public float orthographicSize; public float aspect; public CameraClearFlags clearFlags; public Color backgroundColor; public RenderTexture targetTexture; public Vector3 ScreenToWorldPoint(Vector3 p) => p; }
    public class TextAsset : Object { public TextAsset() { } public TextAsset(string text) { } public string text => ""; }
    public static class JsonUtility { public static T FromJson<T>(string s) => default; public static string ToJson(object o, bool pretty) => ""; }
    public static class QualitySettings { public static ColorSpace activeColorSpace => default; public static int vSyncCount; }
    public static class Screen { public static int width => 0; public static int height => 0; }
    public class WaitForSeconds { public WaitForSeconds(float s) { } }
    public struct FrameTiming { public double cpuMainThreadFrameTime; }
    public static class FrameTimingManager { public static void CaptureFrameTimings() { } public static uint GetLatestTimings(uint n, FrameTiming[] t) => 0; }
    public enum ColorSpace { Gamma = 0, Linear = 1 }
    public sealed class WaitForEndOfFrame { }
    public static class Input { public static bool GetKeyDown(KeyCode k) => false; public static bool GetKey(KeyCode k) => false; public static bool GetMouseButtonDown(int b) => false; public static Vector3 mousePosition => default; }
    public enum KeyCode { Space = 32, Alpha0 = 48, Alpha1, Alpha2, Alpha3, Alpha4, Alpha5, Alpha6, Alpha7, Alpha8, Alpha9, A = 97, UpArrow = 273, DownArrow = 274 }
    public static class Random { public static float value => 0; public static float Range(float a, float b) => a; }
    public class AudioClip : Object { public int samples => 0; public bool GetData(float[] data, int offset) => true; }
    public static class Microphone { public static string[] devices => new string[0]; public static AudioClip Start(string d, bool loop, int seconds, int rate) => null; public static void End(string d) { } public static int GetPosition(string d) => 0; }
    public class AudioSource : Behaviour { public bool isPlaying => false; public void GetOutputData(float[] samples, int channel) { } }
    [AttributeUsage(AttributeTargets.Field)] public sealed class HeaderAttribute : Attribute { public HeaderAttribute(string h) { } }
    public static class GUILayout { public static bool Button(string text) => false; public static void Label(string t) { } public static bool Toggle(bool v, string t) => v; public static float HorizontalSlider(float v, float lo, float hi) => v; public static void BeginArea(Rect r) { } public static void EndArea() { } public static Vector2 BeginScrollView(Vector2 p) => p; public static void EndScrollView() { } }
    public static class GUI { public static Color color; public static Color contentColor; public static void Label(Rect r, string t) { } public static void DrawTexture(Rect r, Texture t) { } public static GUISkin skin => null; }
    public class GUISkin { public GUIStyle label; }
    public class GUIStyle { public Vector2 CalcSize(GUIContent c) => default; }
    public class GUIContent { public GUIContent(string text) { } }
    public static class ImageConversion { public static byte[] EncodeToPNG(this Texture2D t) => null; public static bool LoadImage(this Texture2D t, byte[] data, bool markNonReadable) => false; }
    public class Shader : Object { public static Shader Find(string n) => null; }
    public static class Resources { public static T Load<T>(string path) where T : Object => null; }
    public class Material : Object { public Material(Shader s) { } public void SetFloat(string n, float v) { } public void EnableKeyword(string k) { } public void DisableKeyword(string k) { } public int renderQueue { get; set; } }
    public class Texture : Object { public FilterMode filterMode; public TextureWrapMode wrapMode; public int width; public int height; }
    public class Texture2D : Texture
    {
        public Texture2D(int w, int h, TextureFormat f, bool mipChain, bool linear) { }
        public static Texture2D whiteTexture => null;
        public void SetPixelData<T>(T[] data, int mipLevel, int sourceDataStartIndex = 0) { }
        public void Apply(bool updateMipmaps, bool makeNoLongerReadable) { }
        public void Apply() { }
        public Texture2D(int w, int h, TextureFormat f, bool mipChain) { }
        public Color32[] GetPixels32() => new Color32[0];
        public void SetPixels32(Color32[] colors, int miplevel = 0) { }
        public void ReadPixels(Rect source, int destX, int destY) { }
    }
    public class Texture2DArray : Texture
    {
        public Texture2DArray(int w, int h, int depth, TextureFormat f, bool mipChain) { }
        public void SetPixels32(Color32[] colors, int arrayElement, int miplevel = 0) { }
        public void Apply(bool updateMipmaps, bool makeNoLongerReadable) { }
    }
    public struct Color32 { public byte r, g, b, a; public Color32(byte r, byte g, byte b, byte a) { this.r = r; this.g = g; this.b = b; this.a = a; } }
    public class RenderTexture : Texture
    {
        public RenderTexture(int w, int h, int depth, RenderTextureFormat f) { }
        public static RenderTexture active;
        public RenderTexture(int w, int h, int depth, RenderTextureFormat f, RenderTextureReadWrite rw) { }
        public Rendering.TextureDimension dimension; public int volumeDepth; public bool useMipMap;
        public bool Create() => true; public void Release() { }
    }
    public enum TextureFormat { RGBA32 = 4, RGBAFloat = 20 }
    public enum RenderTextureFormat { ARGB32 = 0 }
    public enum RenderTextureReadWrite { Default = 0, Linear = 1 }
    public enum FilterMode { Point = 0, Bilinear = 1, Trilinear = 2 }
    public enum TextureWrapMode { Repeat = 0, Clamp = 1 }
    public enum MeshTopology { Triangles = 0 }
    public enum CubemapFace { Unknown = -1 }
    public class Mesh : Object
    {
        public Rendering.IndexFormat indexFormat; public Vector3[] vertices; public Vector2[] uv; public Bounds bounds;
        public void SetIndices(int[] indices, MeshTopology t, int submesh, bool calculateBounds) { }
        public void UploadMeshData(bool markNoLongerReadable) { }
        public int subMeshCount { get; set; }
    }
    public class MeshFilter : Component { public Mesh sharedMesh; }
    public class Renderer : Component
    {
        public bool enabled; public Material[] sharedMaterials; public Bounds localBounds; public string sortingLayerName; public int sortingOrder;
        public void SetPropertyBlock(MaterialPropertyBlock p) { }
    }
    public class MeshRenderer : Renderer { }
    public struct Vector2 { public float x, y; public Vector2(float x, float y) { this.x = x; this.y = y; } public static Vector2 zero => default; public static bool operator ==(Vector2 a, Vector2 b) => a.x == b.x && a.y == b.y; public static bool operator !=(Vector2 a, Vector2 b) => !(a == b); public override bool Equals(object o) => o is Vector2 v && v == this; public override int GetHashCode() => 0; public static implicit operator Vector2(Vector3 v) => new Vector2(v.x, v.y); public static implicit operator Vector3(Vector2 v) => new Vector3(v.x, v.y, 0); }
    public struct Vector3 { public float x, y, z; public Vector3(float x, float y, float z) { this.x = x; this.y = y; this.z = z; } public static Vector3 zero => default; public static Vector3 one => new Vector3(1, 1, 1); public static Vector3 operator *(Vector3 a, float d) => a; public static Vector3 operator /(Vector3 a, float d) => a; public static Vector3 operator +(Vector3 a, Vector3 b) => a; public static Vector3 operator -(Vector3 a, Vector3 b) => a; public static float Dot(Vector3 a, Vector3 b) => a.x * b.x + a.y * b.y + a.z * b.z; }
    public struct Vector4 { public Vector4(float x, float y, float z, float w) { } }
    public struct Color { public float r, g, b, a; public Color(float r, float g, float b, float a) { this.r = r; this.g = g; this.b = b; this.a = a; } public static Color clear => default; public static Color black => new Color(0, 0, 0, 1); public static Color white => new Color(1, 1, 1, 1); }
    public struct Bounds { public Bounds(Vector3 c, Vector3 s) { center = c; extents = s; } public Vector3 center; public Vector3 extents; public Vector3 size => extents; public void Encapsulate(Vector3 p) { } public void Encapsulate(Bounds b) { } }
    public struct Matrix4x4
    {
        public float m00, m01, m02, m03, m10, m11, m12, m13, m20, m21, m22, m23, m30, m31, m32, m33;
        public static Matrix4x4 identity => new Matrix4x4 { m00 = 1, m11 = 1, m22 = 1, m33 = 1 };
        public static Matrix4x4 operator *(Matrix4x4 a, Matrix4x4 b) => a;
        public Vector3 MultiplyPoint3x4(Vector3 p) => p;
    }
    public static class Mathf
    {
        public const float Rad2Deg = 57.29578f;
        public static float Clamp01(float v) => Math.Max(0, Math.Min(1, v)); public static float Sin(float v) => (float)Math.Sin(v); public static float Atan2(float y, float x) => (float)Math.Atan2(y, x); public static float Log10(float v) => (float)Math.Log10(v); public static bool Approximately(float a, float b) => Math.Abs(a - b) < 1e-6f;
        public static float Max(float a, float b) => Math.Max(a, b); public static int Max(int a, int b) => Math.Max(a, b);
        public static float Min(float a, float b) => Math.Min(a, b); public static int Min(int a, int b) => Math.Min(a, b);
        public static float Sqrt(float f) => (float)Math.Sqrt(f); public static int CeilToInt(float f) => (int)Math.Ceiling(f);
        public static float Clamp(float v, float a, float b) => Math.Max(a, Math.Min(b, v));
    }
    public static class Debug { public static void LogError(object m, Object context) { } public static void LogWarning(object m, Object context) { } public static void Log(object m) { } public static bool isDebugBuild => false; }
    public static class Application { public static bool isPlaying => true; public static string unityVersion => ""; public static void Quit() { } public static int targetFrameRate; public static string persistentDataPath => ""; }
    public static class Time { public static float deltaTime => 0; public static float smoothDeltaTime => 0; public static float realtimeSinceStartup => 0; public static float unscaledDeltaTime => 0; public static int frameCount => 0; }
    public static class SystemInfo { public static bool graphicsUVStartsAtTop => true; public static string graphicsDeviceName => ""; public static bool supportsRenderTargetArrayIndexFromVertexShader => true; public static string graphicsDeviceType => ""; public static string operatingSystem => ""; public static string processorType => ""; }
    public class MaterialPropertyBlock
    {
        public void SetTexture(string n, Texture t) { } public void SetInteger(string n, int v) { } public void SetFloat(string n, float v) { }
        public void SetVector(string n, Vector4 v) { } public void SetMatrix(string n, Matrix4x4 m) { }
    }
    public struct RenderParams
    {
        public RenderParams(Material mat) { material = mat; matProps = null; worldBounds = default; layer = 0; shadowCastingMode = default; receiveShadows = true; }
        public Material material; public MaterialPropertyBlock matProps; public Bounds worldBounds; public int layer;
        public Rendering.ShadowCastingMode shadowCastingMode; public bool receiveShadows;
    }
    public static class Graphics
    {
        public static void RenderMeshPrimitives(in RenderParams rparams, Mesh mesh, int submeshIndex, int instanceCount = 1) { }
        public static void ExecuteCommandBuffer(Rendering.CommandBuffer buffer) { }
    }
    [AttributeUsage(AttributeTargets.Class)] public sealed class DefaultExecutionOrder : Attribute { public DefaultExecutionOrder(int order) { } }
    [AttributeUsage(AttributeTargets.Class)] public sealed class ExecuteAlways : Attribute { }
    [AttributeUsage(AttributeTargets.Class)] public sealed class CreateAssetMenuAttribute : Attribute { public string menuName; }
    [AttributeUsage(AttributeTargets.Field)] public sealed class SerializeField : Attribute { }
    [AttributeUsage(AttributeTargets.Field)] public sealed class HideInInspector : Attribute { }
    [AttributeUsage(AttributeTargets.Field)] public sealed class TooltipAttribute : Attribute { public TooltipAttribute(string t) { } }
}

namespace UnityEngine.Rendering
{
    public class RenderPipelineAsset : UnityEngine.Object { }
    public static class GraphicsSettings { public static RenderPipelineAsset currentRenderPipeline => null; }
    public enum IndexFormat { UInt16 = 0, UInt32 = 1 }
    public enum RenderQueue { Background = 1000, Geometry = 2000, AlphaTest = 2450, Transparent = 3000, Overlay = 4000 }
    public enum BlendMode { Zero = 0, One = 1, DstColor = 2, SrcColor = 3, OneMinusDstColor = 4, SrcAlpha = 5, OneMinusSrcColor = 6, DstAlpha = 7, OneMinusDstAlpha = 8, SrcAlphaSaturate = 9, OneMinusSrcAlpha = 10 }
    public enum BlendOp { Add = 0, Max = 4 }
    public enum ShadowCastingMode { Off = 0, On = 1 }
    public enum TextureDimension { Tex2D = 2, Tex2DArray = 5 }
    public struct RenderTargetIdentifier { public static implicit operator RenderTargetIdentifier(Texture t) => default; }
    public class CommandBuffer
    {
        public string name;
        public void Clear() { } public void Release() { }
        public void SetRenderTarget(RenderTargetIdentifier rt, int mipLevel, CubemapFace cubemapFace, int depthSlice) { }
        public void ClearRenderTarget(bool clearDepth, bool clearColor, Color backgroundColor) { }
        public void SetGlobalInteger(string name, int value) { }
        public void DrawMeshInstancedProcedural(Mesh mesh, int submeshIndex, Material material, int shaderPass, int count, MaterialPropertyBlock properties = null) { }
    }
}

namespace UnityEditor
{
    public static class EditorApplication { public static bool isPlaying; public static double timeSinceStartup => 0; public static Action update; public static void QueuePlayerLoopUpdate() { } }
    [AttributeUsage(AttributeTargets.Class)] public sealed class CustomEditorAttribute : Attribute { public CustomEditorAttribute(Type t) { } }
    public class SerializedObject { public void Update() { } public bool ApplyModifiedProperties() => true; }
    public class Editor : UnityEngine.Object
    {
        public UnityEngine.Object target => null; public SerializedObject serializedObject => null;
        public virtual void OnInspectorGUI() { }
        public static void DrawPropertiesExcluding(SerializedObject o, params string[] names) { }
    }
    public enum MessageType { None, Info, Warning, Error }
    public static class EditorGUILayout
    {
        public static int Popup(string label, int selected, string[] options) => 0;
        public static float Slider(string label, float v, float min, float max) => v;
        public static bool Foldout(bool open, string label) => open;
        public static void HelpBox(string text, MessageType t) { }
    }
    public static class EditorGUI { public static void BeginChangeCheck() { } public static bool EndChangeCheck() => false; }
    public static class Undo { public static void RecordObject(UnityEngine.Object o, string name) { } }
    public static class EditorUtility { public static void SetDirty(UnityEngine.Object o) { } }
    public static class AssetDatabase { public static T LoadAssetAtPath<T>(string path) where T : UnityEngine.Object => null; }
}

namespace UnityEditor.AssetImporters
{
    public abstract class ScriptedImporter : UnityEngine.Object { public abstract void OnImportAsset(AssetImportContext ctx); }
    [AttributeUsage(AttributeTargets.Class)] public sealed class ScriptedImporterAttribute : Attribute { public ScriptedImporterAttribute(int version, string ext) { } public ScriptedImporterAttribute(int version, string[] exts) { } }
    public class AssetImportContext
    {
        public string assetPath => "";
        public void LogImportError(string m, UnityEngine.Object o = null) { } public void LogImportWarning(string m, UnityEngine.Object o = null) { }
        public void DependsOnSourceAsset(string path) { }
        public void AddObjectToAsset(string id, UnityEngine.Object o) { } public void SetMainObject(UnityEngine.Object o) { }
    }
}

// the Input System package (compiled with -p:InputSystem=true)
namespace UnityEngine.InputSystem
{
    public class ButtonControl { public bool wasPressedThisFrame => false; public bool isPressed => false; }
    public class Vector2Control { public UnityEngine.Vector2 ReadValue() => default; }
    public enum Key { None = 0, Space = 1, A = 15, Digit1 = 41, Digit2, Digit3, Digit4, Digit5, Digit6, Digit7, Digit8, Digit9, Digit0 }
    public class Keyboard { public static Keyboard current => null; public Controls.KeyControl upArrowKey, downArrowKey, spaceKey, aKey; public Controls.KeyControl this[Key k] => null; }
    public class Mouse { public static Mouse current => null; public Vector2Control position; public ButtonControl leftButton; }
}
namespace UnityEngine.InputSystem.Controls
{
    public class KeyControl : UnityEngine.InputSystem.ButtonControl { }
}

namespace Unity.Profiling
{
    public struct ProfilerCategory { public static ProfilerCategory Render => default; public static ProfilerCategory Memory => default; }
    public struct ProfilerRecorder : System.IDisposable
    {
        public static ProfilerRecorder StartNew(ProfilerCategory c, string name, int capacity = 1) => default;
        public bool Valid => false; public long LastValue => 0; public void Dispose() { }
    }
}

// the Timeline package (engines/unity/com.ugo9.runtime/Timeline, only with com.unity.timeline)
namespace UnityEngine.Playables
{
    public struct PlayableGraph { }
    public struct FrameData { }
    public interface IPlayableBehaviour { }
    public abstract class PlayableBehaviour : IPlayableBehaviour
    {
        public virtual void ProcessFrame(Playable playable, FrameData info, object playerData) { }
    }
    public struct Playable
    {
        public int GetInputCount() => 0;
        public float GetInputWeight(int i) => 0;
        public Playable GetInput(int i) => default;
        public double GetTime() => 0;
    }
    public struct ScriptPlayable<T> where T : class, IPlayableBehaviour, new()
    {
        public static ScriptPlayable<T> Create(PlayableGraph graph, int inputCount = 0) => default;
        public T GetBehaviour() => null;
        public double GetTime() => 0;
        public static implicit operator Playable(ScriptPlayable<T> p) => default;
        public static explicit operator ScriptPlayable<T>(Playable p) => default;
    }
    public interface IPlayableAsset { }
    public abstract class PlayableAsset : ScriptableObject, IPlayableAsset
    {
        public abstract Playable CreatePlayable(PlayableGraph graph, GameObject owner);
    }
}
namespace UnityEngine.Timeline
{
    using System.Collections.Generic;
    using UnityEngine.Playables;
    [System.Flags] public enum ClipCaps { None = 0, Looping = 1, Extrapolation = 2, ClipIn = 4, SpeedMultiplier = 8, Blending = 16, All = 31 }
    public interface ITimelineClipAsset { ClipCaps clipCaps { get; } }
    public class TimelineClip { public Object asset; public string displayName; }
    public abstract class TrackAsset : PlayableAsset
    {
        public IEnumerable<TimelineClip> GetClips() => new TimelineClip[0];
        public virtual Playable CreateTrackMixer(PlayableGraph graph, GameObject go, int inputCount) => default;
        public override Playable CreatePlayable(PlayableGraph graph, GameObject owner) => default;
    }
    public sealed class TrackColorAttribute : System.Attribute { public TrackColorAttribute(float r, float g, float b) { } }
    public sealed class TrackClipTypeAttribute : System.Attribute { public TrackClipTypeAttribute(System.Type t) { } }
    public sealed class TrackBindingTypeAttribute : System.Attribute { public TrackBindingTypeAttribute(System.Type t) { } }
}
