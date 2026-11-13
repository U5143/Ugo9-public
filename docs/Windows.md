# Windows での芯のビルド

芯（`core/`）・共有ライブラリ（`ugo.dll`）・書き出しのコマンド（`ugo_export.exe`）が Windows で通るかの記録です。2026-11-04 からユーザーの PC で確かめる時の手順も書きます。GitHub Actions の枠が切れているので、Windows の CI はまだ通していません。

## 本物の Windows の PC で確かめたこと

| いつ | PC | 結果 |
|---|---|---|
| 2026-11-01（PC-1） | Intel Iris Xe、MSVC 19.44（VS 2022 Build Tools 17.14） | 警告 0、ctest 100%。SHA-256 は basic.rgba・warp.rgba・basic.gif・warp.gif の 4 つとも Linux と一致。速さ：200 体の update 0.267 ms/frame |

## ここ（Linux）で確かめたこと（2026-10-31）

| 確かめたこと | 道具 | 結果 |
|---|---|---|
| クロスビルド（静的ライブラリ・`ugo.dll`・`ugo_export.exe`・`ugo_test.exe`） | MinGW-w64 GCC 13（`x86_64-w64-mingw32-gcc`）、CMake 3.28 | 通る。芯は `UGO_STRICT=ON`（警告をエラーに）でも通る |
| 芯のテスト（壊したファイル 9,000 通りを含む） | wine 9.0 で `ugo_test.exe` | 全部通る |
| 同じ入力から同じ結果 | `ugo_export` の raw（RGBA）を Linux と Windows で比べる（見本とワープのテストデータ、20 コマ） | 同じバイト。APNG も同じバイト。GIF も #44（並べ方の直し）の後は同じバイト |
| DLL を C から使う | `UGO_DLL` を付けて `ugo.dll` にリンク、wine で実行 | 通る。書き出された関数は 96 個 |
| ヘッダーを C++ から読む | `clang++ -std=c++11 -Wall -Wextra -pedantic` | 警告なし |
| MSVC で出そうな警告 | GCC と clang の `-Wall -Wextra -Wpedantic -Wconversion -Wshadow -Wstrict-prototypes -Wmissing-prototypes` | 芯は 0 件（符号の変換 1 か所を直した）。`-Wdouble-promotion` の 113 件は、float を double に広げて計算する所で、わざとそうしている（精度のため。MSVC は広げる向きでは警告しない） |

MSVC そのものはここに無いので、MSVC での確かめは 11/4 の PC でします。

### 直したこと

- `CMakeLists.txt`
  - MSVC の時は `/utf-8`（ソースのコメントにある日本語を、日本語の Windows で CP932 として読まないため。読まれると C4819 の警告が出る）
  - 芯の警告：MSVC は `/W4`、GCC・clang は上の組み合わせ。`-DUGO_STRICT=ON` で警告をエラーに
  - 共有ライブラリの名前は Windows では MinGW でも `ugo.dll`（`lib` を付けない）。エンジンの部品は `ugo` の名前で読める
- `ugo.h`：C・C++ から DLL を使う時のため、`UGO_DLL` を定義すると `__declspec(dllimport)` になる（C# の P/Invoke や静的ライブラリでは要らない）
- 芯のソースから、日本語のファイル名（`docs/形式.md`）への言及を外した。残る日本語は、先頭のライセンスの行の仮の著作権者だけだった（2026-11-13 に `U5143` に決まり、今は芯のソースに日本語は無い）

### 分かったこと（他の担当・決めること）

- GIF は前は Linux と Windows でバイトが違った（`cli/encoders.c` のメディアンカットの `qsort` で、同じ値の並びが C の実行環境ごとに変わっていた）。読み込み・書き出しが #44 で直し、MinGW と wine で Linux と同じバイトになることを確かめた（2026-10-31）
- **著作権者の名前**：2026-11-13 に `U5143` に決まった（ASCII）。芯のヘッダーを自分の MSVC のプロジェクトに入れる人（Unity・Unreal のプラグイン）が `/utf-8` を付けていなくても、C4819 の警告は出ない（前の仮の表記「<著作権者>」は日本語で、出るおそれがあった）

## 11/4 にユーザーの PC で確かめる手順

PC の Claude Code にそのまま任せられる形です。上から順に行い、各行の「期待」と違ったら、出力をそのままハブに送ってください。

### 要る物

- Visual Studio 2022（Community で可）の「C++ によるデスクトップ開発」。CMake も一緒に入る
- Git、Node.js（コンパイラなどの JS の道具のため。芯だけなら要らない）

