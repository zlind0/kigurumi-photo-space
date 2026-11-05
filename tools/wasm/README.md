# 10-bit HDR AVIF encoder (libaom wasm)

`src/client/wasm/avif_hdr_enc.js` + `.wasm` 是本目录 `avif_hdr_enc.c` 链接 libaom 10-bit 静态库后，用 Emscripten 编译的产物。

## 为什么需要它

浏览器原生 WebCodecs 的 AV1 编码器目前只支持 8-bit（Chrome 会返回 `Only 8-bit depth is supported for AV1 encoding`）。`@phenomen/libavif-wasm` 也只提供 8-bit 编码。为了把 10-bit HDR HEIC 转成 10-bit HDR AVIF，需要自己编译一个 10-bit libaom wasm。

## 输入/输出

C 导出：

```c
int kps_encode_av1_10bit(
  const uint16_t *rgba,   // RGBA, 10-bit code values (0..1023), BT.2020/PQ or HLG
  int width, int height,
  int quality,            // 0..100
  int speed,              // 0..9
  int primaries,          // CICP, 9 = BT.2020
  int transfer,           // CICP, 16 = PQ, 18 = HLG, 1 = BT.709
  int matrix,             // CICP, 9 = BT.2020 NCL, 1 = BT.709
  uint8_t **out_data,     // raw AV1 OBUs (temporal delimiter + sequence header + frame)
  size_t *out_size
);
void kps_free(void *p);
```

JS 侧（`src/client/upload/encode.ts`）解析 OBU，把 sequence header 放进 `av1C`，把完整 OBU 流放进 `mdat`，再用 `src/shared/avif/write.ts` 的 `buildAvif()` 写 AVIF 容器（含 `colr` nclx、`pixi`、`ispe`、可选 Exif item）。

## 构建

依赖：Emscripten（emsdk 6.0.x）、CMake、Ninja、Git。

```bash
# 1. libaom（3.2.0 可用；更新的版本也可以，API 基本兼容）
git clone --depth 1 https://github.com/arthenica/libaom /tmp/libaom
cd /tmp/libaom

# 2. 用 emscripten 配置 10-bit、仅编码器、单线程
source /path/to/emsdk/emsdk_env.sh
emcmake cmake -S . -B build-wasm -G Ninja \
  -DCMAKE_BUILD_TYPE=Release \
  -DAOM_TARGET_CPU=generic \
  -DCONFIG_AV1_ENCODER=1 -DCONFIG_AV1_DECODER=0 \
  -DCONFIG_LOWBITDEPTH=0 -DCONFIG_AV1_HIGHBITDEPTH=1 \
  -DCONFIG_MULTITHREAD=0 -DCONFIG_RUNTIME_CPU_DETECT=0 \
  -DCONFIG_WEBM_IO=0 -DENABLE_TESTS=0 -DENABLE_EXAMPLES=0 \
  -DENABLE_TOOLS=0 -DENABLE_DOCS=0 -DCONFIG_PIC=1 \
  -DBUILD_SHARED_LIBS=0 -DCMAKE_C_FLAGS="-O3" -DCMAKE_CXX_FLAGS="-O3"
cmake --build build-wasm --target aom -j 10

# 3. 编译 wrapper
emcc /path/to/kig-photo-space/tools/wasm/avif_hdr_enc.c build-wasm/libaom.a \
  -I . -I build-wasm -O3 \
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createAvifHdrEncoder \
  -sENVIRONMENT=web,worker,node \
  -sALLOW_MEMORY_GROWTH=1 -sMAXIMUM_MEMORY=2147483648 \
  -sFILESYSTEM=0 -sASSERTIONS=0 -sSTACK_SIZE=1048576 \
  -sEXPORTED_FUNCTIONS='["_kps_encode_av1_10bit","_kps_free","_malloc","_free"]' \
  -sEXPORTED_RUNTIME_METHODS='["HEAPU8","HEAPU16"]' \
  -o /path/to/kig-photo-space/src/client/wasm/avif_hdr_enc.js
```

产物约 3.2MB wasm（gzip 后约 1MB），只在检测到 10-bit 源时按需加载。

## 许可

- libaom：BSD 2-Clause + Alliance for Open Media Patent License 1.0。
- Emscripten 运行时：MIT。
- 本目录的 wrapper：与项目一致。

分发 wasm 时请保留 libaom 的 LICENSE/PATENTS 文本。上游 libaom 仓库包含这些文件。
