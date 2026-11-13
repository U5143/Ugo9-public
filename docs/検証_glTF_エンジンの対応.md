# glTF 2.0 インポーターの対応状況 ― 2D キャラ（Live2D/Spine 風）を glTF で書き出して各エンジンで動かす場合

確認日：2026-10-29。書き分け：（確認済み 2026-10-29）＝ページ・ソースを開いて読んだ／（二次情報）＝検索結果の要約や第三者の記事だけ／（推測）＝自分の推論。
想定するキャラ：平らなメッシュ1枚（2k〜25k 頂点）、2D の骨（1頂点あたり最大4本の線形ブレンドスキニング）、モーフ（ブレンドシェイプ）10〜100個を sparse で保存、パーツごとの不透明度のアニメ（閉じ目のフェードインなど）、重なる半透明パーツの厳密な 2D 描画順、unlit・アルファブレンドの材質、骨とモーフ重みのアニメ、実行時に外部コード（フェイストラッキング・ゲーム状態）から動かす。

調べた版（いずれも 2026-10-29 時点の最新の安定版）
| 対象 | 版 | 根拠 |
|---|---|---|
| Unity glTFast（com.unity.cloud.gltfast） | 6.20.0（2026-08-25） | https://docs.unity3d.com/Packages/com.unity.cloud.gltfast@6.20/changelog/CHANGELOG.html （確認済み 2026-10-29） |
| UniGLTF / UniVRM | 0.131.4（10/19） | https://github.com/vrm-c/UniVRM/releases 、`Packages/UniGLTF/package.json`（確認済み 2026-10-29） |
| UnityGLTF（Khronos） | 2.24.0 | https://github.com/KhronosGroup/UnityGLTF/blob/master/package.json （確認済み 2026-10-29） |
| Unreal Engine Interchange glTF | 5.8（Epic のドキュメントの最新版の表示） | https://dev.epicgames.com/documentation/unreal-engine/API/Plugins/GLTFCore （確認済み 2026-10-29） |
| glTFRuntime（UE プラグイン） | VersionName 20260826、最終コミット 2026-10-14 | https://github.com/rdeioris/glTFRuntime （clone して確認済み 2026-10-29） |
| Godot | 4.7.2-stable（2026-08-18） | https://github.com/godotengine/godot/releases （確認済み 2026-10-29） |
| three.js | r186（npm 0.186.1、2026-09-24） | https://github.com/mrdoob/three.js/releases 、npm registry（確認済み 2026-10-29） |
| Babylon.js | 9.33.0（npm 2026-10-29） | https://github.com/BabylonJS/Babylon.js/blob/master/CHANGELOG.md 、npm registry（確認済み 2026-10-29） |

---

## 0. まとめの表

| 項目 | glTFast 6.20 | UniGLTF 0.131 | UnityGLTF 2.24 | UE 5.8 Interchange | glTFRuntime | Godot 4.7.2 | three.js r186 | Babylon 9.33 |
|---|---|---|---|---|---|---|---|---|
| 1頂点の関節数 | 4（JOINTS_0のみ） | 4（JOINTS_0のみ） | 未確認 | 4（JOINTS_1以降は捨てる） | 最大12（JOINTS_0〜2） | 8（JOINTS_1まで） | 4（JOINTS_0のみ） | 8（JOINTS_1まで） |
| モーフの計算場所 | GPU（Unity のコンピュート） | 同左 | 同左 | GPU（設定）／CPU | 同左 | GPU コンピュート（Forward+/Mobile）、Compatibility は transform feedback | 頂点シェーダ | 頂点シェーダ（テクスチャ方式） |
| モーフのコストが比例するもの | **動いている数**（重み0は飛ばす） | 同左 | 同左 | **動いている数**（ActiveMorphTargets） | 同左 | ループは**全数**、読み出しは動いている物だけ（Compatibility は動いている数） | ループは**全数**、読み出しは動いている物だけ | **全数**（glTF ローダーの既定、9.14〜）。設定で「動いている物だけ」にできるがシェーダが作り直される |
| sparse accessor | ○（位置とモーフのみ） | ○ | ○（ブレンドシェイプ） | 未確認 | ○ | ○ | ○ | ○ |
| weights（モーフ重み）アニメ | ○（legacy Animation） | ○（legacy、targetNames 必須） | ○ | ○は 5.6 以降が安定（掲示板の報告） | ○ | ○（Blend Shape トラック） | ○ | ○ |
| 骨（ノード TRS）のアニメ | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ |
| KHR_animation_pointer | × | × | ○（読み書き） | ×（拡張の一覧に無い） | × | ○（4.4〜） | 本体×、Needle のプラグインで○ | ○（5.18〜、6.49 で仕様に追従） |
| KHR_node_visibility | × | × | ○ | × | × | ○（4.5〜、アニメは 4.6〜） | × | ○（7.32〜、アニメ可） |
| KHR_materials_unlit | ○ | ○ | ○ | ○（拡張の一覧にある） | ○ | ○ | ○（MeshBasicMaterial） | ○ |
| BLEND の深度書き込み | 切る（Built-in で確認） | 切る（推測） | 未確認 | 切る（推測） | 切る（推測） | **Depth Pre-Pass**（α≥0.99 の画素は深度を書く） | 切る（depthWrite=false） | 切る（alpha モードで depth mask を切る） |
| 同じ深さの透明物の並び | renderQueue→距離。同距離は不定（推測） | 同左 | 同左 | 距離（既定は境界球の中心）。SortAlongAxis あり | 同左 | render_priority→深さ。**不安定ソート**（introsort） | renderOrder→z→id（**安定**） | alphaIndex→カメラ位置からの**ユークリッド距離**。同値は元の順（推測） |

