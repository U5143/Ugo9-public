<!-- SPDX-FileCopyrightText: 2026 U5143 -->
<!-- SPDX-License-Identifier: MIT -->
# Ugo9 for Unity（UPM パッケージ）

ライセンスは MIT（芯・エンジンの包みとも。[docs/ライセンス.md](../../docs/ライセンス.md)）。

Unity 2022.3 以上（まず Unity 6.3 LTS・URP で確かめる）で Ugo9 のキャラを動かすパッケージ `com.ugo9.runtime`。設計は [docs/エンジン.md](../../docs/エンジン.md)。

> まだユーザーの PC で確かめる前の版。この環境では、C# の芯の部分を本物の芯（C）で動かすテスト、Unity の API の形を真似た仮の定義でのコンパイル、HLSL の構文の確かめまで済んでいる（CI の `unity` ジョブ）。Unity の中で動くかは PC で確かめる（「PC での確認」）。

## 入れ方

1. 芯（C）を共有ライブラリにして、パッケージに置く（CMake と C コンパイラが要る。Windows は Visual Studio 2022 か Build Tools の「C++ によるデスクトップ開発」）

   ```
   node engines/unity/build_plugin.mjs
   ```

   `com.ugo9.runtime/Runtime/Plugins/`（Windows は `Windows/x86_64/ugo.dll`）にできる。git には入れない。Android は `--android`（Unity の NDK で `Android/libs/arm64-v8a/libugo.so`）、iOS と WebGL は `--sources`（芯の C を置き、Unity がプレイヤーと一緒にビルドする）

2. Unity の Package Manager → 「+」→「Add package from disk…」→ `engines/unity/com.ugo9.runtime/package.json`
3. `.ug9` と、その中で名前の出てくる PNG を同じフォルダに入れる。`.ug9` は UgoModel のアセットになる（テクスチャが白い時は、PNG の読み込みの後に `.ug9` を Reimport）

## 使い方

```csharp
var batch = new GameObject("crowd").AddComponent<UgoBatch>();   // この下のキャラを、モデルごとに数回でまとめて描く
for (int i = 0; i < 100; i++)
{
    var c = new GameObject("c" + i).AddComponent<UgoCharacter>();
    c.transform.SetParent(batch.transform, false);
    c.transform.localPosition = new Vector3(i * 0.3f, 0, 0);
    c.model = model;                  // UgoModel（.ug9 のアセット）
    c.Play("idle", Random.value * 6);
}
c.SetParam("HeadTurnX", 20);            // 置いた値は ClearParam まで残る（アニメの上に乗る）
c.AddBlend("talk", t, 0.5f);          // 次の 1 回だけ重ねる（毎フレーム呼ぶ）
```

| UgoCharacter | |
|---|---|
| `model` | UgoModel |
| `animation`・`playing`・`speed`・`time` | 再生するアニメ（名前）・再生中か・速さ・今の時間（秒） |
| `manual` | true なら時間と揺れ物は `Advance(秒)` を呼んだ時だけ進む |
| `Play(名前, 始めの時間)`・`Stop()` | |
| `SetParam`・`ClearParam`・`ClearParams`・`GetParam` | `GetParam` は直前の計算の値 |
| `AddBlend(名前, 時間, 重み)`・`ResetPhysics()`・`UpdateNow()` | |
| `Play(名前, 始め, 混ぜる秒)`・`PlayNext`・`AnimationFinished` | アニメの切り替え |
| `PlayLayer`・`QueueLayer`・`StopLayer`・`SetLayerWeight`・`MakeMask`・`LayerFinished` | 層（1 から） |
| `expression`・`ShowExpression`・`HideExpression`・`OnlyExpressions`・`LoadExpressions` | 表情 |
| `lookTarget`・`LookAt`・`StopLooking`・`autoBlink`・`lipSyncSource`・`SetMouthLevel`・`VoiceGate` | 助け |
| `PartAt`・`AreaAt`・`HitTest`・`PartBounds`・`BonePosition`・`BoneRotation`・`ReachFor` | 当たりと骨 |
| `color`・`sortingOrder`・`sortWithSprites`・`wind`・`windGust` | 色・前後・風 |

UgoBatch の下に無い UgoCharacter は自分 1 体で描く。計算と描画は `LateUpdate`（実行順 1000、ゲームのスクリプトの後）。

座標：キャラの原点は `.ug9` のモデルの (0, 0)。モデルのピクセルは `pixelsPerUnit`（既定 100、`.ug9` の読み込みの設定）で単位になり、y は上向き。

色：Web 版と同じ絵にするには、プロジェクトの Color Space を **Gamma** にする（Linear では半透明の重なりの色が少し変わる）。

## 描き方

- `Graphics.RenderMeshPrimitives` で、合成の種類が同じパーツの並び（範囲）ごとに 1 回。何体いても回数は変わらない。頂点は `Ugo9Character.shader` が変形する（`SV_VertexID`・`SV_InstanceID` で表を引く、Web 版と同じ計算）
- フレームの塊は RGBAFloat のテクスチャ 1 枚（毎フレーム 1 回送る）
- 合成：normal と add は 1 回、multiply・screen は材質の合成の値で正確に
- マスク：キャラごとに、モデルのキャンバスの上のマスクの画像（テクスチャ配列の層）へ先に描く。頂点シェーダーで層を選べる GPU（D3D11・Vulkan・Metal）では全キャラを 4 チャンネルごとに 1 回、選べない GPU ではキャラごとに 1 回
- 描画の器（Built-in・URP）に頼らない作り（自前の行列と `unity_MatrixVP`）。URP の 2D Renderer の並べ替え（Sorting Layer）に乗るかは PC で確かめる

## 見本（Package Manager の Samples）

- **Demo**：大勢のキャラを 1 つの UgoBatch で描き、手前のキャラがマウスを見る（`UgoDemo` を空の GameObject に付け、model を入れて Play）
- **Conversation**：1 体の会話の場面。マウスを見る、まばたき、1〜9 で表情（同梱の `basic.ug9x`）、Space の間しゃべる、A でアニメを混ぜて切り替え（`UgoConversation`）
- **Playground**：見本のキャラと欄（アニメ・パラメータのつまみ・まばたき・マイクで口・クリックしたパーツ）。Godot の playground.tscn、Unreal の Playground Actor、Web の web/engines/ と同じ（`UgoPlayground`）
- **Bench**：体数を増やして fps と描画の回数を測る（`UgoBench`）
- **Render test**：エンジン共通の場面を描いて PNG にし、Web 版と比べる（`tests/unity_test.mjs`、手順は docs/エンジン.md）

## テスト（この環境・CI）

```
cmake -S . -B build/native -DUGO_SHARED=ON && cmake --build build/native --target ugo_shared
LD_LIBRARY_PATH=build/native dotnet run --project tests/unity_core -- $PWD   # C# の芯の部分を本物の芯で
dotnet build tests/unity_compile                                            # 仮の Unity API でコンパイル
python3 tests/unity_shader_check.py                                         # HLSL（glslang）
```
