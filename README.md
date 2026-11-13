# Ugo9（仮称）

Live2D や Spine のように 2D のキャラを動かすための、**軽さを最優先にした**仕組みです。
ゲーム・Web・映像（GIF・APNG・動画）で同じデータを動かすことを目指しています。

- **CPU が毎フレームする仕事は、1体あたり数百バイトの「重み」を作るだけ。** 頂点をいくつ増やしても CPU の仕事は増えません
- **頂点の変形は GPU（シェーダー）が行い、何体いても1回の描画命令で描きます**
- **表情・振り向きは「パラメータごとの差分の足し算」で持ちます**（可変フォントと同じ考え方）。組み合わせの数だけ形を用意する必要がありません
- 芯は C（約 600 行、メモリ確保も入出力もしない）。Web（WASM、20 KB）・ネイティブ・各ゲームエンジンへ同じ芯を包んで出します

> 現在は試作（形式 v0.6）です。形式は今後変わります。リポジトリは非公開です。ライセンス：再生の部品・道具・デモ・テストは MIT、見本のキャラは CC0、形式の説明は CC BY 4.0、エディタは無料配布の利用規約（どこが何かは [docs/ライセンス.md](docs/ライセンス.md)）。著作権者の表記は配る前に決めます。

## 計測（試作の時点）

見本のキャラ（16パーツ・2,034 頂点）と、同じ絵を 4 倍細かく分割した物（23,153 頂点）を 200 体ずつ動かした時の、**1フレームあたりの CPU の時間**（`tests/test_core.c`、Linux・1スレッド）：

| | 2,034 頂点 × 200 体 | 23,153 頂点 × 200 体 |
|---|---|---|
| Ugo9（パラメータ → 重みだけ。変形は GPU） | **0.14 ms** | **0.13 ms** |
| 頂点を CPU で変形する方式（Live2D・Spine のランタイムと同じ形） | 3.3 ms | 37.7 ms |
| 1体あたり毎フレーム GPU へ送る量 | **448 バイト** vs 16 KB | **448 バイト** vs 185 KB |

ブラウザ（`tests/web_test.mjs`、205 体）：Ugo9 は **描画 1 回・転送 90 KB／フレーム**、CPU で変形する方式は **描画 205 回・転送 3.3 MB／フレーム**。2つの方式の絵の差は最大 8/255 ほど（同じ絵）。

## 中身

| 場所 | 中身 |
|---|---|
| `core/` | ランタイムの芯（C99）。`ugo.h` が窓口。`ugo_raster.c` は CPU で絵を描く部品（書き出し・テスト用） |
| `web/` | Web 版：`ugo.wasm`（芯）・`ugo.js`（WebGL2 で描く）・`encoders.js`（GIF・APNG）・`index.html`（デモ） |
| `cli/` | `ugo_export`：GIF・APNG・PNG 連番・スプライトシート・MP4・WebM に書き出す |
| `tools/` | `compile.mjs`（作業用 JSON → 配布用 `.ugo`）、`make_sample.mjs`（見本のキャラを作る）、`build_wasm.sh`、`serve.mjs` |
| `samples/basic/` | 見本のキャラ（`model.json`・`atlas.png`・`model.ug9`）。絵は図形で描いた仮の物 |
| `tests/` | 芯のテストと計測（壊れたファイル 3,000 通り・決定性・物理）、ブラウザのテスト |
| `docs/` | [設計](docs/設計.md)・[ファイル形式](docs/形式.md) |

## 使い方

### デモを見る（Node.js が要ります）

```
node tools/serve.mjs
```

表示された `http://localhost:8099/web/` を開きます。キャラの数を増やし、「変形の方式」を切り替えると、CPU の時間・描画回数・転送量の違いが見えます。マウスに顔を向ける・パラメータを手で動かす・GIF／APNG に書き出す、もできます。

### エディタで作る

`node tools/serve.mjs` の後、`http://localhost:8099/editor/` を開く。PSD を開き、メッシュ・骨と重み・パラメータとキーの形（ワープ格子・角の形を含む）・揺れる鎖・のり・アニメを作り、保存・`.ugo`・GIF・APNG・WebM・MP4 に書き出せる。使い方は [docs/エディタの使い方.md](docs/エディタの使い方.md)、作りは [docs/エディタ設計.md](docs/エディタ設計.md)。