一番大事な注意（詳しくは各節）
1. **厳密な 2D 描画順を全エンジンで保証できるのは「1つのプリミティブ（1材質・1アトラス）の中で、インデックス順に並べる」形だけ**。1回の描画呼び出しの中では GPU が三角形を順番どおりに合成する（Vulkan の議論 https://community.khronos.org/t/in-vkcmddrawindexed-if-triangles-overlap-does-later-triangle-always-overwrite-previous/112121 （確認済み 2026-10-29）、仕様本文は開けず（二次情報））。プリミティブや材質を分けると、エンジンごとに「物体単位で距離ソート」になり、同じ深さのときの並びがエンジンで違う（Godot は不安定、Babylon は正投影でも x/y のずれで順が変わる）。
2. **パーツごとの不透明度を、どのエンジンでも素の glTF で動かす方法は無い**。材質の baseColorFactor.a を KHR_animation_pointer で動かす方法は Godot・Babylon・UnityGLTF・three.js（プラグイン）だけで、glTFast・UniGLTF・UE は読まない。しかも材質を分ける＝プリミティブを分けるので、1 の描画順と両立しない。COLOR_0 をモーフで動かす（頂点アルファのモーフ）なら1プリミティブのままにできるが、読めるのは three.js と Babylon だけ（Unity・Godot・UE のブレンドシェイプは位置・法線・接線だけ）。
3. **モーフ100個のコスト**：three.js と Babylon（既定）は全モーフ数に比例して毎頂点ループし、データは密な float テクスチャ（25k 頂点×100個で位置だけでも約 38 MiB、計算は（推測））。Unity・UE は動いているモーフの数に比例。Godot は中間（ループは全数、読み出しは動いている物だけ）。
4. **Godot は BLEND を「Depth Pre-Pass」で読み込む**。2D 用途では描画パスが1つ増え、z を少しずらしたパーツがあると深度で隠れる。TRANSPARENCY_ALPHA に変えるのが無難（推測）。
5. **UE の glTF 読み込みは弱い**：関節は4本に切り詰め、モーフ重みのアニメ取り込みは 5.5 まで不具合報告、KHR_animation_pointer は無し。実行時に読むなら glTFRuntime の方が機能が多い。
6. **VRM 1.0 は「人型の骨」が必須で、頭の向き（yaw/pitch）は head ボーンの回転で表す**。目線（lookAt）だけは表情（lookUp/Down/Left/Right）に流せるが、Live2D の AngleX/AngleY のように頭の向きでブレンドシェイプを動かす決まりは無い。VSeeFace は VRM0 のみ、VTube Studio は Live2D のみ。

---

## 1. glTF 仕様側の前提（Khronos）

- 関節：JOINTS_n/WEIGHTS_n は1組4本。4本を超えるときは JOINTS_1/WEIGHTS_1 … と組を増やす（実装の注記）。（確認済み 2026-10-29） https://github.com/KhronosGroup/glTF/blob/main/specification/2.0/Specification.adoc （Skinned Mesh Attributes の節）
- モーフ：数に上限は無い。クライアントは「少なくとも8つのモーフ属性」を扱えることが推奨（SHOULD）、扱いきれない時は重みの大きい物を選ぶのが推奨。（確認済み 2026-10-29）同上（Morph Targets の節）
- モーフで動かせる属性：POSITION・NORMAL・TANGENT は推奨（SHOULD）、**TEXCOORD_n と COLOR_n は任意（MAY）**。COLOR_0 はモーフ後に 0〜1 に丸めるのが推奨。（確認済み 2026-10-29）同上
- BLEND の扱い：「深度を書くか・ソートするかは実装次第」と明記。三角形の順序についての決まりは無い。（確認済み 2026-10-29）同上（Alpha Coverage の節）
- KHR_animation_pointer・KHR_node_visibility・KHR_materials_unlit はいずれも「Ratified（批准済み）」。（確認済み 2026-10-29） https://github.com/KhronosGroup/glTF/blob/main/extensions/README.md 、 https://github.com/KhronosGroup/glTF/blob/main/extensions/2.0/Khronos/KHR_animation_pointer/README.md 、 https://github.com/KhronosGroup/glTF/blob/main/extensions/2.0/Khronos/KHR_node_visibility/README.md
- KHR_node_visibility は node に `visible` を持たせ、false なら子孫も全部消す。KHR_animation_pointer と組む前提で作られている。（確認済み 2026-10-29）同上

## 2. Unity glTFast 6.20.0

出典：機能表 https://docs.unity3d.com/Packages/com.unity.cloud.gltfast@6.20/manual/features.html （確認済み 2026-10-29）、GitHub の同じ表 https://github.com/Unity-Technologies/com.unity.cloud.gltfast/blob/main/Packages/com.unity.cloud.gltfast/Documentation~/features.md （確認済み 2026-10-29）

