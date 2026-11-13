# id を CSV でまとめて直す（`tools/names_csv.mjs`、2026-11-10、機能の比べ #11・利用者の声 #33）

モデルの id を表計算のアプリで一度に直す。

```
node tools/names_csv.mjs model.json --out names.csv                          # 書き出す
node tools/names_csv.mjs model.json --apply names.csv --out renamed.json     # 直した CSV を読む
```

- 1 行に 1 つの id：`kind`（param・part・bone・color・warp・chain・anim・expression）、`id`、`new_id`（空なら変えない）、`info`（読むだけ：パラメータの範囲、パーツの PSD のレイヤー、骨の親、アニメの長さなど）
- UTF-8 で、頭に BOM（表計算のアプリが UTF-8 と分かるように）。読む時は BOM・引用符・セルの中の改行も読む
- 読むと、その id が使われている所が全部ついてくる（`tools/rename_ids.mjs`。エディタの名前の変更と同じ結果になることを試しで確かめている：デフォーマ・物理・トラック・マスク・ウェイト・制約・エディタの設定）。PSD のレイヤーの一覧（`source.psd.layers` の part）もついてくる（PSD を読み直す時のため）
- 入れ替え（browL ↔ browR）もできる（使われていない名前を通して 2 回で変える）
- 止まる物（何も変えない。`level: 'error'` のお知らせ）：新しい id が使われている（`namesCsvTaken`）・2 回出る（`namesCsvTwice`）・無い id（`namesCsvNoId`）・知らない kind（`namesCsvKind`）・見出しの無い CSV（`namesCsvHeader`）
- `namesCsv`・`applyNamesCsv` はブラウザでも動く（エディタの窓用）
- 確かめ（`tests/names_csv_test.mjs`）：見本で 42 行。AngleX・face・head・idle を変え browL と browR を入れ替えると、参照が全部ついてきて（AngleX はどこにも残らない）、PSD の一覧も変わる。逆の CSV で戻すと元と同じ JSON。.ug9 は名前のほか同じ。止まる物、引用符・カンマ・改行の入った id、コマンド