### 1. MSVC でビルドとテスト

MSVC のビルドと ctest は、CI（main への push の Windows のジョブ、`-DUGO_STRICT=ON` で警告をエラーに）で確かめ済みです（2026-11-01、MSVC 19.51・Visual Studio 2026 で警告 0）。PC では、下の「2. 同じ結果か」の SHA-256 の比べを主にしてください。1 は、PC の Visual Studio でも通るかを見たい時だけで大丈夫です。

「x64 Native Tools Command Prompt for VS 2022」を開き、リポジトリのフォルダで：

```bat
cmake -S . -B build-msvc -G "Visual Studio 17 2022" -A x64 -DUGO_SHARED=ON -DUGO_STRICT=ON
cmake --build build-msvc --config Release
ctest --test-dir build-msvc -C Release --output-on-failure
```

- 期待：ビルドは警告 0（`UGO_STRICT=ON` なので、芯に警告があれば止まる）。`100% tests passed`
- 止まったら：止まった行と警告の番号（C4xxx）を送る。`-DUGO_STRICT=OFF` にすれば、警告があってもビルドは続けられる
- `build-msvc\Release\` に `ugo.lib`・`ugo.dll`・`ugo_export.exe`・`ugo_test.exe` ができる

### 2. 同じ結果か（Linux と比べる）

```bat
build-msvc\Release\ugo_export.exe samples\basic\model.ug9 --out basic.rgba --frames 20
build-msvc\Release\ugo_export.exe tests\warp\model.ug9 --out warp.rgba --frames 20
build-msvc\Release\ugo_export.exe samples\basic\model.ug9 --anim idle --frames 20 --out basic.gif
build-msvc\Release\ugo_export.exe tests\warp\model.ug9 --frames 20 --out warp.gif
certutil -hashfile basic.rgba SHA256
certutil -hashfile warp.rgba SHA256
certutil -hashfile basic.gif SHA256
certutil -hashfile warp.gif SHA256
```

- 期待：Linux（GCC）と MinGW で作った物と同じ SHA-256。2026-10-31 の main（raw は bbe0d6f、GIF は 5b699ef）では次の値

| ファイル | SHA-256 |
|---|---|
| basic.rgba | `165442d0802de5415df3b49a0e315124f1245412d69ad67dfeb177a52c9521f2` |
| warp.rgba | `ed5591daa01244da00be9e76b99a0fb472e37c94d66e464318fdc2746b8223f3` |
| basic.gif | `c3407e38feed72c66807af7188b035aa95102b7af99fe5721889a039642242ee` |
| warp.gif | `27d6ee951272ab58235082749dc2fa32a8c1858e7438bffb8d4a3a19408d1f06` |

（Linux の GCC 13 と、MinGW で作って wine で動かした物は、この値で一致した）

- 違っても、ほとんどは浮動小数点の計算の順番の違い（MSVC の最適化）で、見た目は同じはず。違ったら、両方のファイルを残して知らせる（どのくらい違うかをこちらで測る）

### 3. 速さ

```bat
build-msvc\Release\ugo_test.exe samples\basic\model.ug9
```

- 「update ... ms/frame」の行を送る（Linux の手元では 200 体で 0.13 ms 前後）

### 4. MinGW でも（任意）

MSYS2 の UCRT64 の端末で：

```sh
cmake -S . -B build-mingw -G Ninja -DUGO_SHARED=ON -DUGO_STRICT=ON -DCMAKE_BUILD_TYPE=Release
cmake --build build-mingw && ctest --test-dir build-mingw
```

## ここでの確かめ方（Linux、また確かめる時）

```sh
apt-get install -y gcc-mingw-w64-x86-64 wine64
cat > /tmp/mingw.cmake <<'X'
set(CMAKE_SYSTEM_NAME Windows)
set(CMAKE_C_COMPILER x86_64-w64-mingw32-gcc)
set(CMAKE_RC_COMPILER x86_64-w64-mingw32-windres)
X
cmake -S . -B /tmp/bw -DCMAKE_TOOLCHAIN_FILE=/tmp/mingw.cmake -DUGO_SHARED=ON -DUGO_STRICT=ON -DCMAKE_BUILD_TYPE=Release
cmake --build /tmp/bw -j8
WINEDEBUG=-all wine /tmp/bw/ugo_test.exe samples/basic/model.ug9 --fuzz tests/pose/rig.ug9 --fuzz tests/warp/model.ug9
```
