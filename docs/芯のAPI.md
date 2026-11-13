<!-- SPDX-FileCopyrightText: 2026 U5143 -->
<!-- SPDX-License-Identifier: CC-BY-4.0 -->
# 芯の API（C と Web）

芯（`core/`、C99）と Web の再生部品（`web/ugo.js`）で使える物の一覧です。詳しい決まりは `core/include/ugo.h`・`core/include/ugo_raster.h` のコメントと `web/ugo.js` のコメント、形式は [形式](形式.md)、作りは [設計](設計.md)。ここに無い関数を足したら、この一覧にも足してください（`tests/api_doc_test.mjs` が確かめます）。

芯はメモリを確保せず、ファイルも読みません。呼ぶ側が渡したメモリだけを使い、どの機械でも同じビットの結果を出します（`tests/determinism_test.mjs`）。

## 毎フレームの流れ

```
C:   ugo_reset_params → ugo_apply_animation(_ex) …（重ね）→ ugo_set_param・ugo_apply_expression …
     → ugo_set_transform → ugo_update(dt) → ugo_frame を GPU へ（または ugo_deform_cpu）
     （ugo_set_transform はフレームの塊の 6・7 番目を 0 にする：全体の色はその後に書く。
      UgoAnimMask の表は呼ぶ間だけ読まれる：芯は持たない）
Web: animator.update(dt) → inst.reset() → animator.apply(inst) → look/blink/mouth/links.apply(inst)
     → inst.update(dt) → renderer.draw([inst, ...], w, h)
```

## 例（Web）

短い 1 ページの例が `web/examples/` にある（`node tools/serve.mjs` で開き、`http://localhost:8099/web/examples/`）。共通の準備（芯とモデルを読み、1 体を置き、毎フレーム回す）は `web/examples/common.js`。

| 例 | 使う物 |
|---|---|
| [読み込んで再生する](../web/examples/01_load.html) | `UgoRuntime.load`・`rt.loadModel`・`model.createInstance`・`inst.play`・`UgoRenderer` |
| [表情](../web/examples/02_expression.html) | `model.loadExpressions`（名前で書いたプリセット）・`UgoExpressionMixer` |
| [視線](../web/examples/03_look.html) | `UgoLook`（指・マウスの方を向く） |
| [まばたき](../web/examples/04_blink.html) | `UgoBlink` |
| [口](../web/examples/05_mouth.html) | `UgoMouth`（マイクの音の大きさで） |
| [当たり判定](../web/examples/06_hit.html) | `inst.hitTest`（当たりの領域）・`inst.pickPart`（一番手前のパーツ） |
| [決まったフレームで描く](../web/examples/07_frames.html) | `UgoFrames`（どの順に聞いても同じ n コマ目。動画の道具） |

例は、リポジトリのフォルダを `node tools/serve.mjs` か、どの静的なサーバー（`npx serve` など。`.wasm` の種類を知らないサーバーでも）で配って開く。ファイルを直に開く（file:）と、ブラウザが WASM とモデルを読ませないので、ページにそう出る。

## C：読み込み

| 関数 | 用途 |
|---|---|
| `ugo_model_mem_size_for(data, size)` | このファイルに要るモデルのメモリ（1.1 の曲線のキーは広げて持つ。アニメのトラックをまとまりに分けた表の分も含む：この表があると値の変わらないトラックをまとめて当てるので速い。少なく渡すと表なしで 1 本ずつ当てる。結果はビット単位で同じ）。0 は壊れたファイル |
| `ugo_model_init_sized(mem, mem_size, data, size)` | 確かめて読む（どの版でもこれでよい） |
| `ugo_model_mem_size()`・`ugo_model_init(mem, data, size)` | 1.0 の大きさで読む（表 41〜43 を持つ 1.1 は UGO_ERR_SIZE） |
| `ugo_last_error()` | 読めなかった理由（UGO_ERR_*） |
| `ugo_version()`・`ugo_model_format(m)`・`ugo_model_warnings(m)` | 芯の版、ファイルの版、後の 1.x で飛ばした物（UGO_WARN_*） |
| `ugo_instance_mem_size(m)`・`ugo_instance_init(mem, m)` | 1 体ぶん（画面のキャラ 1 人）のメモリと初期化 |

