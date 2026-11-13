<!-- SPDX-FileCopyrightText: 2026 U5143 -->
<!-- SPDX-License-Identifier: MIT -->
# Ugo9 for GameMaker（拡張、作り始め）

ライセンスは MIT（芯・エンジンの包みとも。[docs/ライセンス.md](../../docs/ライセンス.md)）。

GameMaker で Ugo9 のキャラを動かす。芯（C）を GameMaker の拡張（ネイティブのライブラリ）に入れ、毎ステップ、拡張の中で動きを計算して三角形をバッファに書き、GML がそれを頂点バッファにして描く（部品のまとまりごとに 1 回）。

- `extension/ugo9_gm.c`：拡張のネイティブの側（芯を中に組み込む）
- `gml/Ugo9.gml`：スクリプト（`Ugo9Model`・`Ugo9Character`）
- `shaders/shd_ugo9.vsh`・`.fsh`：シェーダー `shd_ugo9`（GLSL ES）

まだ無い物：マスク（マスクのある部品は切り抜かれずに出る）、層・助け（見る・まばたき・口）。GML の側は、GameMaker の公式の手引きを読めない環境で書いたので、名前・引数は PC で確かめる（docs/PC確認.md「GameMaker」）。

## 作り方

```
cmake -S engines/gamemaker/extension -B build/gamemaker/lib -DCMAKE_BUILD_TYPE=Release
cmake --build build/gamemaker/lib --config Release
```

Windows は `build/gamemaker/lib/Release/ugo9_gm.dll`、Linux は `libugo9_gm.so`、macOS は `libugo9_gm.dylib`（Visual Studio 2022 の C++、または Xcode のコマンドラインツールが要る）。

## プロジェクトに入れる

1. **拡張**：アセットの「Extensions」→ 新しい拡張 → 「Add File」で `ugo9_gm.dll`（ほかの OS の物も同じ拡張に足せる）→ そのファイルに下の表の関数を全部足す（名前と External Name は同じ、引数と返り値の型は表のとおり。呼び出しの規約は cdecl）
2. **スクリプト**：新しいスクリプトに `gml/Ugo9.gml` の中身を貼る
3. **シェーダー**：新しいシェーダー（GLSL ES）を `shd_ugo9` という名前で作り、Vertex に `shd_ugo9.vsh`、Fragment に `shd_ugo9.fsh` の中身を貼る
4. **キャラ**：Ugo9 のエディタが書き出した `model.ug9` と PNG を、Included Files の同じフォルダに（例 `datafiles/ugo9/hero/`）

```gml
// Create
model = new Ugo9Model(working_directory + "ugo9/hero/model.ug9");
hero = new Ugo9Character(model);
hero.play("idle");
// Step
hero.x = x; hero.y = y; hero.xscale = 0.5; hero.yscale = 0.5;
hero.set_param("HeadTurnX", 20);
hero.step(delta_time / 1000000);
// Draw
hero.draw();
// マウスで当たり
if (mouse_check_button_pressed(mb_left)) show_debug_message(hero.part_at(mouse_x, mouse_y));
// Clean Up
hero.destroy(); model.destroy();
```

| Ugo9Character | |
|---|---|
| `x`・`y`・`xscale`・`yscale`・`angle` | モデルの原点（ふつうは足もと）の部屋の位置、大きさ、回転（度、image_angle と同じ向き） |
| `play(名前, 始める秒, 混ぜる秒)`・`stop()`・`animation`・`time`・`speed`・`playing` | アニメ（Godot の play と同じ引数） |
| `set_param`・`clear_param`・`clear_params`・`get_param` | パラメータ（置いた値はアニメの上に残る） |
| `show_expression(名前, 混ぜる秒)`・`hide_expression`・`only_expressions([名前…])`・`get_expression_weight` | モデルの表情 |
| `wind_x`・`wind_y`・`wind_gust` | 揺れ物に風（モデルのピクセル/秒²、y 下向き） |
| `step(秒)`・`draw()`・`part_at(x, y)`・`destroy()` | |

## 拡張の関数（全部、拡張のファイルに足す）

| 関数 | 引数（型） | 返り値 |
|---|---|---|
| `ugo9_error` | （無し） | string |
| `ugo9_model_load` | path: string | double |
| `ugo9_model_free` | model: double | double |
| `ugo9_texture_count` | model: double | double |
| `ugo9_texture_name` | model: double, i: double | string |
| `ugo9_animation_count` | model: double | double |
| `ugo9_animation_name` | model: double, i: double | string |
| `ugo9_animation_duration` | model: double, name: string | double |
| `ugo9_animation_loops` | model: double, name: string | double |
| `ugo9_part_name` | model: double, i: double | string |
| `ugo9_canvas` | model: double, which: double | double |
| `ugo9_create` | model: double | double |
| `ugo9_destroy` | ch: double | double |
| `ugo9_reset` | ch: double | double |
| `ugo9_play` | ch: double, name: string, time: double, weight: double | double |
| `ugo9_set_param` | ch: double, name: string, value: double | double |
| `ugo9_get_param` | ch: double, name: string | double |
| `ugo9_expression` | ch: double, name: string, weight: double | double |
| `ugo9_set_wind` | ch: double, x: double, y: double, gust: double | double |
| `ugo9_place` | ch: double, x: double, y: double, xscale: double, yscale: double, angle: double | double |
| `ugo9_update` | ch: double, dt: double | double |
| `ugo9_pick` | ch: double, x: double, y: double | double |
| `ugo9_buffer_size` | model: double | double |
| `ugo9_build` | ch: double, address: string, size: double | double |
| `ugo9_run_count` | ch: double | double |
| `ugo9_run_blend` | ch: double, r: double | double |
| `ugo9_run_texture` | ch: double, r: double | double |
| `ugo9_run_first` | ch: double, r: double | double |
| `ugo9_run_vertices` | ch: double, r: double | double |

`ugo9_build` の 2 つ目の引数は `buffer_get_address(バッファ)` を文字列の型の引数として渡す（GameMaker でネイティブにバッファを渡す時の決まった形）。1 頂点 32 バイト：位置 x・y（float 2 つ）、スクリーンの足し色 r・g・b（float 3 つ、頂点の形式の normal）、掛ける色と不透明度（4 バイト、colour）、テクスチャの u・v（float 2 つ）。

## 試し

`node tests/gamemaker_test.mjs`：拡張のネイティブの側を芯と一緒に組み立て（`-Werror`）、GameMaker 無しで、`Ugo9.gml` と同じ順に呼んで確かめる（読み込み・名前・パラメータ・三角形とまとまり・当たり・片付け）。CI は engines.yml の `gamemaker`。GameMaker の中での見え方は PC。
