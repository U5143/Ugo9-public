<!-- SPDX-FileCopyrightText: 2026 U5143 -->
<!-- SPDX-License-Identifier: MIT -->
# Ugo9 for Unreal Engine（UE 5.6 以上、作っている途中）

ライセンスは MIT（芯・エンジンの包みとも。[docs/ライセンス.md](../../docs/ライセンス.md)）。

設計と段の計画は docs/進行/Unreal.md。今は **段 5**：段 0（プラグインの骨組み、芯の C のビルド、`.ug9` の取り込み、芯の自動テスト）、段 1（`UUgoCharacterComponent`、場面の後に描く拡張、シェーダー `Shaders/Private/Ugo9.usf`）に、合成（普通・乗算・スクリーン）ごとの描き分け、アトラス 8 枚まで、描画順（形式 0.8）ごとのまとめ、表を GPU に置いたままにする所を足した。段 3 でマスク（キャラごとのマスクの画像を、キャラの前に描いて読む）、段 4 で Unity と同じ機能（下の表）、段 5 で Sequencer（Time・Animation などをキーに）、音からの口（`LipSyncSource`）、見本の Playground（`AUgoPlaygroundActor`）を足した。使い方は [docs/エンジンの使い方.md](../../docs/エンジンの使い方.md)。

描く回数：モデルごと・描画順ごとに、合成の続く部品のまとまり 1 つにつき 1 回（普通の合成だけのモデルなら、何体でも 1 回）。マスクのあるモデルは、そのほかにキャラごと・マスク 4 つごとに 1 回。`UUgoWorldSubsystem` の `GetDrawCount`・`GetCharacterCount`・`GetModelCount` で前のフレームの数が見られる。

キャラは Actor に **Ugo Character** のコンポーネントを足し、Model と Animation を選ぶ。キャラは世界の X–Z の面に立ち（モデルの x が +X、y が −Z、1 ピクセルがモデルの UnitsPerPixel cm）、−Y を向く。前後は Y。Blueprint から使える物（Unity の UgoCharacter と同じ働き。Unreal の型を使わない部分は `UgoFeatures.h` にあり、tests/unreal_core で確かめている）：

| 何を | 使う物 |
|---|---|
| アニメ | `Play`（名前・始める秒・混ぜる秒）、`PlayNext`（今のが終わったら）、`Stop`、`IsFinished`、`OnAnimationFinished` |
| パラメータ | `SetParam`・`ClearParam`・`ClearParams`・`GetParam` |
| 層（1, 2, …） | `PlayLayer`・`QueueLayer`（足す／混ぜる、骨・部品・パラメータで絞る、重み・繰り返し・速さ）、`StopLayer`、`SetLayerWeight`・`GetLayerWeight`、`GetLayerAnimation`、`OnLayerFinished` |
| 表情 | `Expression`（最初から）、`ShowExpression`・`HideExpression`・`OnlyExpressions`・`GetExpressionWeight`・`GetExpressionNames`、`LoadExpressions`（プリセットの JSON） |
| 助け | `LookTarget`・`LookAt`・`StopLooking`・`LookFrom`（見る）、`bAutoBlink`（まばたき）、`SetMouthLevel`・`SetVoiceLoudness`（口。dB はノイズゲートを通る：`VoiceGateDb`・`VoiceRangeDb`） |
| 当たり | `PartAt`・`AreaAt`・`GetAreaNames`・`RayToPlane`（マウスの線と面の交わる所）、`PartBounds` |
| 骨 | `GetBoneTransform`（物を持たせる）、`ReachFor`（骨の先を点へ） |
| Sequencer | `Time`・`Animation`・`Color`・`Expression`・`Wind`・`bPlaying` がキーにできる（`bPlaying` を切って Time をキーに） |
| 見本 | `AUgoPlaygroundActor`：置いて Model を選んで Play |
| そのほか | `Parameters`（Details で置く値）、`Color`（キャラ全体の色）、`Wind`・`WindGust`（揺れ物に風）、`WorldToModel`・`ModelToWorld` |

## 入れ方

- このリポジトリの中で：UE の C++ のプロジェクトの `Plugins/` に、`engines/unreal/Ugo9` を置く（シンボリックリンクかコピー）。リポジトリの中の場所から作る時は、Build.cs が芯の C（`core/`）を `Source/Ugo9/Private/UgoCore/` に写す
- リポジトリの外のプロジェクトへ：`node engines/unreal/package_plugin.mjs <プロジェクト>/Plugins`（芯の C と、試しに使う見本のキャラ samples/basic を `Resources/Samples/basic/` に一緒に写す）

`.ug9` を Content Browser に落とすと UUgoModelAsset になる（同じフォルダの PNG も中に持つ）。

## 確かめ

- Unreal 無しで：`node tests/unreal_core_test.mjs`（芯を包む C++ の層。CI の engines でも走る）
- Unreal の中で：Tools → Session Frontend → Automation →「Ugo9」（docs/PC確認.md の「Unreal 段 0」）