## C：モデルを調べる

| 関数 | 用途 |
|---|---|
| `ugo_param_count`・`ugo_find_param`・`ugo_param_name`・`ugo_param_min`・`ugo_param_max`・`ugo_param_default` | パラメータ |
| `ugo_bone_count`・`ugo_bone_name`・`ugo_bone_parent`・`ugo_bone_length`・`ugo_bone_rest` | 骨（基準の姿は親から見た x, y, 回転, scaleX, scaleY） |
| `ugo_part_count`・`ugo_part_name`・`ugo_part_range`・`ugo_part_texture`・`ugo_part_blend`・`ugo_part_flags`・`ugo_part_mask`・`ugo_part_color`・`ugo_part_warp`・`ugo_part_draw_order` | パーツ（頂点と三角形の範囲、合成、マスク、色、格子、描画順の値） |
| `ugo_vertex_count`・`ugo_index_count`・`ugo_positions`・`ugo_uvs`・`ugo_joints`・`ugo_weights`・`ugo_vertex_parts`・`ugo_indices` | メッシュ（GPU に 1 回送る物） |
| `ugo_morph_count`・`ugo_entry_count`・`ugo_csr_starts`・`ugo_entries` | 差分（頂点ごとの項目） |
| `ugo_extra_weight_count`・`ugo_extra_weight_starts`・`ugo_extra_weights` | 5 本目からの骨の重み |
| `ugo_texture_count`・`ugo_texture_name`・`ugo_canvas` | テクスチャの名前、キャンバス |
| `ugo_mask_count`・`ugo_mask_channel_count`・`ugo_mask_channel`・`ugo_mask_parts` | マスク |
| `ugo_color_count` | 色の数 |
| `ugo_warp_count`・`ugo_warp_info`・`ugo_warp_name`・`ugo_warp_parent`・`ugo_warp_bone`・`ugo_warp_rest_points` | ワープ格子 |
| `ugo_chain_count`・`ugo_chain_info`・`ugo_chain_bones`・`ugo_chain_name` | 揺れ物の鎖 |
| `ugo_constraint_count`・`ugo_skeleton_is_simple` | 制約の数、骨が単純か（エンジンが自分で骨を組める） |
| `ugo_physics_count`・`ugo_physics_output` | パラメータの物理 |
| `ugo_has_draw_order` | 描画順が動くモデルか |
| `ugo_expression_count`・`ugo_expression_name`・`ugo_expression_fade`・`ugo_expression_items` | 表情 |
| `ugo_find_bone`・`ugo_find_part` | 骨・パーツの名前から番号（-1：無い。毎フレームではなく最初に一度） |
| `ugo_animation_count`・`ugo_find_animation`・`ugo_animation_name`・`ugo_animation_duration`・`ugo_animation_loop` | アニメ |
| `ugo_animation_track_count`・`ugo_animation_track`・`ugo_animation_track_key`・`ugo_animation_track_value` | アニメのトラックを読む（曲線エディタ。1.1 の曲線は分けた点で） |
| `ugo_frame_float_count`・`ugo_frame_skin_offset`・`ugo_frame_opacity_offset`・`ugo_frame_morph_offset`・`ugo_frame_color_offset`・`ugo_frame_warp_offset` | フレームの塊の並び（6・7 番目はホストの物） |

## C：動かす

