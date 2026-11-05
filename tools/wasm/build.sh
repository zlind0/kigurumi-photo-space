#!/usr/bin/env bash
# Rebuild the 10-bit HDR AVIF encoder wasm.
#
# Requirements: emsdk (6.0.x), cmake, ninja, git.
# Usage: EMSDK=/path/to/emsdk ./tools/wasm/build.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
AOM_DIR="${AOM_DIR:-/tmp/libaom}"
EMSDK="${EMSDK:-/tmp/emsdk}"

if [[ ! -d "$AOM_DIR" ]]; then
  git clone --depth 1 https://github.com/arthenica/libaom "$AOM_DIR"
fi

# shellcheck disable=SC1091
source "$EMSDK/emsdk_env.sh" >/dev/null 2>&1

cd "$AOM_DIR"
if [[ ! -f build-wasm/libaom.a ]]; then
  emcmake cmake -S . -B build-wasm -G Ninja \
    -DCMAKE_BUILD_TYPE=Release \
    -DAOM_TARGET_CPU=generic \
    -DCONFIG_AV1_ENCODER=1 -DCONFIG_AV1_DECODER=0 \
    -DCONFIG_LOWBITDEPTH=0 -DCONFIG_AV1_HIGHBITDEPTH=1 \
    -DCONFIG_MULTITHREAD=0 -DCONFIG_RUNTIME_CPU_DETECT=0 \
    -DCONFIG_WEBM_IO=0 -DENABLE_TESTS=0 -DENABLE_EXAMPLES=0 \
    -DENABLE_TOOLS=0 -DENABLE_DOCS=0 -DCONFIG_PIC=1 \
    -DBUILD_SHARED_LIBS=0 -DCMAKE_C_FLAGS="-O3" -DCMAKE_CXX_FLAGS="-O3"
  cmake --build build-wasm --target aom -j "$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)"
fi

emcc "$ROOT/tools/wasm/avif_hdr_enc.c" build-wasm/libaom.a \
  -I . -I build-wasm -O3 \
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createAvifHdrEncoder \
  -sENVIRONMENT=web,worker,node \
  -sALLOW_MEMORY_GROWTH=1 -sMAXIMUM_MEMORY=2147483648 \
  -sFILESYSTEM=0 -sASSERTIONS=0 -sSTACK_SIZE=1048576 \
  -sEXPORTED_FUNCTIONS='["_kps_encode_av1_10bit","_kps_free","_malloc","_free"]' \
  -sEXPORTED_RUNTIME_METHODS='["HEAPU8","HEAPU16"]' \
  -o "$ROOT/src/client/wasm/avif_hdr_enc.js"

echo "built $ROOT/src/client/wasm/avif_hdr_enc.js"