### VTuber として使う

`node tools/serve.mjs` の後、`http://localhost:8099/web/vtuber.html` を開いて「カメラを開始」。顔の動きでキャラが動く。OBS には「ブラウザ」ソースで `http://localhost:8099/web/vtuber.html#view` を入れると、背景が透明のまま重なる。詳しくは [docs/VTuber.md](docs/VTuber.md)。

### 3D の場面に置く

Web の 3D（three.js）なら Ugo9 のまま全部の機能で置ける（`web/ugo_three.js`、デモは `http://localhost:8099/web/three3d.html`）。Blender・Godot・Unity・Unreal には glTF に焼いて渡す（`tools/export_gltf.mjs`）。3D の VTuber アプリには VRM 1.0 で渡す（`tools/export_vrm.mjs`）。詳しくは [docs/3D.md](docs/3D.md)。

### Spine のデータを持ち込む

`node tools/import_spine.mjs skeleton.json skeleton.atlas 出力フォルダ`（3.8 のバイナリ `.skel` も可）。骨（せん断・受け継ぎ方）・IK・transform 制約・メッシュ・重み・描く順とその変化・アニメーション（回転・移動・拡大・せん断・形の変化・切り替え・透明度・制約の効き具合）を変換する。詳しくは [docs/Spine.md](docs/Spine.md)。

### 書き出す

- **ブラウザで**：デモの「書き出し」で GIF か APNG を選んで「書き出す」。`web/encoders.js` は WebM・MP4 も書ける（WebCodecs。`encodeAll` で 1 回描いた絵から複数の形式に）
- **コマンドで**：`ugo_export`（ビルドは下）

```
ugo_export samples/basic/model.ug9 --anim idle --out idle.gif --bg "#ffffff"
ugo_export samples/basic/model.ug9 --anim talk --seconds 4 --size 300x430 --out talk.png   # APNG
ugo_export samples/basic/model.ug9 --anim idle --out idle.webm   # 透明つき動画（ffmpeg が要る）
ugo_export samples/basic/model.ug9 --anim idle --out idle.mp4     # ffmpeg が要る
ugo_export samples/basic/model.ug9 --anim idle --format sheet --out sheet.png   # スプライトシート＋JSON（TexturePacker・Aseprite と同じ JSON Hash 形式）
ugo_export samples/basic/model.ug9 --param AngleX=20 --param MouthOpen=1 --frames 1 --out still.png
ugo_export samples/basic/model.ug9 --anim idle --out idle.gif --out idle.webm --out idle.mp4   # 1 回描いて 3 つの形式に
```

ループするアニメは、録る前に1周ぶん揺れ物の物理を回すので、つなぎ目が切れません。

### ビルド

```
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build --config Release
ctest --test-dir build -C Release
```

Windows（Visual Studio）・macOS・Linux で動きます。GitHub に push すると、3 つの OS で自動でビルドとテストが走り、`ugo_export` と共有ライブラリ（`-DUGO_SHARED=ON`）が Actions の成果物として取れます。

WASM（`web/ugo.wasm`）は clang だけで作れます（Emscripten は不要）：`./tools/build_wasm.sh`

### 自分のキャラを作る

今はエディタがまだ無いので、作業用 JSON（[形式](docs/形式.md)）を書いて `node tools/compile.mjs model.json` で `.ugo` にします。見本の作り方は `tools/make_sample.mjs` にあります。

## 今できること・まだできないこと

できる：パーツ（メッシュ＋アトラス）、骨（親子・せん断・受け継ぎ方 5 種・最大4本の重み・8192 本まで）、IK と transform 制約、パラメータ、差分の足し算（複数パラメータの角の補正も可）、骨と不透明度をパラメータで動かす、揺れ物の物理（パラメータ空間のばね）、アニメーション（ステップ・直線・なめらか）、GPU で1回の描画、CPU の参照描画、GIF・APNG・PNG・スプライトシート・MP4・WebM、壊れたファイルの検査。

まだ：クリッピング（マスク）、乗算などの合成、複数のテクスチャを1回で描く、ワープ格子（B スプライン）、エディタ、PSD の読み込み、Unity・Godot・Unreal への組み込み、データの圧縮（fp16 など）。順番は [設計](docs/設計.md#次の段階) にあります。