| 関数 | 用途 |
|---|---|
| `ugo_reset_params` | 毎フレームのはじめに基準へ戻す |
| `ugo_set_param`・`ugo_get_param`・`ugo_params` | パラメータ |
| `ugo_apply_animation(in, anim, t, w)` | アニメを重みで混ぜる（トラックのある物だけ） |
| `ugo_apply_animation_ex(..., flags, mask)` | 足し算の層（UGO_ANIM_ADD）、覆い（UgoAnimMask：骨・パーツ・パラメータ…ごと） |
| `ugo_apply_expression`・`ugo_resolve_params`・`ugo_apply_params` | 表情（モデルの物、名前で書いたプリセット） |
| `ugo_set_bone_offset`・`ugo_get_bone_offset` | アニメ無しで骨を動かす（基準からの差） |
| `ugo_set_bone_world` | 骨を世界の姿に置く（補正、ワールドの軸での入力） |
| `ugo_solve_ik_to` | 骨の先を点へ（ドラッグ、骨と親を count 本まで） |
| `ugo_set_transform` | 画面での置き方 |
| `ugo_set_wind`・`ugo_get_wind`・`ugo_wind_time`・`ugo_set_wind_time` | 揺れ物の鎖に風（揺らぎは時計の関数） |
| `ugo_update(in, dt)` | 計算して、フレームの塊を作る |
| `ugo_settle_physics` | 揺れを落ち着かせる（場面の始め） |
| `ugo_reset_physics`・`ugo_get_physics_state`・`ugo_set_physics_state`・`ugo_chain_state_floats`・`ugo_get_chain_state`・`ugo_set_chain_state`・`ugo_get_last_placement`・`ugo_set_last_placement` | 物理の状態の保存と復元（巻き戻し、直したモデルへの引き継ぎ） |

## C：結果を読む

| 関数 | 用途 |
|---|---|
| `ugo_frame` | GPU に送るフレームの塊 |
| `ugo_draw_order`・`ugo_draw_order_key` | 今の描画順（キーが同じなら前と同じ順） |
| `ugo_bone_world`・`ugo_bone_pose` | 骨の世界の行列、親から見た結果の姿 |
| `ugo_bone_world_placed` | 骨の世界の行列に置き方（`ugo_set_transform`）を掛けたもの：画面のどこか（武器や効果を付ける） |
| `ugo_warp_eval`・`ugo_warp_points` | 格子の今の形 |
| `ugo_deform_cpu`・`ugo_deform_part_cpu` | CPU で変形した頂点（全部、1 パーツ） |
| `ugo_pick_part` | 点にある一番手前のパーツ（描画順・マスク込み） |
| `ugo_pick_area` | 当たりの領域（名前が `hit:`・`当たり:` のパーツ） |
| `ugo_bounds` | 変形後の四角（パーツ、全体） |
| `ugo_bounds_estimate` | 頂点を置かずに、全部を必ず含む四角（骨ごとの休みの四角を動かす。間引き用、少し大きい） |

pick・area・bounds の座標はモデルのピクセル（y 下）、置き方の前。`deformed` は `ugo_deform_cpu` の結果か NULL（NULL なら芯が要る頂点だけ置く。値は同じ）。

## C：CPU で描く（`ugo_raster.h`）

| 関数 | 用途 |
|---|---|
| `ugo_raster_clear`・`ugo_raster_resolve` | 描く先を消す、細かく描いた物を縮めて 8 ビットに |
| `ugo_raster_instance`・`ugo_raster_instance_masked`・`ugo_raster_instance_ex` | 1 体を描く（マスク込み、最近傍のテクスチャ UGO_RASTER_NEAREST） |

## Web（`web/ugo.js`）

