# Live2D と同じ条件で比べる（Unity、内部の判断のため）

ユーザーの PC で、Live2D と Ugo9 を**同じ Unity・同じ条件**で動かし、速さとメモリを比べる手順。変換はせず、それぞれを別のプロジェクトで開いて測る。PC の Claude Code はこの文書に従う。

## 決まり（権利のため、必ず守る。2026-11-04 ユーザーの決定）

- **Unity のプロジェクトを分ける。** Live2D 側は「Live2D の公式 SDK＋Live2D のモデル」だけ、Ugo9 側は「Ugo9 だけ」。1 つのプロジェクトに混ぜない（Live2D の約款に、出力ファイルを競合するミドルウェアと組み合わせて使うことの禁止があるため）
- **Live2D の物（SDK・モデル・Live2D 側の測るスクリプト）は、Ugo9 のリポジトリに入れない。** ユーザーの PC の中だけに置く。作業フォルダ（リポジトリ）の外に置き、`git add` しない
- **クラウドの担当は、Live2D の SDK のコードを読まない。** PC の Claude Code も、SDK の中身は読まずに、**公式マニュアルに書かれた公開の使い方（API）だけ**で書く
- Live2D のモデルからは**数だけ**を書き写す（パーツ・頂点・パラメータ・ワープ・テクスチャの数と大きさ）。絵やデータは使わない・写さない・push しない
- **結果は内部の判断だけに使う。** 公開・宣伝には使わない
- SDK を落とす時の約款への同意は、**ユーザーが自分で**読んで行う（Claude は代わりに同意しない）

## 全体の流れ

| 順 | 何を | 場所 | 目安 |
|---|---|---|---|
| 1 | Live2D 側のプロジェクトを作り、モデルを置いて動かす | `<作業フォルダ>\..\Live2D-bench`（リポジトリの外） | 30〜60 分 |
| 2 | Live2D のモデルの数を数える | 同上 | 15 分 |
| 3 | Live2D 側を測る（スクリプトはその場で書く） | 同上 | 30 分 |
| 4 | 同じ数の Ugo9 のモデルを作る | 作業フォルダ（Ugo9） | 5 分 |
| 5 | Ugo9 側を測る | `<作業フォルダ>\..\Ugo9-bench`（Ugo9 だけのプロジェクト） | 30 分 |
| 6 | 結果を書いて返す | `pc-check/<日付>` の `docs/進行/PC確認/<日付>/` | 15 分 |

## 同じにする条件（両方の側で同じ数字にする）

| 項目 | 値 |
|---|---|
| Unity | 同じ版（例：6000.3 の最新）。テンプレート「Universal 2D」（URP） |
| Color Space | Gamma（両方同じなら Linear でもよいが、そろえる） |
| 窓 | Player → Resolution and Presentation → Fullscreen Mode を **Windowed**、**1280×720** |
| VSync | Project Settings → Quality → **VSync Count を Don't Sync**。スクリプトでも `QualitySettings.vSyncCount = 0`、`Application.targetFrameRate = -1` |
| CPU の時間を取る設定 | Player → Other Settings → **Frame Timing Stats** にチェック |
| ビルド | File → Build Profiles → Windows、**Development Build は外す** |
| 体数 | **50・400・1600・6400** の順 |
| 時間 | 体数ごとに、置いてから **3 秒待ち、続く 10 秒**を測る |
| 並べ方 | 下の「並べ方」 |
| 動き | 待機の動き（顔の向き・まばたき・呼吸・髪の物理）がループする。キャラ i は時刻 `i × 0.37` 秒から始める |
| 測る物 | 下の「測る物」 |

### 並べ方（カメラと格子）

- カメラは正射影。見える範囲がちょうど 1280×720 px（Unity の単位で、1 px = 1 / pixelsPerUnit）。左上が (0, 0)、下向きに px が増える並べ方で考える
- 体数 n のとき：`cols = ceil(sqrt(n × (1280 / 720) / 0.6))`、`rows = ceil(n / cols)`、マスの高さ `cellH = 720 / rows`、幅 `cellW = 1280 / cols`
- キャラ i（0 から）は、列 `i % cols`・行 `floor(i / cols)` のマス。キャラの**キャンバス（モデル全体の枠）の高さが `0.95 × cellH`** になるように拡大・縮小し、キャンバスの下の真ん中を「マスの横の真ん中、マスの下から `0.025 × cellH` 上」に合わせる
- 例：n = 50 → cols 13・rows 4・キャラの高さ 171 px、400 → 35・12・57 px、1600 → 69・24・28.5 px、6400 → 138・47・約 14.6 px

