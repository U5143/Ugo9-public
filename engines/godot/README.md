<!-- SPDX-FileCopyrightText: 2026 U5143 -->
<!-- SPDX-License-Identifier: MIT -->
# Ugo9 for Godot（GDExtension）

ライセンスは MIT（芯・エンジンの包みとも。[docs/ライセンス.md](../../docs/ライセンス.md)）。

Godot 4.4 以上で Ugo9 のキャラを動かす拡張と、見本のプロジェクト。設計は [docs/エンジン.md](../../docs/エンジン.md)。

## ビルド

CMake と C++17 のコンパイラと Python 3 が要る（godot-cpp は自動で取ってくる。Python は godot-cpp が API の C++ を作るのに使う。初回は数分かかる）。

```
cmake -S engines/godot -B build/godot -DCMAKE_BUILD_TYPE=Release
cmake --build build/godot --config Release
```

macOS ではインテルと Apple シリコンの両方で動く形にするため `-DCMAKE_OSX_ARCHITECTURES="arm64;x86_64"` を足す。Windows・macOS・Linux 向けにビルドした物は、CI（`godot`・`godot-desktop` のジョブ）の成果物からも取れる。

できた拡張は `engines/godot/project/addons/ugo9/bin/` に入り、見本のキャラ（`samples/basic`）が `project/samples/basic/` にコピーされる。`engines/godot/project` を Godot で開いて実行すると、見本（大勢のキャラを 1 回の描画で描き、手前のキャラがマウスを見る）が動く。

自分のプロジェクトで使う時は `project/addons/ugo9/` をそのままコピーする。

## 使い方

```gdscript
var model: UgoModel = load("res://chara/model.ug9")   # アトラスは同じフォルダの PNG

var batch := UgoBatch.new()          # この下のキャラをモデルごとに 1 回で描く
add_child(batch)
for i in 100:
    var c := UgoCharacter.new()
    c.model = model
    c.play("idle", randf() * 6.0)
    c.position = Vector2(40 + i * 12, 600)
    c.scale = Vector2(0.3, 0.3)
    batch.add_child(c)

c.set_param("HeadTurnX", 20)           # 置いた値は clear_param まで残る（アニメの上に乗る）
c.add_blend("talk", t, 0.5)          # 次の 1 回だけ重ねる（毎フレーム呼ぶ）
```

UgoCharacter で使える物（Unity の UgoCharacter・Unreal の Ugo Character と同じ働き。名前は Godot の流儀の snake_case）：

| 何を | 使う物 |
|---|---|
| モデル | `model`（UgoModel） |
| アニメ | `animation`・`playing`・`speed`・`time`、`play(名前, 始めの秒, 混ぜる秒)`、`play_next(名前, 混ぜる秒)`（今のが終わったら）、`stop()`、`is_finished()`、signal `animation_finished(名前)` |
| 時計 | `manual`（true なら時間と揺れ物は `advance(秒)` の時だけ進む。同期の要るゲーム・リプレイ・テスト）、`preview_in_editor`（エディタの中でアニメを進めるか） |
| パラメータ | `set_param`・`clear_param`・`clear_params`・`get_param`（直前の計算の値。アニメ・揺れ物を含む）、インスペクタの `parameters/<名前>`（スライダー。set_param の下） |
| 層（1, 2, …） | `play_layer(層, 名前, 混ぜる秒, 足すか, マスク, 重み)`・`queue_layer`（マスクは `{ "bones": [...], "parts": [...], "params": [...] }`）、`stop_layer`、`set_layer_weight`・`get_layer_weight`、`get_layer_animation`、signal `layer_finished(層, 名前)` |
| 1 回だけ重ねる | `add_blend(名前, 時間, 重み)`（次の計算で 1 回。毎フレーム呼ぶ。AnimationPlayer から使う形） |
| 表情 | `expression`（最初から）、`show_expression`・`hide_expression`・`only_expressions`・`get_expression_weight`・`get_expression_names`、`load_expressions(JSON の文字列)`（返り値はモデルに無いパラメータの名前） |
| 助け | `look_target`（NodePath）・`look_at_point(点)`・`stop_looking()`・`look_from`・`look_range`（見る）、`auto_blink`（まばたき）、`lip_sync_bus`（バスの音で口。ノイズゲート `lip_sync_gate_db`・`lip_sync_range_db`、強さ `lip_sync_gain`）、`set_mouth_level(0〜1)`（負でアニメに戻す） |
| 当たり | `get_part_at(グローバルの点)`（パーツの名前、無ければ ""）、`hit_test`、`get_area_at`・`get_area_names`（「hit:」「当たり:」の名前のパーツ）、`get_part_rect(パーツ)`（ノードの中の座標の四角。"" は全体） |
| 骨 | `get_bone_transform(骨)`（グローバルの Transform2D。物を持たせる）、`reach_for(骨, グローバルの点, 何本)`（このフレームだけ、骨の先を点へ） |
| 揺れ物 | `wind`・`wind_gust`（風。モデルのピクセル/秒²、y 下向き）、`reset_physics()` |
| 色と前後 | `modulate`・`self_modulate`（キャラ全体の色）、`z_index`、UgoBatch の `y_sort_enabled`（下にいる方を前に） |
| そのほか | `update_now()`（今すぐ計算する） |