| クラス・関数 | 用途 |
|---|---|
| `UgoRuntime.load(url または bytes, { simd })`・`rt.loadModel(bytes)` | WASM を読み、モデルを読む（どの版も）。WASM の中身（ArrayBuffer・型付き配列）も渡せる（Node やサーバー側では fetch が file: を読めないので）。ブラウザが WebAssembly の SIMD を使えれば、`ugo.wasm` で終わる URL の代わりに隣の `ugo_simd.wasm`（結果はビット単位で同じ、速い）を読む。無ければ `ugo.wasm`。`{ simd: false }` で渡した物だけ。`rt.simd` がどちらか、`UgoRuntime.simdSupported()` がブラウザが使えるか |
| `UgoFrames(model, { fps, setup, every })` | 決まったフレーム：`frame(n)` は 0 から決まった速さで流した時の n コマ目（物理込み）を、どの順に聞かれても同じに返す（下の「決まったフレームで描く」） |
| `UgoModel` | `params`・`bones`・`animations`・`expressions`・`warps`・`chains`・`hitAreas`・`canvas`・`hasDrawOrder`・`skeletonIsSimple`・`warnings`・`format` |
| `model.createInstance()` | 1 体を作る |
| `model.stats()` | 数とバイト数（エディタの数の一覧） |
| `model.animationTracks(name)` | トラックとキー（作業用 JSON の単位）と `value(t)` |
| `model.animationMask({ bones, parts, params, morphs, constraints, colors })` | 覆い |
| `model.trajectory(anim, bone, opts)` | 骨の先の軌跡（物理込み） |
| `model.loadExpressions(preset)`・`model.exportExpressions()` | 表情のプリセット（.ug9x） |
| `model.meshData()`・`model.partData()` | GPU に送るメッシュ、パーツの情報 |
| `model.boneIndex(name)`・`model.partIndex(name)` | 名前から番号 |
| `model.warpCellToModel`・`model.warpModelToCell` | 格子のマス目の座標とモデル座標 |
| `UgoInstance`（`inst`） | 1 体。以下はそのメソッド |
| `inst.reset()`・`inst.set`・`inst.get`・`inst.paramValues()` | パラメータ |
| `inst.play(name, t, w, { add, mask })` | アニメ（足し算・覆い） |
| `inst.expression(e, w)` | 表情 |
| `inst.setBoneOffset`・`inst.boneOffset`・`inst.setBoneWorld`・`inst.dragBone`・`inst.boneLocal`・`inst.boneWorld`・`inst.boneWorlds` | 骨 |
| `inst.setTransform`・`inst.update(dt)`・`inst.frame()` | 置き方、計算、フレームの塊 |
| `inst.setWind`・`inst.settlePhysics`・`inst.resetPhysics` | 物理 |
| `inst.saveState()`・`inst.loadState(s)`・`inst.copyStateFrom(old)` | 状態の保存と復元（風の時計も） |
| `inst.pickPart`・`inst.hitTest`・`inst.bounds`・`inst.boundsEstimate` | 当たり判定、当たりの領域、四角、速い大きめの四角 |
| `inst.boneWorldPlaced` | 置き方込みの骨の行列 |
| `inst.deformedPositions()`・`inst.deformedPart(part)`・`inst.deformInPlace()` | CPU で変形した頂点 |
| `inst.warpPoints`・`inst.warpEval` | 格子 |
| `inst.drawOrder()`・`inst.drawOrderKey()` | 描画順 |
| `inst.measure(n, anim)` | update の時間 |
| `UgoAnimator` | 層・クロスフェード・queue・速さ・範囲・足し算・覆い：`play`・`queue`・`stop`・`update`・`apply`・`on('end')`・`save`・`load` |
| `UgoExpressionMixer` | 表情を名前でフェード：`show`・`hide`・`only`・`update`・`apply`・`weights`・`fadeOf` |
| `UgoLook` | 点の方を向く：`lookAt`・`stop`・`update`・`apply` |
| `UgoBlink`・`UgoMouth` | 自動まばたき、音の大きさで口：`update`・`apply`（UgoMouth は `level`） |
| `UgoLinks` | パラメータの連動（コードから）：`add`・`clear`・`update`・`apply` |
| `UgoRenderer(gl, model, images, opts)` | WebGL2 で描く：`draw(instances, w, h, mode)`・`setModel`・`setImages`・`setSampling`・`runsFor`・`dispose`・`disposeModel` |
| `loadImage`・`BLEND` | 画像を読む、合成の番号 |

