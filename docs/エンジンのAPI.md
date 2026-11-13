<!-- SPDX-FileCopyrightText: 2026 U5143 -->
<!-- SPDX-License-Identifier: MIT -->
# エンジンごとの API の名前（見比べ、2026-11-12）

同じ働きの物が、どのエンジンでもすぐ見つかるように並べた。名前の書き方はエンジンの流儀に合わせる（Unity・Unreal は PascalCase、Godot・GameMaker は snake_case、Web・GDevelop は camelCase、RPG ツクール MZ はプラグインコマンド）。引数の並びはそろえる（例：アニメは「名前・始める秒・混ぜる秒」）。表に無い所（—）は、そのエンジンにまだ無い物。

| 働き | Unity | Godot | Unreal | Web（ugo.js） | GameMaker | GDevelop（gdjs.ugo9） | MZ（コマンド） |
|---|---|---|---|---|---|---|---|
| アニメを再生（名前・始める秒・混ぜる秒） | `Play` | `play` | `Play` | `UgoAnimator.play(名前, {fade})` | `play` | `play` | アニメ |
| 終わったら次へ | `PlayNext` | `play_next` | `PlayNext` | `UgoAnimator.queue` | — | — | — |
| 終わった知らせ | `AnimationFinished` | `animation_finished` | `OnAnimationFinished` | `UgoAnimator.on('end')` | — | — | — |
| 止める | `Stop` | `stop` | `Stop` | — | `stop` | — | — |
| パラメータを置く・戻す・読む | `SetParam`・`ClearParam`・`ClearParams`・`GetParam` | `set_param`・`clear_param`・`clear_params`・`get_param` | `SetParam`・`ClearParam`・`ClearParams`・`GetParam` | `UgoInstance.set`・`get` | `set_param`・`clear_param`・`clear_params`・`get_param` | `setParam`・`clearParam`・`clearParams`・`getParam` | パラメータ（値を空で戻す） |
| 層（1 から） | `PlayLayer`・`QueueLayer`・`StopLayer`・`SetLayerWeight` | `play_layer`・`queue_layer`・`stop_layer`・`set_layer_weight` | `PlayLayer`・`QueueLayer`・`StopLayer`・`SetLayerWeight` | `UgoAnimator.play(名前, {layer})` | — | — | — |
| 表情 | `ShowExpression`・`HideExpression`・`OnlyExpressions` | `show_expression`・`hide_expression`・`only_expressions` | `ShowExpression`・`HideExpression`・`OnlyExpressions` | `UgoExpressionMixer.show`・`hide`・`only` | `show_expression`・`hide_expression`・`only_expressions` | `showExpression`・`hideExpression`・`onlyExpressions` | 表情（only と同じ） |
| 表情の重み | `ExpressionWeight` | `get_expression_weight` | `GetExpressionWeight` | `UgoExpressionMixer.weights()` | `get_expression_weight` | — | — |
| プリセットの表情を読む | `LoadExpressions` | `load_expressions` | `LoadExpressions` | `UgoModel.loadExpressions` | — | — | — |
| 見る | `LookAt`・`StopLooking`・`lookTarget` | `look_at_point`・`stop_looking`・`look_target` | `LookAt`・`StopLooking`・`LookTarget` | `UgoLook.lookAt`・`stop` | — | `lookAt`・`stopLooking` | マウスを見る |
| まばたき | `autoBlink` | `auto_blink` | `bAutoBlink` | `UgoBlink` | — | `show` の `blink` | 設定 |
| 口（0〜1、負でアニメに戻す） | `SetMouthLevel` | `set_mouth_level` | `SetMouthLevel` | `UgoMouth.level` | — | `setMouthLevel` | 話し手（メッセージの間） |
| 音から口 | `lipSyncSource` | `lip_sync_bus` | `LipSyncSource`・`SetVoiceLoudness` | `VoiceLevel`（tracking.js） | — | — | — |
| 点のパーツ | `PartAt`・`HitTest` | `get_part_at`・`hit_test` | `PartAt` | `UgoInstance.pickPart` | `part_at` | `partAt` | — |
| 当たりの範囲 | `AreaAt`・`AreaNames` | `get_area_at`・`get_area_names` | `AreaAt`・`GetAreaNames` | `UgoInstance.hitTest`・`model.hitAreas` | — | — | — |
| パーツの四角 | `PartBounds` | `get_part_rect` | `PartBounds` | `UgoInstance.bounds` | — | — | — |
| 骨の位置 | `BonePosition`・`BoneRotation` | `get_bone_transform` | `GetBoneTransform` | `UgoInstance.boneWorld` | — | — | — |
| 骨の先を点へ | `ReachFor` | `reach_for` | `ReachFor` | `UgoInstance.dragBone` | — | — | — |
| 風 | `wind`・`windGust` | `wind`・`wind_gust` | `Wind`・`WindGust` | `UgoInstance.setWind` | `wind_x`・`wind_y`・`wind_gust` | — | — |
| キャラ全体の色 | `color` | `modulate` | `Color` | `UgoLayer` の外で | — | — | — |

## 型（TypeScript）

Web の芯と包みには型の定義がある：`web/ugo.d.ts`・`ugo_layer.d.ts`・`ugo_pixi.d.ts`・`ugo_phaser.d.ts`・`ugo_three.d.ts`（`import ... from './ugo.js'` で、エディタと tsc が自動で読む）、GDevelop の `gdjs.ugo9` は `engines/gdevelop/ugo9_gdevelop.d.ts`。`tests/web_types_test.mjs` が、例のコード（tests/types/example.ts）を `--strict` で型に通し、定義の名前が全部本物にあること（本物のモデルとインスタンスで）、書き出しの名前が全部定義にあることを確かめる。

## そろえた所（2026-11-12）

- GameMaker・GDevelop の `play` を「名前・始める秒・混ぜる秒」に（前は「名前・混ぜる秒」で、ほかと 2 つ目の引数の意味が違った）
- GDevelop：`expression` → `showExpression`・`hideExpression`・`onlyExpressions`、`mouth` → `setMouthLevel`、`setParam(null)` → `clearParam`・`clearParams`、`lookAt(null)` → `stopLooking`
- GameMaker：`set_expression(名前, 重み)` → `show_expression`・`hide_expression`・`only_expressions`（混ぜる秒つき）・`get_expression_weight`、`clear_params`・`stop` を足した

## そのままにした違い（理由）

- Godot の `look_at_point`：Node2D に `look_at` が前からあり、同じ名前は使えない
- Godot の `get_part_rect`：Godot の四角は Rect2 で、名前も rect が流儀
- Unity の `BonePosition`・`BoneRotation`：Unity の Transform に合わせて 2 つに分けた（Godot・Unreal は Transform 1 つ）
- Unity の `ExpressionWeight`・`AreaNames`：C# の流儀でプロパティ・名詞
- Web は部品（UgoInstance・UgoAnimator・UgoLook…）を組み合わせて使う作りなので、キャラ 1 つの関数の名前ではない

## まだ無い所（大きい順の候補）

1. GameMaker・GDevelop：層、終わった知らせ、当たりの範囲、骨
2. GameMaker：見る・まばたき・口（助け）、マスク
3. Unreal：`HitTest`（`PartAt` が空でないかで足りる）、`ResetPhysics`