1. 関節：機能表に「Joints (up to 4 per vertex)」「Weights (up to 4 per vertex)」。（確認済み 2026-10-29）実行時は Unity の `QualitySettings.skinWeights`（1/2/4本/Auto、全メッシュ共通、実行中に変えられる）が効く。品質設定で2本にしていると4本の重みが使われない。（確認済み 2026-10-29） https://docs.unity.com/en-us/engine/current/script-reference/unityengine/qualitysettings/skinweights 。骨の数の上限は調べきれず（未確認）。
2. モーフ：○。sparse accessor は「モーフと頂点位置だけ」。（確認済み 2026-10-29 機能表の注²）
   - glTFast はモーフを `mesh.AddBlendShapeFrame(name, 1f, …)` で作る＝フレームの重みが 1。**glTF の重み 0〜1 がそのまま SetBlendShapeWeight の値になる**（UniGLTF は 100 なので 0〜100）。（確認済み 2026-10-29） https://github.com/Unity-Technologies/com.unity.cloud.gltfast/blob/main/Packages/com.unity.cloud.gltfast/Runtime/Scripts/MorphTargetsGenerator.cs
   - 計算は Unity 本体：GPU スキニング時はコンピュートシェーダ。`MeshDeformation.GPU` は「メッシュ・ブレンドシェイプごとの dispatch」、`GPUBatched` は「複数のメッシュとブレンドシェイプをまとめる」。まとめは「API が対応し、1フレームにまとめられるメッシュが3つ以上」の時だけで、ハイエンド向け。（確認済み 2026-10-29） https://docs.unity3d.com/6000.2/Documentation/ScriptReference/MeshDeformation.html 、 https://docs.unity.com/en-us/engine/6000.3/script-reference/unityeditor/meshdeformation/gpubatched
   - **重み 0 のブレンドシェイプは飛ばす**（Unity の Issue Tracker の回答で「SkinnedMeshRenderer の実装の詳細」として明言、UUM-114581）。（確認済み 2026-10-29） https://issuetracker.unity.com/issues/18784/nan-blend-shape-deltas-are-replaced-with-00-when-added-via-addblendshapeframe → コストは動いているモーフの数に比例（推測）。
   - Unity 内部のブレンドシェイプのバッファ（PerShape 形式）は「シェイプごとに、頂点番号＋位置・法線・接線の差分」の並び。頂点番号を持つので影響のある頂点だけを持つ疎な形と思われる（推測）。（ページは確認済み 2026-10-29） https://docs.unity.com/en-us/engine/current/script-reference/unityengine/rendering/blendshapebufferlayout/pershape
   - Unity のブレンドシェイプは位置・法線・接線だけ（AddBlendShapeFrame の引数）。COLOR_0 のモーフは持てない（glTFast のソースも位置・法線・接線だけ）。（確認済み 2026-10-29 上記ソース）
3. アニメ：TRS と weights を legacy の AnimationClip に（weights は `blendShape.<名前>` のカーブ）。（確認済み 2026-10-29） https://github.com/Unity-Technologies/com.unity.cloud.gltfast/blob/main/Packages/com.unity.cloud.gltfast/Runtime/Scripts/Animations/AnimationModuleProcessor.cs 。Mecanim 用にも作れるが割り当て・再生は自前、Playables は削除。6.19.0 から独自のアニメ系へ取り込むアドオン API（IAnimationProcessor）。（確認済み 2026-10-29 機能表・CHANGELOG）
4. KHR_animation_pointer：機能表で空欄＝非対応。昔は読むと例外が出ていた（修正済み＝無視して読める）。KHR_node_visibility は表に無い＝非対応。（確認済み 2026-10-29）
5. KHR_materials_unlit：○（URP・HDRP・Built-in）。（確認済み 2026-10-29）
6. 透明：Built-in の材質生成は BLEND で `ZWrite 0`、renderQueue 3000、SrcAlpha/OneMinusSrcAlpha。（確認済み 2026-10-29） https://github.com/Unity-Technologies/com.unity.cloud.gltfast/blob/main/Packages/com.unity.cloud.gltfast/Runtime/Scripts/Material/BuiltInMaterialGenerator.cs 。1つの glTF メッシュの複数プリミティブは1つの Unity Mesh のサブメッシュ（材質ごと）になる（GameObjectInstantiator の materialIndices）。（確認済み 2026-10-29） https://github.com/Unity-Technologies/com.unity.cloud.gltfast/blob/main/Packages/com.unity.cloud.gltfast/Runtime/Scripts/GameObjectInstantiator.cs 。Unity の透明物の並びは、透視カメラは「カメラ位置からピボットまでの距離」、正投影は「視線方向に沿った距離」。2D なら Orthographic モード推奨と書かれている。（確認済み 2026-10-29） https://docs.unity.com/en-us/engine/current/script-reference/unityengine/camera/transparencysortmode 。同じ距離のときの順（同じレンダラーのサブメッシュ同士を含む）は文書に無く不定と考えるべき。順を固定するなら材質ごとに renderQueue を 3000, 3001… と変える（推測）。
7. 実行時の制御：`SkinnedMeshRenderer.SetBlendShapeWeight(i, w)`（glTFast 読み込みなら w は 0〜1）、骨は骨の GameObject の Transform を LateUpdate で書く（アニメの後に上書き）（推測）。SkinnedMeshRenderer は GPU インスタンシング非対応（「Skinned Mesh Renderer components are not supported」）。（確認済み 2026-10-29） https://docs.unity.com/en-us/engine/6000.0/manual/analysis/graphics-performance-profiling/reduce-draw-calls/gpuinstancing/gpuinstancing 。描画呼び出しはサブメッシュ（材質）ごとに1つ（推測）。WebGL（コンピュートシェーダ無し）ではスキニング・ブレンドシェイプが CPU になる可能性が高い（推測）。
8. 既知の問題：多数モーフの読み込み時のフレーム落ちを改善した履歴あり（読み込み時の話）。（確認済み 2026-10-29 CHANGELOG）

## 3. Unity のその他の選択肢

### UniGLTF / UniVRM 0.131.4
（vrm-c/UniVRM を clone してソースを読んだ。確認済み 2026-10-29）
- 関節：`JOINTS_0` と `WEIGHTS_0` だけを見る（`PrimitiveExtensions.HasSkin`、`JointsAccessor`）。 https://github.com/vrm-c/UniVRM/blob/master/Packages/UniGLTF/Runtime/UniGLTF/IO/MeshIO/PrimitiveExtensions.cs
- モーフ：フレームの重みは 100（`MeshUploader.cs` の `FrameWeight = 100.0f`）。weights のアニメは×100 して `blendShape.<名前>` のカーブに。**`mesh.extras.targetNames` が無いと「targetNames invalid」で例外**。クリップは legacy。 https://github.com/vrm-c/UniVRM/blob/master/Packages/UniGLTF/Runtime/UniGLTF/IO/AnimationIO/Import/AnimationImporterUtil.cs
- sparse：○（`GltfData.cs` で sparse の値を上書き）。
- KHR_materials_unlit：○（UniUnlit に変換、BLEND は Transparent モード）。KHR_animation_pointer・KHR_node_visibility：ソースに無い＝非対応。
- 対応 Unity は 2022.3 LTS 以降（v0.128.0〜）。 https://github.com/vrm-c/UniVRM/blob/master/README.md

