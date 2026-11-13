# Web のページに置く（1 ファイル、2026-11-10、利用者の声 #29）

キャラを Web のページに置くための、1 つのファイルを作る。Ugo9 の Web ランタイム（`web/ugo.js`、MIT）・芯（`ugo.wasm`）・モデル・絵を全部中に入れるので、ほかに置くファイルも、入れる部品（npm など）も要らない。

```
node tools/export_web.mjs model.ug9 --out hero.ugo9.js     # ES Module（要素 <ugo9-player> を作る）
node tools/export_web.mjs model.ug9 --out hero.html        # 1 枚のページ（キャラがページいっぱいに）
    [--textures atlas.png,...]  [--anim idle]  [--title 名前]  [--no-simd]
```

**芯は 2 つ入る**（2026-11-13、芯の #469 の後）：ふつうの芯（`ugo.wasm`）と SIMD の芯（`ugo_simd.wasm`）の両方を入れ、ページを開いた時に、ブラウザが WebAssembly の SIMD を使えれば SIMD の芯を使う（`UgoRuntime.simdSupported()`）。絵はビット単位で同じで、速いだけ。ファイルは約 120 KB 大きくなる。一番小さいファイルが要る時は `--no-simd`（ふつうの芯だけ）。ページの中で `window.UGO9_NO_SIMD = true` を先に置くと、SIMD の芯があってもふつうの芯を使う。確かめ（`tests/export_web_test.mjs`）：Chromium で SIMD の芯が選ばれ、ふつうの芯の時と画面の画素がバイト単位で同じ。`--no-simd` で 116 KB 小さい

## 見るためのページ（`--viewer`、2026-11-10、機能の比べ #93）

```
node tools/export_web.mjs model.ug9 --out hero.html --viewer
```

1 枚のページに、キャラと横の欄：アニメを選ぶ・一時停止・最初から・速さ（0.1〜3 倍）・大きさ（0.25〜4 倍）・背景の色（か透明）・顔がポインタを追うか・パラメータごとのスライダー（動かすとその値に止める。「戻す」でアニメに返す）。ファイル 1 つなので、メールやチャットで渡して、相手のブラウザで確かめてもらえる。日本語と英語の両方で書いてある。

`mount` の返す物（と要素の `player`）に、`setSpeed`・`setZoom`・`setFollow`・`time`・`animation` も足した。

## ページに置く

```html
<script type="module" src="hero.ugo9.js"></script>
<ugo9-player anim="idle" follow style="width: 300px; height: 400px"></ugo9-player>
```

- `anim`：流すアニメ（くり返す）。無ければ idle、それも無ければ最初のアニメ
- `paused`：止めておく（最初の姿）
- `follow`：ポインタを顔が追う（AngleX・AngleY のあるモデル）
- 絵は要素の大きさに合わせ、縦横の比を保つ。背景は透明
- 同じページに何体置いても、芯とモデルは 1 つを共有する

## スクリプトから

```js
import { mount } from './hero.ugo9.js';
const p = await mount(document.querySelector('canvas'), { anim: 'idle' });
p.play('talk');            // 別のアニメ（無い名前は例外）
p.set('MouthOpen', 0.5);   // パラメータを決める（unset で戻す）
p.pause(true); p.stop();
```

要素 `<ugo9-player>` の `player` に同じものが入る（`ready` のイベントの後）。React・Vue などでも、要素を置くか `mount` を呼ぶだけ。

## 大きさ

見本（420×600、アトラス 1 枚）で約 480 KB（ランタイム約 50 KB・芯約 60 KB・モデル約 230 KB・絵、Base64 で 4/3 倍）。サーバーが gzip で送れば小さくなる。

## 何体も置く（2026-11-10、利用者の声 #18）

いくつものモデルを 1 つのファイルに入れる。ランタイムと芯（ugo.wasm）は 1 回だけ入る。

    node tools/export_web.mjs hero.ug9 friend.ug9 --out cast.ugo9.js [--names hero,friend]
    node tools/export_web.mjs hero.ug9 friend.ug9 --out cast.html         # 並べたページ

