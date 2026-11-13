<!-- SPDX-FileCopyrightText: 2026 U5143 -->
<!-- SPDX-License-Identifier: MIT -->
# Ugo9 for RPG ツクール MZ（プラグイン）

ライセンスは MIT（芯・エンジンの包みとも。[docs/ライセンス.md](../../docs/ライセンス.md)）。

Ugo9 のキャラを、マップと戦闘の画面に出すプラグイン（`Ugo9.js`、1 つのファイル）。中身は Web 版（`web/ugo.js` と、PixiJS・Phaser と同じ `web/ugo_layer.js`）と芯の wasm（普通の物と SIMD の物の 2 つ。動く方を自動で選ぶ。約 330 KB）で、キャラは 1 枚の絵にまとめて描き、その絵を MZ の PIXI のスプライトとしてマップ・戦闘の上、ウィンドウの下に置く。MZ の描画には手を入れない。

## 作り方と入れ方

1. `node engines/rpgmaker_mz/build.mjs` → `build/rpgmaker_mz/Ugo9.js`（CI の `rpgmaker-mz` のジョブの成果物からも取れる）
2. MZ のプロジェクトの `js/plugins/` に `Ugo9.js` を置き、プラグイン管理で「Ugo9」を ON
3. キャラごとに `img/ugo9/<名前>/` を作り、Ugo9 のエディタが書き出した `model.ug9` と PNG を置く（例 `img/ugo9/hero/model.ug9`・`img/ugo9/hero/atlas.png`）

## プラグインコマンド

| コマンド | 引数 | |
|---|---|---|
| 出す | ID・モデルのフォルダ・x・y・大きさ・アニメ | ID は自由に決める名前。x・y はモデルの原点（ふつうは足もと）の画面の位置。ファイルを読み終わると出る |
| 消す・動かす | ID（・x・y・大きさ） | |
| アニメ | ID・アニメ・混ぜる秒 | 今のアニメから混ぜて切り替える |
| パラメータ | ID・名前・値 | アニメの上に置き続ける。値を空にすると戻す |
| 表情 | ID・名前 | モデルの表情（ほかは消える）。空なら無し |
| 話し手 | ID | メッセージの文字が出ている間、このキャラの口が動く（空なら誰も） |
| マウスを見る | ID・ON/OFF | 顔と目がマウス（タッチ）の方を向く |

プラグインの設定：フォルダ（既定 `img/ugo9/`）、自分でまばたき、メッセージの間しゃべる。

## 決まり・限り

- キャラはセーブに残らない。ロードの後は、自動実行のイベントなどで出し直す
- ピクチャの番号の前後には入らない（キャラはマップ・戦闘のすぐ上、ウィンドウの下に 1 枚）
- 時間は MZ の 1 フレーム＝1/60 秒で進む
- 描くのは WebGL2 の別の canvas（MZ の PIXI の WebGL とは別）。WebGL2 の無い環境では出ない（Console にエラー）
- RPG ツクール MZ の物（コアスクリプト・素材）はこのリポジトリに入れていない。試しは PixiJS 5 と、MZ の物の代わり（`tests/rpgmaker_mz/page.html`）で行う

## 試し

`node tests/rpgmaker_mz_test.mjs`（PixiJS 5.3.12 を `build/rpgmaker_mz/pixi5` に入れて、作ったプラグインを Chromium で動かす）。キャラが出る・ウィンドウの下・アニメの切り替え・パラメータ・話し手の口・消す。MZ そのものでの動きは docs/PC確認.md の「RPG ツクール MZ」。