### UnityGLTF 2.24.0（Khronos）
- README の「読み書き両方」の一覧に Skinned Mesh Renderers・Blend Shapes（sparse 含む）・KHR_materials_unlit・**KHR_animation_pointer**・**KHR_node_visibility**（GameObject の active）がある。KHR_animation_pointer は「材質やオブジェクトの任意のプロパティのアニメ」を読み書きできる。glTFast と同じプロジェクトに共存でき、両方あると読み込みは glTFast が優先。（確認済み 2026-10-29） https://github.com/KhronosGroup/UnityGLTF/blob/master/README.md
- 関節の本数・描画順の扱いは未確認。

## 4. Unreal Engine 5.8（Interchange の glTF 読み込み）と glTFRuntime

### Interchange（エディタでの読み込み）
- Epic の文書の本文は JavaScript で描かれていて取得できなかった（importing-gltf-files-into-unreal-engine、gltf-file-format-support-in-unreal-engine はタイトルと書き出し側の拡張の一覧だけ取れた）。（確認済み 2026-10-29） https://dev.epicgames.com/documentation/en-us/unreal-engine/gltf-file-format-support-in-unreal-engine
- 解析部（GLTFCore）が知っている拡張の列挙 `GLTF::EExtension`（5.8）：KHR_MaterialsUnlit・KHR_TextureTransform・KHR_MaterialsVariants・KHR_MeshQuantization・KHR_DracoMeshCompression ほか材質系。**KHR_animation_pointer と KHR_node_visibility は無い**。（確認済み 2026-10-29） https://dev.epicgames.com/documentation/unreal-engine/API/Plugins/GLTFCore/GLTF__EExtension → 両拡張は非対応（推測、強い）。unlit は対応（列挙にあるので。材質への割り当ての中身は未確認）。
- 関節：**JOINTS_1 以降を捨てて4本に切り詰める**という報告（UE 5.8、2026-08-20）。Epic の担当者は当初「仕様は4本まで」と答え、のちにバグ票 UE-392966 として To Do に入った。（確認済み 2026-10-29） https://forums.unrealengine.com/t/interchange-gltf-importer-truncates-skeletal-mesh-bone-influences-to-4-per-vertex/2745391 。4本で足りる今回の用途には影響しない。
- モーフ：取り込める。ただし 5.5 で「モーフは入るが重みのアニメ（カーブ）が入らない」、5.3〜5.5 で再現・5.6 で動いたという報告。5.4.1 で「Corrupted morph target optional payload data」の報告も。（5.5 の件は確認済み 2026-10-29） https://forums.unrealengine.com/t/ue5-5-gltf-morph-targets-are-imported-but-no-animation-curves/2051604 、（5.4.1 の件は二次情報） https://forums.unrealengine.com/t/ue5-4-1-gltf-morph-targets-are-corrupted-on-import-but-work-in-gltf-viewer/1873937
- sparse：未確認。
- 骨の数：GPU スキニングは1セクションあたり既定 65536 本、**モバイルは 75 本**、16bit 番号でなければ 256 で頭打ち、超えるとセクションを分割して描画呼び出しが増える。頂点あたりの影響は既定 4 か 8（プラットフォーム次第）、Unlimited Bone Influences は実際は 12 まで。（確認済み 2026-10-29） https://dev.epicgames.com/documentation/en-us/unreal-engine/skeletal-mesh-rendering-paths-in-unreal-engine
- モーフの計算：コンポーネントに `ActiveMorphTargets`（「動いているモーフの一覧」）を持ち、`SetMorphTarget(FName, float Value(0-1), bool bRemoveZeroWeight)` で重み0を一覧から外せる。（確認済み 2026-10-29） https://dev.epicgames.com/documentation/unreal-engine/API/Runtime/Engine/USkinnedMeshComponent 、 https://dev.epicgames.com/documentation/unreal-engine/API/Runtime/Engine/USkeletalMeshComponent → コストは動いているモーフの数に比例（推測）。GPU で計算する設定（Use GPU for computing morph targets）がある（二次情報）。モーフが多いキャラで1つでも動くと重くなるというバグ票 UE-188901（二次情報、ページは 403）。
- 透明の並び：プロジェクト設定の Translucent Sort Policy が SortByDistance（カメラ中心から境界球の中心）・SortByProjectedZ・**SortAlongAxis（「2D ゲーム向け」）**。（確認済み 2026-10-29） https://dev.epicgames.com/documentation/unreal-engine/API/Runtime/Engine/ETranslucentSortPolicy__Type 。コンポーネント単位の Translucency Sort Priority（大きいほど手前に描く）（二次情報）。**優先度はコンポーネント単位なので、1つのスケルタルメッシュの中のセクション（材質）同士の順は指定しにくい**（推測）。Translucent 材質は深度を書かない（推測）。
- 実行時の制御：`SetMorphTarget`、骨は AnimBP（Transform (Modify) Bone）・Control Rig・Live Link（推測）。

### glTFRuntime（実行時に読むプラグイン）
（clone してソースを読んだ。確認済み 2026-10-29） https://github.com/rdeioris/glTFRuntime
- 関節：JOINTS_0・1・2 を読む（最大12本、`MAX_TOTAL_INFLUENCES` で頭打ち）。`glTFRuntimeParser.cpp`、`glTFRuntimeParserSkeletalMeshes.cpp`
- モーフ・sparse：○。weights のアニメはスケルタルアニメのモーフカーブに変換（`bRemoveMorphTargets` で外せる）。
- KHR_materials_unlit：○（専用の unlit 材質）。BLEND は `bTranslucent`。KHR_animation_pointer・KHR_node_visibility はソースに無い＝非対応。