| UgoBatch | |
|---|---|
| （子の UgoCharacter） | モデルごとに、合成の種類が続く部品のまとまり 1 つにつき 1 回で描く。何体いても回数は同じ |
| `screen_approximate` | スクリーンの合成を、画面のコピーを読まずに近い式で（速いが、少し違う） |
| `get_draw_count()`・`get_character_count()` | 前のフレームの描画の回数と、描いたキャラの数 |

UgoBatch の下に無い UgoCharacter は自分 1 体を 1 回で描く。計算は全ノードの `_process` の後（`RenderingServer.frame_pre_draw`）に 1 回なので、`_process` で入れた値はその場で絵に出る。

| UgoModel | |
|---|---|
| `get_parameter_names()`・`get_parameter_min/max/default(名前)` | |
| `get_animation_names()`・`get_animation_length(名前)` | |
| `get_part_names()`・`get_expression_names()`・`get_texture_names()`・`get_canvas_size()`・`get_canvas_origin()` | |
| `atlas`・`set_texture(番号, テクスチャ)` | 使うテクスチャ（既定は .ug9 と同じフォルダの PNG） |
| `pixel_art` | ドット絵（近い画素で読む） |
| `load_file(パス)`・`load_bytes(バイト列, フォルダ)` | `load()` を使わずに読む |

座標は Godot の 2D と同じピクセル・y 下向き。キャラの原点は `.ug9` のモデルの (0, 0)（見本では足もと）。

使い方の例（会話の場面、アニメの切り替え、層、カットシーン、クリック、色と前後、骨と風）は [docs/エンジンの使い方.md](../../docs/エンジンの使い方.md)。

## 見本（`engines/godot/project` を開く）

| シーン | 中身 |
|---|---|
| `demo/main.tscn`（F5） | 群衆を 1 つの UgoBatch で描き（上下で数を倍・半分）、手前の 1 体が会話の場面：マウスを見る、まばたき、1〜9 で表情（`demo/basic.ug9x` のプリセットとモデルの物、0 で無し）、Space の間しゃべる（口）、A でアニメを 0.3 秒で混ぜて切り替え。Unity の「Demo」と「Conversation」を合わせた物 |
| `demo/playground.tscn`（開いて F6） | 見本のキャラと欄：アニメの一覧、パラメータごとのスライダー、まばたき、マイクで口（`lip_sync_bus` とノイズゲート）、クリックしたパーツの名前。Unity の「Playground」、Unreal の Playground Actor、Web の web/engines/ と同じ |
| `demo/conversation.tscn`（開いて F6） | 1 体の会話の場面：マウスを見る、まばたき、1〜9 で表情、Space の間しゃべる、A でアニメを混ぜて切り替え。Unity の「Conversation」と同じ |
| `demo/ordering.tscn`（開いて F6） | 並べ方と当たり：3 体を `y_sort_enabled` の UgoBatch に（下の物が前、ドラッグで入れ替わる）、1〜3 で `z_index` で前へ、T で UgoBatch ごと木（Sprite2D）の前・後ろ、右の 1 体は `modulate` で色、クリックでキャラ・パーツ・当たりの名前。Unity の手順 11-4 と同じ |

書き出したゲームで `.ug9x` を読む時は、書き出しの設定の「リソース以外のファイル」に `*.ug9x` を足す。

## テスト

`GODOT=Godot の実行ファイル node tests/godot_test.mjs`（Web のテストと同じ Playwright が要る）。Compatibility（OpenGL）で場面を描き、同じ場面を Web 版で描いた絵と比べる。場面の 1 つは、エディタと同じく作業用 JSON を `tools/compile.mjs` で `.ug9` にした物（`project/samples/editor/`）を使う。エディタで作って書き出した `.ug9`（とアトラスの PNG）は、同じように Godot のプロジェクトに置けばそのまま動く。CI（`.github/workflows/engines.yml` の `godot`）は Godot 4.7.2 で流す。結果の絵は `build/godot/`。