### 測る物（Unity の API。どちらの側も同じ物を使う）

| 項目 | 取り方 | 単位 |
|---|---|---|
| 平均 fps | 10 秒のフレーム数 ÷ 実際にかかった秒（`Time.realtimeSinceStartup`） | fps |
| メインスレッドの CPU の時間 | 毎フレーム `FrameTimingManager.CaptureFrameTimings()` → `GetLatestTimings(1, …)` の `cpuMainThreadFrameTime` の平均（Frame Timing Stats が要る） | ms |
| 描く回数 | `ProfilerRecorder.StartNew(ProfilerCategory.Render, "Draw Calls Count")` の平均。**Development Build でない時は数えられない**（-1 になる）ので、下の「描く回数だけは Play で」も行う | 回 |
| メモリ | `ProfilerRecorder.StartNew(ProfilerCategory.Memory, "System Used Memory")` の最後の値（あわせて "Total Used Memory"・"GC Used Memory"） | MB |

- **描く回数だけは Play で**：ビルドした物では描く回数が数えられないので、エディタの Play（Game ビューを 1280×720 にして）で同じ並べ方にし、Game ビューの「Stats」の **Batches**（または Profiler の Rendering の Draw Calls）を体数ごとに読む

## 1. Live2D 側のプロジェクトを作る（ユーザーと一緒に）

1. **ユーザーが** Live2D の公式サイトから「Cubism SDK for Unity」を落とす。約款（ライセンス）はユーザーが読んで同意する。どの版を落としたかを記録
2. 比べるモデルを決める（ユーザーの持っている Live2D のモデル。待機のモーションと物理の設定があるもの）。モデルのファイルは PC の中だけ
3. Unity Hub →「新しいプロジェクト」→「Universal 2D」→ 場所 `<作業フォルダ>\..\Live2D-bench`（**Ugo9 のパッケージは入れない**）
4. 上の「同じにする条件」の設定をする
5. **SDK の公式マニュアル（Live2D の公式サイトの、Unity 向けの手引き）に従って**、SDK を取り込み、モデルを置き、待機のモーションと物理が動くことを確かめる。SDK のコードは開いて読まない。うまく行かない時は、マニュアルとエラーの文だけで進める

## 2. Live2D のモデルの数を数える

数えるのは次の数だけ（絵やデータは写さない）：

| 項目 | 数え方 |
|---|---|
| パーツ（描く物）の数 | SDK の公開の API（マニュアルにある、モデルの描く物の一覧）で数える。または Cubism Viewer の表示 |
| 頂点の数（全部の和） | 同上（描く物ごとの頂点数の和） |
| パラメータの数 | 同上 |
| ワープ（ワープデフォーマ）の数 | Cubism Editor・Viewer で見える時はその数。分からない時は「不明」と書き、Ugo9 側は 12 にする |
| テクスチャの枚数と大きさ | モデルのフォルダのテクスチャの画像の枚数と、幅×高さ |
| キャンバスの大きさ | マニュアルにある取り方（モデルの大きさ）で。並べ方の「キャンバスの高さ」に使う |
| 待機の動きに入っている物 | 顔の向き・まばたき・呼吸・髪の物理があるか |

## 3. Live2D 側を測る

1. PC の Claude Code が、Live2D 側のプロジェクトの中に、測るスクリプトを**その場で**書く。使ってよいのは、Unity の API（上の「測る物」と同じ物）と、SDK の公式マニュアルに書かれた公開の使い方だけ。**Ugo9 のファイル（UgoBench.cs など）を写したり、入れたりしない**
   - スクリプトがすること：体数ごとにモデルを n 体、上の「並べ方」で置く → 待機のモーションをループで流し（キャラ i は `i × 0.37` 秒から）、物理を有効にする → 3 秒待つ → 10 秒測る → 次の体数。終わったら結果を CSV（`characters,fps,cpuMainMs,drawCalls,systemMemoryMB,totalUsedMemoryMB,gcMemoryMB,frames`）に書いて終わる
   - 同じモデルを n 体置く時に、SDK のマニュアルに勧められた置き方（プレハブの複製など）があればそれに従う
2. シーンを保存し、上の条件でビルド（`<作業フォルダ>\..\Live2D-bench-build`）して実行。CSV を読む
3. 「描く回数だけは Play で」を行う
4. このスクリプトとプロジェクトは PC の中に残す（リポジトリには入れない）