## 5. Godot 4.7.2（組み込みの GLTFDocument）

（タグ 4.7.2-stable を clone してソースを読んだ。確認済み 2026-10-29） https://github.com/godotengine/godot/blob/4.7.2-stable/modules/gltf/gltf_document.cpp
1. 関節：JOINTS_0 だけなら4本、JOINTS_1 もあれば `ARRAY_FLAG_USE_8_BONE_WEIGHTS` で8本。骨の数の明記された上限は見つからず（推測：実用上なし）。
2. モーフ：○。`BLEND_SHAPE_MODE_NORMALIZED` で取り込み、名前は `extras.targetNames`（無ければ morph_0…）。モーフで読む属性は POSITION・NORMAL・TANGENT だけ（**COLOR_0 のモーフは読まない**）。sparse：○（GLTFAccessor が sparse を展開）。
   - 計算（Forward+/Mobile）：`skeleton.glsl` のコンピュートシェーダで、1頂点ごとに**全ブレンドシェイプをループし、|w|>0.0001 の物だけ読む**。データはシェイプごとに全頂点分を持つ密な形（`(vertex_count * i + index) * vertex_stride`）。 https://github.com/godotengine/godot/blob/4.7.2-stable/servers/rendering/renderer_rd/shaders/skeleton.glsl 、 https://github.com/godotengine/godot/blob/4.7.2-stable/servers/rendering/renderer_rd/storage_rd/mesh_storage.cpp
   - Compatibility（GLES3）：transform feedback で、重みが0でないシェイプごとに1パス。 https://github.com/godotengine/godot/blob/4.7.2-stable/drivers/gles3/storage/mesh_storage.cpp
   - 全頂点の z が 0 のメッシュ（`is_mesh_2d`）は属性の圧縮を切る（モーフ・スキンがある時も切る）。
3. アニメ：weights は `Animation.TYPE_BLEND_SHAPE` のトラック、ノードの TRS もトラックに。
4. KHR_animation_pointer：○。対応拡張の一覧（`get_supported_gltf_extensions_hashset`）に KHR_animation_pointer・KHR_node_visibility・KHR_materials_unlit・KHR_texture_transform など。baseColorFactor は材質の `albedo_color` に対応づけ。
   - KHR_animation_pointer は PR #94165（マイルストーン 4.4、2024-11-05 マージ）。PR の説明では、`/weights/N` で1個ずつ動かすモーフ重みは Blend Shape トラックでなく値トラックになる。（確認済み 2026-10-29） https://github.com/godotengine/godot/pull/94165
   - KHR_node_visibility は PR #93722（マイルストーン 4.5、2025-04-24 マージ）。（確認済み 2026-10-29） https://github.com/godotengine/godot/pull/93722 。表示・非表示のアニメ（pointer と組む）は PR #111341（マイルストーン 4.6、2025-10-21 マージ）。（確認済み 2026-10-29） https://github.com/godotengine/godot/pull/111341
5. KHR_materials_unlit：○（SHADING_MODE_UNSHADED）。
6. 透明：**alphaMode BLEND は `TRANSPARENCY_ALPHA_DEPTH_PRE_PASS` で取り込む**（gltf_document.cpp）。Depth Pre-Pass は「深度の前処理で α<0.99 の画素を捨てる」＝不透明な画素は深度を書く。既定の深度描画は DEPTH_DRAW_OPAQUE_ONLY。（確認済み 2026-10-29） https://docs.godotengine.org/en/stable/classes/class_basematerial3d.html
   - 並び：透明物は「材質の render_priority が先、同じなら深さ（遠い順）」。深さは物体（インスタンス）単位で、透視はカメラ位置から原点（または AABB 中心）までの距離、正投影は近クリップ面からの距離。`sorting_offset` で前後にずらせる。 https://github.com/godotengine/godot/blob/4.7.2-stable/servers/rendering/renderer_rd/forward_clustered/render_forward_clustered.h 、同 .cpp
   - ソートは `SortArray`（introsort）＝**安定でない**。同じメッシュの複数サーフェス（材質）は深さが同じになるので、render_priority を変えないと順が保証されない。 https://github.com/godotengine/godot/blob/4.7.2-stable/core/templates/sort_array.h
   - 公式文書も「透明物はノードの位置で奥から手前にソート」「Render Priority と Sorting Offset で調整」「足りないこともある」と書く。（確認済み 2026-10-29） https://docs.godotengine.org/en/stable/tutorials/3d/3d_rendering_limitations.html
7. 実行時の制御：`MeshInstance3D.set_blend_shape_value(idx, value)`、`find_blend_shape_by_name`、`Skeleton3D.set_bone_pose_rotation/position/scale`、アニメの後で上書きするなら SkeletonModifier3D。（確認済み 2026-10-29） https://docs.godotengine.org/en/stable/classes/class_meshinstance3d.html 、 https://docs.godotengine.org/en/stable/classes/class_skeleton3d.html 。描画呼び出しはサーフェスごと、Depth Pre-Pass ならさらにもう1回（推測）。
8. 既知の問題：2D 用途で Depth Pre-Pass のままだと、z を少しずらしたパーツがインデックス順と逆の前後関係のとき、深度で隠れて描画順どおりにならない（推測）。全部 z=0 なら同じ深さなので問題は出にくい（推測）。

## 6. three.js r186（GLTFLoader）

