<!-- SPDX-FileCopyrightText: 2026 U5143 -->
<!-- SPDX-License-Identifier: MIT -->
# Ugo9 for GDevelop（スクリプト、作り始め）

ライセンスは MIT（芯・エンジンの包みとも。[docs/ライセンス.md](../../docs/ライセンス.md)）。

GDevelop 5 のシーンに Ugo9 のキャラを出す。中身は Web 版（`web/ugo.js` と、PixiJS・Phaser・RPG ツクール MZ と同じ `web/ugo_layer.js`）と芯の wasm（普通の物と SIMD の物。動く方を自動で選ぶ）を 1 つにした `Ugo9GDevelop.js`（約 330 KB）。キャラはシーンごとに 1 枚の絵にまとめて描き、その絵を GDevelop のレイヤーの PIXI のスプライトとして置く（GDevelop の描画には手を入れない）。関数は全部 `gdjs.ugo9` の下で、「JavaScript のコード」のイベントから呼ぶ。

## 作り方と入れ方

1. `node engines/gdevelop/build.mjs` → `build/gdevelop/Ugo9GDevelop.js`（CI の gdevelop-script の成果物からも取れる）
2. `Ugo9GDevelop.js` を、ゲームのファイルと一緒に置き、シーンの最初に一度読み込む（JavaScript のイベントで `<script>` を足すか、拡張のプロパティの JavaScript のファイルとして）。PC での確かめで、書き出したゲームに入る形を決める（docs/PC確認.md「GDevelop」）
3. キャラのファイル（`model.ug9` と PNG）をゲームのファイルと一緒に置き、URL（ゲームのページからの相対）で渡す

```js
// シーンの始め（JavaScript のコード）
gdjs.ugo9.show(runtimeScene, 'hero', 'ugo9/hero/model.ug9', 400, 600, { scale: 0.5 });
// 何かの時
gdjs.ugo9.play(runtimeScene, 'hero', 'talk', 0, 0.3);   // 名前・始める秒・混ぜる秒（ほかのエンジンの Play と同じ）
gdjs.ugo9.onlyExpressions(runtimeScene, 'hero', 'smile');
gdjs.ugo9.setMouthLevel(runtimeScene, 'hero', 0.8);   // 負の値でアニメに戻す
// クリック
const part = gdjs.ugo9.partAt(runtimeScene, 'hero', runtimeScene.getGame().getInputManager().getCursorX(), runtimeScene.getGame().getInputManager().getCursorY());
```

| `gdjs.ugo9.` | |
|---|---|
| `show(scene, ID, URL, x, y, { scale, animation, layer, blink })` | 出す（ファイルを読み終わると出る）。layer はレイヤーの名前（シーンで最初の 1 回）、blink は自分でまばたき |
| `hide`・`move(scene, ID, x, y, scale)`・`isShown` | |
| `play(scene, ID, 名前, 始める秒, 混ぜる秒)` | アニメ |
| `setParam(scene, ID, 名前, 値)`・`clearParam`・`clearParams`・`getParam` | パラメータ（clearParam まで残る） |
| `showExpression(scene, ID, 名前, 秒)`・`hideExpression`・`onlyExpressions(scene, ID, 名前…)` | モデルの表情（混ぜる秒を省くと表情の秒） |
| `setMouthLevel(scene, ID, 0〜1)`・`lookAt(scene, ID, x, y)`・`stopLooking` | 口（負でアニメに戻す）・見る |
| `partAt(scene, ID, x, y)` | 場面の点のパーツの名前（無ければ ''） |

座標は場面の座標（GDevelop と同じ、y 下向き）。毎フレーム、シーンのイベントの後で動く（`gdjs.registerRuntimeScenePostEventsCallback`）。

## 決まり・限り

- カメラは位置だけ追う（ズーム・回転はまだ）。キャラはレイヤーの中で 1 枚（ほかのオブジェクトとの前後は、レイヤーを分けて決める）。マスク・合成・描画順は Web 版と同じに描く
- 描くのは WebGL2 の別の canvas。GDevelop の拡張の「よい作り方」（wiki）は DOM の API を使わない、とするので、この形は GDevelop のコミュニティの拡張の一覧には出さず、Ugo9 の物（MIT）として配る
- GDevelop（エンジン・GDJS）は MIT（github.com/4ian/GDevelop の README）。GDevelop の物はこのリポジトリに入れていない。試しは PixiJS 7.4.2 と、gdjs・シーンの代わり（`tests/gdevelop/page.html`）で行う

## 試し

`node tests/gdevelop_test.mjs`（出る・カメラを動かしても場面の同じ所・パラメータ・口・パーツ・消す）。GDevelop そのものでの動きは PC。