## 決まったフレームで描く（動画の道具：Remotion など）

動画の道具は、フレームを好きな順に、いくつもの所（ワーカー）で同時に描かせる。毎コマ前のコマから `update(dt)` で進める作りだと、髪の揺れ（物理）が順によって変わり、つなぐとずれる。`UgoFrames` は「0 コマ目から 1/fps ずつ流した時の n コマ目」を、どの順に聞かれても、別のワーカーでも、ビット単位で同じに返す（`tests/frames_test.mjs`）。

```js
import { UgoRuntime, UgoFrames } from './ugo.js';
const frames = new UgoFrames(model, {
  fps: 30,
  setup: (inst, t, n) => { inst.play('idle', t); inst.setTransform(1, 0, 0, 1, 200, 500); },  // 時刻 t だけから決める
});
// Remotion なら：const n = useCurrentFrame();
renderer.draw([frames.frame(n)], width, height);
```

- `setup` は毎コマ `reset()` の後に呼ばれる。アニメ・パラメータ・置き方を、時刻だけから決めて書く（乱数や前のコマの値を使わない。風は `inst.setWind` を setup の中で）
- 1 秒（`every`）ごとに状態を覚えるので、戻る時も最大 1 秒ぶん流し直すだけ。進む時は続きから
- 0 コマ目は dt 0、ほかは 1/fps で `update` する

## サーバー側（Next.js・Nuxt など）

`web/ugo.js`・`web/ugo_webgpu.js`・`web/tracking.js` は、読み込む（import する）だけでは window・document・location・navigator に触らない（`tests/ssr_test.mjs` が、触ると落ちる Node で確かめる）。描く物（`UgoRenderer`・`createRenderer`・`loadImage`）はブラウザだけで、クライアント側で呼ぶ。サーバー側で芯を動かす時は、`UgoRuntime.load(fs.readFileSync('ugo.wasm'))` のように中身を渡す。

## Web の WebGPU（`web/ugo_webgpu.js`、使う時だけ読む）

| クラス・関数 | 用途 |
|---|---|
| `createRenderer(canvas, model, images, opts)` | WebGPU でキャンバスに出せれば `UgoGPURenderer`、出せなければ WebGL2 の `UgoRenderer`（`kind` が `'webgpu'`・`'webgl2'`）。先に使い捨てのキャンバスで 1 回出して確かめる（ヘッドレスのブラウザは描けても出せないことがある）。`opts.webgpu: false` で WebGL2 |
| `UgoGPURenderer(device, context, model, images, opts)` | WebGPU で描く。絵は UgoRenderer と同じ（テストで比べる）：`draw(instances, w, h, mode, target, { clear })`・`setModel`・`setImages`・`setSampling`・`dispose`・`disposeModel`。draw は既定で先に透明で消す（`clear: null` で上に描く） |

## 道具（`tools/`、作業用 JSON に対して）

| モジュール | 用途 |
|---|---|
| `compile.mjs` の `compileUgo(src, opts)` | 作業用 JSON → .ug9 |
| `curve_keys.mjs` | 1.1 の曲線のキー（芯と同じ展開、`curvePieces`・`packTracks`・`readCurveTracks`） |
| `expressions.mjs` | 表情のプリセット |
| `key_reduce.mjs` の `reduceKeys` | 余計なキーを消す、ループの継ぎ目 |
| `rebind_pose.mjs` の `rebindPose` | 今の姿で結び直す（格子も） |
| `mesh_subdivide.mjs` の `subdivide` | 三角形を 4 つに |
| `weights.mjs` の `editWeights` | 重みをならす・削る・本数・入れ替え・ロック |
| `deform_path.mjs` の `pathMorph` | 変形パス（線を曲げて差分に） |
| `path_bake.mjs` | 線に沿って流す動きを骨のキーに |