（dev ブランチのソースを読んだ。確認済み 2026-10-29） https://github.com/mrdoob/three.js/blob/dev/examples/jsm/loaders/GLTFLoader.js
1. 関節：属性の対応表は `JOINTS_0: 'skinIndex'`, `WEIGHTS_0: 'skinWeight'` だけ＝4本。骨の行列はテクスチャ（`boneTexture`）から読むので骨の数の固定上限は無い（テクスチャの大きさまで）。 https://github.com/mrdoob/three.js/blob/dev/src/renderers/shaders/ShaderChunk/skinning_pars_vertex.glsl.js
2. モーフ：○（POSITION・NORMAL・**COLOR_0** のモーフを読む）。sparse：○。
   - 計算：頂点シェーダで `for (i < MORPHTARGETS_COUNT) if (influence != 0) transformed += getMorph(...) * influence` ＝**ループは全数、テクスチャ読み出しは0でない物だけ**。 https://github.com/mrdoob/three.js/blob/dev/src/renderers/shaders/ShaderChunk/morphtarget_vertex.glsl.js
   - データ：全モーフを Float32 の DataArrayTexture（1層1モーフ、幅＝頂点数×属性数）に**密に**詰める。重みは `uniform float morphTargetInfluences[MORPHTARGETS_COUNT]`。 https://github.com/mrdoob/three.js/blob/dev/src/renderers/webgl/WebGLMorphtargets.js 、 https://github.com/mrdoob/three.js/blob/dev/src/renderers/shaders/ShaderChunk/morphtarget_pars_vertex.glsl.js
   - 大きさの目安：25,000 頂点×位置だけ×100 モーフ×16 バイト＝約 38 MiB、法線も入れると約 76 MiB（計算、推測）。モーフ数の上限は配列テクスチャの層数（WebGL2 の保証は 256 層以上）と uniform の数で決まる（推測）。
3. アニメ：`PATH_PROPERTIES` で translation/rotation/scale/weights（→ morphTargetInfluences）を AnimationClip のトラックに。
4. KHR_animation_pointer：本体は非対応。ローダーの説明に「別のプラグインで対応：KHR_animation_pointer（needle-tools/three-animation-pointer）」。プラグインは材質のプロパティ・カメラ・ライト・モーフ重み（1個ずつも可）を動かせる。npm 1.1.3（2026-10-06）。（確認済み 2026-10-29） https://github.com/needle-tools/three-animation-pointer 。KHR_node_visibility は本体の一覧に無い（プラグインの説明にも無い）。
5. KHR_materials_unlit：○（MeshBasicMaterial）。
6. 透明：BLEND は `transparent = true`、`depthWrite = false`（issue #17706 を参照するコメント付き）。透明物の並びは `reversePainterSortStable`：groupOrder → renderOrder → z（投影後の境界球の中心、遠い順）→ id（作った順）＝**同じ深さでも順が安定**。 https://github.com/mrdoob/three.js/blob/dev/src/renderers/webgl/WebGLRenderLists.js 、 https://github.com/mrdoob/three.js/blob/dev/src/renderers/WebGLRenderer.js 。プリミティブが複数なら Mesh も複数（それぞれ並べ替えの対象）。
7. 実行時の制御：`mesh.morphTargetInfluences[mesh.morphTargetDictionary[name]] = w`、骨は `bone.quaternion` などを書く。モーフ数は固定のシェーダ定義なので重みを変えてもシェーダは作り直されない（推測、ソースの作りから）。SkinnedMesh は InstancedMesh にできない（推測）。描画呼び出しはプリミティブ（材質）ごとに1つ。
8. 既知の問題：モーフを法線付きで書き出すと、unlit でもテクスチャが倍になる（推測）。

## 7. Babylon.js 9.33.0（glTF ローダー）

（master のソースを読んだ。確認済み 2026-10-29） https://github.com/BabylonJS/Babylon.js/blob/master/packages/dev/loaders/src/glTF/2.0/glTFLoader.pure.ts
1. 関節：JOINTS_1/WEIGHTS_1 を `MatricesIndicesExtraKind` として読み、`numBoneInfluencers = 8`。骨の行列は既定でテクスチャ（`_useTextureToStoreBoneMatrices = true`）、スキニングは既定でシェーダ（`_computeBonesUsingShaders = true`）。 https://github.com/BabylonJS/Babylon.js/blob/master/packages/dev/core/src/Bones/skeleton.ts
2. モーフ：○（POSITION・NORMAL・TANGENT・TEXCOORD_0/1・**COLOR_0** のモーフ）。sparse：○。プリミティブごとに Babylon の Mesh と MorphTargetManager ができる（`<名前>_primitive<n>`）。
   - テクスチャ方式（既定 `EnableTextureStorage = true`）。テクスチャを使えない時の属性方式は「動いているモーフ最大8個」（`MaxActiveMorphTargetsInVertexAttributeMode = 8`）。 https://github.com/BabylonJS/Babylon.js/blob/master/packages/dev/core/src/Morph/morphTargetManager.ts
   - **glTF ローダーの既定 `useMaxMorphTargetInfluencers = true`**：シェーダを全モーフ数で1回だけ作り、`optimizeInfluencers = false`。シェーダは NUM_MORPH_INFLUENCERS 回ループして毎回テクスチャを読む（0 を飛ばす分岐が無い）＝**コストは全モーフ数に比例**。false にすると「重みが0でない物だけ」になるが、動いている数が変わるたびにシェーダを作り直す。 https://github.com/BabylonJS/Babylon.js/blob/master/packages/dev/loaders/src/glTF/glTFFileLoader.pure.ts 、 https://github.com/BabylonJS/Babylon.js/blob/master/packages/dev/core/src/Shaders/ShadersInclude/morphTargetsVertex.fx
   - この既定は PR #18596（2026-06-22 マージ、9.14.0）から。理由は「重みが0をまたぐとシェーダが作り直され、1フレーム描画が飛んで口がパクッと閉じる」こと。（確認済み 2026-10-29） https://github.com/BabylonJS/Babylon.js/pull/18596