## 4. 同じ数の Ugo9 のモデルを作る

作業フォルダ（Ugo9）で、2 で数えた数を入れて：

```
node engines/bench/make_model.mjs --out ..\Ugo9-bench\Assets\Bench --parts <パーツ> --vertices <頂点> --params <パラメータ> --warps <ワープ> --texture <テクスチャの大きさ> --textures <枚数>
```

- 合成のキャラ（600×1000 px、四角いパーツの集まり）ができる。数は Live2D のモデルに合わせるが、絵は関係ない。最後に出る 1 行（作った数）を結果に書く
- 待機の動き（6 秒ループ）：顔の向き（AngleX・AngleY・AngleZ）、まばたき（EyeOpenL・R）、呼吸（Breath）、体の揺れ（BodyAngleX）、髪の物理 2 つ（振り子）
- テクスチャの大きさは、Live2D のモデルのいちばん大きいテクスチャの辺（例：2048）

## 5. Ugo9 側を測る

1. Unity Hub →「新しいプロジェクト」→「Universal 2D」→ 場所 `<作業フォルダ>\..\Ugo9-bench`（**Live2D の物は入れない**）。4 のモデルはここの `Assets/Bench` に作る（4 を先にしてもよい。その時は Unity を開いた後に取り込まれる）
2. 上の「同じにする条件」の設定をする
3. `docs/エンジン.md`「PC での確認」の手順 1 と 4 で Ugo9 のパッケージを入れ、Samples から「**Bench**」を Import
4. 新しいシーン（Basic 2D）→ 空の GameObject に `UgoBench` を付け、Model に `Bench/model`、Output Folder に `<作業フォルダ>/build/bench`（`/` 区切りの絶対パス）を入れる。シーンを `Assets/UgoBench.unity` に保存
5. まずエディタで Play して、動くこと・終わると止まることを確かめる。Game ビューの Stats の Batches を体数ごとに読む（「描く回数だけは Play で」）
6. 上の条件でビルド（`<作業フォルダ>\..\Ugo9-bench-build`）して実行。終わると窓が閉じる。`<作業フォルダ>\build\bench\ugo_bench.csv` と `.json` ができる
   - `ugoDraws` は Ugo9 が数えた自分の描く回数（ビルドした物でも取れる）。`ugoCoreMs`・`ugoUploadMs` は芯の計算と GPU へ送る分の CPU の時間

## 6. 結果の書き方

`docs/PC確認.md` の返し方と同じく、ブランチ `pc-check/<日付>` の `docs/進行/PC確認/<日付>/` に `比較_Live2D.md` を作る。**Live2D の物は数字だけ**（スクリプト・モデル・絵・画面の写しは入れない）。

```
## Live2D と Ugo9（Unity、同じ条件）

- PC：<CPU の名前>、<GPU の名前>（ドライバ <版>）、RAM <GB>、Windows <版>
- Unity <版>、URP <版>、Color Space <Gamma/Linear>、1280×720 の窓、VSync オフ、Development Build なし
- Live2D：Cubism SDK for Unity <版>
- Ugo9：main <commit>、パッケージ <版>

### モデルの数

| 項目 | Live2D のモデル | Ugo9 の合成のモデル（make_model の出力） |
|---|---|---|
| パーツ |  |  |
| 頂点 |  |  |
| パラメータ |  |  |
| ワープ |  |  |
| テクスチャ（枚数×大きさ） |  |  |
| 待機の動き | （顔の向き・まばたき・呼吸・物理のどれがあるか） | 顔の向き・まばたき・呼吸・体の揺れ・物理 2 つ |

### 測った値（ビルドした物）

| 体数 | fps（L2D / Ugo9） | メインスレッド CPU ms（L2D / Ugo9） | 描く回数・Play の Batches（L2D / Ugo9） | System Used Memory MB（L2D / Ugo9） |
|---|---|---|---|---|
| 50 |  |  |  |  |
| 400 |  |  |  |  |
| 1600 |  |  |  |  |
| 6400 |  |  |  |  |

- Ugo9 の ugo_bench.csv の全文（ugoCoreMs・ugoUploadMs を含む）
- 気づいたこと（見た目の違い、止まった・落ちた所など）
```

結果は内部の判断だけに使う。クラウドのゲームエンジンの担当は、この結果から Ugo9 側の重い所を直す。