- ページでは `<ugo9-player model="friend" anim="idle"></ugo9-player>` のように `model` で選ぶ（無ければ最初のモデル）。スクリプトからは `mount(canvas, { model: 'friend' })`、入っているモデルの名前は `models`
- 名前はファイルの名前から（`hero.ug9` → hero）、`--names` で付け直せる。同じ名前が 2 つなら止まる
- 芯は 1 回だけ読み込み、モデルはそれぞれ 1 回だけ読む（同じモデルの player がいくつあっても）
- 1 つの player が 1 つの WebGL の描き場を使う。ブラウザが同時に持てる描き場には限りがある（多くは 16 前後）ので、何十体も並べる時は 1 つの描き場に何体も描く形（`web/ugo.js` の `UgoRenderer.draw([...])`）が向く
- 1 つのモデルの時は今までと同じ（同じ API、`model` は要らない）
- `--viewer` は 1 つのモデルだけ
- 確かめ（`tests/export_web_test.mjs`）：見本と、見本を半分にしたモデルを 1 つに：859 KB（2 つのファイルなら 1,031 KB）、芯は 1 回。2 体のページで、それぞれ自分のモデルを描く（キャンバス 420 と 210）。無いモデルの名前は、入っている名前を挙げて断る

## 解像度ごとのアトラス（`tools/atlas_sizes.mjs`、2026-11-10、機能の比べ #17）

小さい画面・サムネイル・先に軽い物を読み込む時のために、1・0.5・0.25 倍などのアトラスと、それぞれを指す .ug9 を一度に作る。

    node tools/atlas_sizes.mjs model.json --scales 1,0.5,0.25 [--out 先]
    # → model.ug9 + atlas.png、model@0.5x.ug9 + atlas@0.5x.png、model@0.25x.ug9 + atlas@0.25x.png

- モデル（キャンバスでの大きさ・メッシュ・UV）はどれも同じ。UV はページの 0〜1 なので、どの大きさのページでもそのまま合う。違うのは絵の画素の数とテクスチャの名前だけ
- 小さくする時、新しい 1 画素は覆う画素の面積の重みの平均（透明度で重みを付けた色なので、縁が黒ずまない）。1 倍のページは元のファイルをそのまま写す
- 割り切れない大きさは丸める（絵は半画素より小さくずれる。お知らせ `atlasSizeRounded`）
- 描く大きさに合ったものを選ぶ：描く画素（スーパーサンプリングを含む）がアトラスの画素とおよそ同じなら見た目は変わらない
- `.ug9` からも作れる（作業用 JSON に戻してコンパイルし直す）。ブラウザでも動く（`atlasSizes(json, pages, scales)`、Node の API は CLI の所だけ）
- 確かめ（`tests/atlas_sizes_test.mjs`）：透明の隣の色が黒ずまない、平らなページは平ら。見本で 1024・512・256 のページ。1 倍は作業用 JSON のコンパイルと同じバイト、ほかは位置・UV・パーツ・骨などが同じでテクスチャの名前だけ違う。0.5・0.25 倍で 2 つのパーツの絵が混ざる画素は 0。キャンバスの 1/4（105×150、2 倍のスーパーサンプリング）で描くと、0.5 倍のアトラスと 1 倍のアトラスの差は最大 7/255・平均 0.068

## 確かめたこと（`tests/export_web_test.mjs`、ヘッドレスの Chromium）

1 枚のページは自分以外を取りに行かずに開き、エラーが出ない。ES Module の形は `<script>` 1 行で `<ugo9-player>` になる。止めた最初の姿は `ugo_export` の絵と同じ（210×300 で、48 より違う画素は描かれた所の 1% ほど：GPU と CPU の縁の違い）。`play` で別のアニメ、無い名前は断る。