3. アニメ：weights は MorphTarget の influence、TRS も。`/nodes/{}/weights` を pointer の表にも持つ。 https://github.com/BabylonJS/Babylon.js/blob/master/packages/dev/loaders/src/glTF/2.0/glTFLoaderAnimation.pure.ts
4. KHR_animation_pointer：○。CHANGELOG で 5.18.0「KHR animation pointer（新機能）」、6.49.0「property tree を更新」。`/materials/{}/pbrMetallicRoughness/baseColorFactor` は材質の alpha にも対応づけ、`/nodes/{}/extensions/KHR_node_visibility/visible` は `isVisible` に対応づけ。KHR_node_visibility は 7.32.0 から。（確認済み 2026-10-29） https://github.com/BabylonJS/Babylon.js/blob/master/CHANGELOG.md 、 https://github.com/BabylonJS/Babylon.js/blob/master/packages/dev/loaders/src/glTF/2.0/Extensions/KHR_animation_pointer.data.pure.ts 、 https://github.com/BabylonJS/Babylon.js/blob/master/packages/dev/loaders/src/glTF/2.0/Extensions/KHR_node_visibility.pure.ts
5. KHR_materials_unlit：○（拡張のファイルあり）。
6. 透明：BLEND は `MATERIAL_ALPHABLEND`。エンジンの setAlphaMode が「ブレンド中は depth mask を切る」（`forceDepthWrite` で上書き可）。 https://github.com/BabylonJS/Babylon.js/blob/master/packages/dev/core/src/Engines/Extensions/engine.alpha.pure.ts 。並びは `alphaIndex` → **カメラ位置から境界球の中心までのユークリッド距離**（正投影カメラでも同じ式）。同じ距離なら比較は 0 を返す（JS の sort は安定なので元の並び、推測）。 https://github.com/BabylonJS/Babylon.js/blob/master/packages/dev/core/src/Rendering/renderingGroup.ts
7. 実行時の制御：`mesh.morphTargetManager.getTarget(i).influence = w`（プリミティブごとの manager に別々に入れる必要あり）、骨は glTF のノード（TransformNode）に `linkTransformNode` されているので、そのノードの `rotationQuaternion` を書く。描画呼び出しはプリミティブごと。
8. 既知の問題：多モーフでは既定のままだと全モーフを毎頂点読むので、モーフ100個×25k 頂点は重くなりうる（推測）。`useMaxMorphTargetInfluencers: false` にすると軽いが、0 をまたぐ瞬間のちらつきが戻る。

## 8. 透明の描画順（横断）

- 1回の描画呼び出しの中は、インデックスの順に合成される（GPU の決まり。Vulkan の議論で「バッファの後の三角形が上に描かれる」と回答。ジオメトリ／テッセレーションシェーダが無い場合）。（確認済み 2026-10-29） https://community.khronos.org/t/in-vkcmddrawindexed-if-triangles-overlap-does-later-triangle-always-overwrite-previous/112121 。順序を緩める拡張（VK_AMD_rasterization_order の relaxed）は明示的に指定した時だけ（二次情報）。
- よって「1プリミティブ・1材質・深度を書かない（または全部 z=0）」なら、8つの取り込み口すべてで painter's order が守られる（推測、上の決まりと各エンジンの BLEND 設定から）。例外：Godot は既定で Depth Pre-Pass、z が揃っていないと崩れうる。
- 物体・材質を分けた時の並び（同じ深さのとき）：three.js は id 順で安定、Godot は不安定、Babylon・UE（SortByDistance）は 3D 距離なので x/y の位置で順が変わる、Unity は不定（推測）。どれも「物体単位」で、三角形単位のソートはしない。
- VRM の MToon は `renderQueueOffsetNumber`（深度を書かない BLEND は -9〜0 の 10 段階だけ）で順を指定する。Live2D のパーツ数（数十〜数百）には足りない。（確認済み 2026-10-29） https://github.com/vrm-c/vrm-specification/blob/master/specification/VRMC_materials_mtoon-1.0/README.md

## 9. コードからの毎フレーム制御と性能（横断）

| | モーフ重み | 骨 | 1キャラの描画呼び出し | インスタンシング |
|---|---|---|---|---|
| Unity | `SetBlendShapeWeight(i, w)`（glTFast は 0〜1、UniGLTF は 0〜100） | 骨 Transform を LateUpdate で | サブメッシュごと（推測） | SkinnedMeshRenderer は不可（確認済み） |
| UE | `SetMorphTarget(Name, 0〜1, bRemoveZeroWeight)` | AnimBP／Control Rig／Live Link（推測） | セクションごと（骨が多いと分割） | 未確認 |
| Godot | `set_blend_shape_value(idx, v)` | `Skeleton3D.set_bone_pose_*`、SkeletonModifier3D | サーフェスごと＋Pre-Pass（推測） | 未確認 |
| three.js | `morphTargetInfluences[i] = w` | `bone.quaternion` 等 | プリミティブごと | SkinnedMesh は不可（推測） |
| Babylon | `getTarget(i).influence = w`（プリミティブごと） | リンクされた TransformNode | プリミティブごと | 未確認 |

モーフのコストの比例先：Unity・UE＝動いている数／Godot＝ループは全数・読み出しは動いている数（GLES3 は動いている数）／three.js＝同じく全数ループ・動いている物だけ読む／Babylon（既定）＝全数を毎頂点読む。

## 10. 多数のモーフ・平らなメッシュ・正投影の既知の問題

- 多数のモーフ：three.js・Babylon・Godot は全頂点×全モーフの密なデータを GPU に持つ（sparse で保存しても読み込み時に展開）（three.js・Godot はソースで確認、Babylon はテクスチャ方式から推測）。Unity は頂点番号付きの形（疎と推測）。Babylon は既定で全数を毎頂点処理。Unity の GPU（非バッチ）は動いているシェイプごとに dispatch を順に出す（バッチ機能の説明から）。
- 平らな（z=0）メッシュ：Godot は自動で属性圧縮を切る（確認済み）。unlit なら法線は要らないので、モーフに法線を入れない方が three.js・Babylon のメモリが半分以下になる（推測）。glTF は法線が無いと「平らな法線を計算」と定めるので、エンジンが法線を作ることがある（仕様は確認済み、各エンジンの動きは未確認）。
- 正投影：Unity は視線方向の距離、Godot は近クリップ面からの距離、three.js は投影後の z、Babylon は正投影でもカメラ位置からのユークリッド距離、UE は SortAlongAxis が 2D 向け。Babylon で部品を別メッシュにすると、x/y が違うだけで順が入れ替わる（ソースから推測）。

## 11. VRM 1.0（glTF ベースの VTuber 形式）

出典：https://github.com/vrm-c/vrm-specification/tree/master/specification （clone して確認済み 2026-10-29）
- 表情（expressions）：プリセット（happy・angry・sad・relaxed・surprised、口の aa・ih・ou・ee・oh、まばたき blink/blinkLeft/blinkRight、目線 lookUp/lookDown/lookLeft/lookRight、neutral）と custom。1つの表情は `morphTargetBinds`（モーフ）・`materialColorBinds`（材質の色。KHR_materials_unlit の baseColorFactor も対象、float4 なので**アルファも動かせる**）・`textureTransformBinds` の組。値は 0〜1、`isBinary`、`overrideBlink/LookAt/Mouth`。 https://github.com/vrm-c/vrm-specification/blob/master/specification/VRMC_vrm-1.0/expressions.md
- 揺れもの：VRMC_springBone（joints の鎖、colliders、stiffness・gravity・drag など）。 https://github.com/vrm-c/vrm-specification/blob/master/specification/VRMC_springBone-1.0/README.md
- lookAt：type は `bone`（leftEye/rightEye の回転）か `expression`（lookUp/Down/Left/Right の重み）。yaw/pitch を rangeMap で骨の角度か表情の重みに変換。**これは目線であって頭の向きではない**。 https://github.com/vrm-c/vrm-specification/blob/master/specification/VRMC_vrm-1.0/lookAt.md
- 人型の骨が必須：hips・spine・head・両腕（上腕・前腕・手）・両脚（太もも・すね・足）。頭の向きは head ボーンの回転。 https://github.com/vrm-c/vrm-specification/blob/master/specification/VRMC_vrm-1.0/humanoid.md → 頭の yaw/pitch でブレンドシェイプを動かす（Live2D の AngleX/AngleY 相当）決まりは無い。やるならアプリ側の仕組み（custom 表情を外から動かす等）が要る（推測）。
- アプリ：
  - VSeeFace：「VRM0 の規格のみ、VRM 1.0 は不可」、Live2D 不可、Perfect Sync（ARKit 52 個）対応、版は v1.13.38c5。（確認済み 2026-10-29） https://www.vseeface.icu/
  - Warudo：VRM 対応（0.x/1.0 の区別はページに無い）、VRM 表情と custom 表情、ARKit のブレンドシェイプ。（確認済み 2026-10-29） https://docs.warudo.app/docs/assets/character 。VRM 1.0 も対応（二次情報）。
  - VMagicMirror：VRM 対応、アバター固有のブレンドシェイプ対応（確認済み 2026-10-29 https://malaybaku.github.io/VMagicMirror/en/ ）。VRM 1.0 は v3.0.0（2022-11-30）から（二次情報） https://forest.watch.impress.co.jp/docs/news/1467234.html
  - VTube Studio：「Live2D のみ、VRoid/VRM 不可、3D モデルは一切不可」。（確認済み 2026-10-29） https://github.com/DenchiSoft/VTubeStudio/wiki/Models
  - VNyan・3tene の VRM 1.0 対応は未確認。
  - 各エンジン用の VRM 読み込み：Unity は UniVRM、three.js は @pixiv/three-vrm（npm 3.5.5、2026-07-09、確認済み）、Godot は godot-vrm（VRM 1.0 読み込み対応、二次情報）、UE は VRM4U（二次情報）。
- 2D・平らなモデルを VRM として「役に立つ形で」使うアプリは見つからなかった。VRM にすると人型の骨が要り、頭の回転は 3D 回転なので平らな板は横を向くと薄くなる（推測）。2D 専用なら Live2D（VTube Studio）か、オープンな Inochi2D（Inochi Session、README で「開発中で本番向けでない」）。（確認済み 2026-10-29） https://github.com/Inochi2D/inochi-session

## 12. 設計への示唆（推測）

- 描画順を守るなら「キャラ全体を1プリミティブ・1材質・1アトラス、パーツはインデックスの並びで奥→手前、z は全部 0、BLEND（深度を書かない）」。Godot は読み込み後に材質を TRANSPARENCY_ALPHA に変える。
- パーツの不透明度は、1プリミティブのままなら次のどれか：(a) COLOR_0 のモーフ（three.js・Babylon のみ）、(b) 位置モーフで消す・出す（全エンジン、ただし二値的）、(c) エンジン側の独自シェーダ（頂点にパーツ番号を持たせ、不透明度の配列を uniform で渡す。glTF の外の約束になる）。材質を分けて KHR_animation_pointer で動かす方式は、Godot・Babylon・UnityGLTF・three.js（プラグイン）なら動くが、描画順はエンジンのソートに任せることになる。
- モーフ数は「同時に動く数」より「総数」が効くエンジン（three.js・Babylon 既定・Godot のループ）がある。100個を超えるなら、使わない物を別メッシュに分ける・法線を入れない・Babylon は useMaxMorphTargetInfluencers を検討。

## 未確認として残したこと
- UE Interchange の sparse 対応、unlit・BLEND の材質の中身、セクション同士の透明の順。
- UnityGLTF の関節の本数と BLEND の深度設定。
- Unity で同じレンダラーのサブメッシュ同士の透明の順（文書が見つからない）。
- three.js の SkinnedMesh を正投影で大きく動かした時のカリング（境界の更新）。
- VNyan・3tene の VRM 1.0、Warudo の VRM 1.0（公式ページの明記）。
