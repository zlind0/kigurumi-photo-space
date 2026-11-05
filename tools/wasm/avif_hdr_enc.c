/*
 * Minimal 10-bit AV1 still-image encoder wrapper around libaom.
 *
 * Input:  RGBA, 16-bit per channel, values already in the target transfer
 *         function (PQ or HLG) and BT.2020 primaries, 10-bit code range
 *         (0..1023). Alpha is ignored.
 * Output: raw AV1 OBUs (temporal delimiter + sequence header + frame).
 *
 * The JavaScript side wraps these OBUs in an AVIF (ISOBMFF) container.
 */
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <stdio.h>

#include <aom/aom_encoder.h>
#include <aom/aomcx.h>

int kps_debug_stage = 0;
int kps_debug_packets = 0;
int kps_debug_kind = 0;

static int clamp10(int v) {
  if (v < 0) return 0;
  if (v > 1023) return 1023;
  return v;
}

static void rgb_to_yuv10(int r, int g, int b, int matrix, int *y, int *u,
                         int *v) {
  /* Non-constant luminance, full range, 10-bit. */
  double kr = 0.2627, kg = 0.6780, kb = 0.0593;
  double cb_div = 1.8814, cr_div = 1.4746;
  if (matrix == 1) { /* BT.709 */
    kr = 0.2126;
    kg = 0.7152;
    kb = 0.0722;
    cb_div = 1.8556;
    cr_div = 1.5748;
  }
  const double yf = kr * r + kg * g + kb * b;
  const double cb = (b - yf) / cb_div + 512.0;
  const double cr = (r - yf) / cr_div + 512.0;
  *y = clamp10((int)(yf + 0.5));
  *u = clamp10((int)(cb + 0.5));
  *v = clamp10((int)(cr + 0.5));
}

static int drain_packets(aom_codec_ctx_t *codec, uint8_t **buf, size_t *cap,
                         size_t *len) {
  const aom_codec_cx_pkt_t *pkt;
  aom_codec_iter_t iter = NULL;
  while ((pkt = aom_codec_get_cx_data(codec, &iter)) != NULL) {
    kps_debug_packets++;
    kps_debug_kind = (int)pkt->kind;
    if (pkt->kind != AOM_CODEC_CX_FRAME_PKT) continue;
    const size_t sz = pkt->data.frame.sz;
    if (*len + sz > *cap) {
      size_t next = *cap ? *cap : 65536;
      while (next < *len + sz) next *= 2;
      uint8_t *grown = (uint8_t *)realloc(*buf, next);
      if (!grown) return -1;
      *buf = grown;
      *cap = next;
    }
    memcpy(*buf + *len, pkt->data.frame.buf, sz);
    *len += sz;
  }
  return 0;
}

int kps_encode_av1_10bit(const uint16_t *rgba, int width, int height,
                         int quality, int speed, int primaries, int transfer,
                         int matrix, uint8_t **out_data, size_t *out_size) {
  if (!rgba || width <= 0 || height <= 0 || !out_data || !out_size) return -1;
  if (width > 16384 || height > 16384) return -2;
  if (quality < 0) quality = 0;
  if (quality > 100) quality = 100;
  if (speed < 0) speed = 0;
  if (speed > 9) speed = 9;

  aom_codec_iface_t *iface = aom_codec_av1_cx();
  aom_codec_enc_cfg_t cfg;
  if (aom_codec_enc_config_default(iface, &cfg, AOM_USAGE_REALTIME) !=
      AOM_CODEC_OK) {
    return -3;
  }

  const int q = (int)(((100 - quality) * 63 + 50) / 100);
  cfg.g_w = (unsigned int)width;
  cfg.g_h = (unsigned int)height;
  cfg.g_profile = 0; /* 4:2:0, 10-bit */
  cfg.g_bit_depth = AOM_BITS_10;
  cfg.g_input_bit_depth = 10;
  cfg.g_timebase.num = 1;
  cfg.g_timebase.den = 1;
  cfg.g_limit = 1;
  cfg.g_lag_in_frames = 0;
  cfg.g_pass = AOM_RC_ONE_PASS;
  cfg.g_threads = 1;
  cfg.rc_end_usage = AOM_Q;
  cfg.rc_min_quantizer = (unsigned int)q;
  cfg.rc_max_quantizer = (unsigned int)q;
  cfg.rc_undershoot_pct = 0;
  cfg.rc_overshoot_pct = 0;
  cfg.monochrome = 0;
  cfg.g_error_resilient = 0;
  cfg.g_input_bit_depth = 10;

  aom_codec_ctx_t codec;
  kps_debug_stage = 1;
  if (aom_codec_enc_init(&codec, iface, &cfg, AOM_CODEC_USE_HIGHBITDEPTH) !=
      AOM_CODEC_OK) {
    return -4;
  }
  kps_debug_stage = 2;

  aom_codec_control(&codec, AOME_SET_CPUUSED, speed);
  aom_codec_control(&codec, AV1E_SET_ROW_MT, 0);
  aom_codec_control(&codec, AV1E_SET_TILE_COLUMNS, 0);
  aom_codec_control(&codec, AV1E_SET_TILE_ROWS, 0);
  aom_codec_control(&codec, AV1E_SET_ENABLE_CDEF, 1);
  aom_codec_control(&codec, AV1E_SET_ENABLE_RESTORATION, 1);
  aom_codec_control(&codec, AV1E_SET_AQ_MODE, 1);
  aom_codec_control(&codec, AV1E_SET_DELTAQ_MODE, 0);
  aom_codec_control(&codec, AV1E_SET_ENABLE_TPL_MODEL, 0);
  aom_codec_control(&codec, AV1E_SET_LOSSLESS, 0);
  aom_codec_control(&codec, AV1E_SET_COLOR_PRIMARIES, primaries);
  aom_codec_control(&codec, AV1E_SET_TRANSFER_CHARACTERISTICS, transfer);
  aom_codec_control(&codec, AV1E_SET_MATRIX_COEFFICIENTS, matrix);
  aom_codec_control(&codec, AV1E_SET_CHROMA_SAMPLE_POSITION, AOM_CSP_UNKNOWN);
  aom_codec_control(&codec, AV1E_SET_COLOR_RANGE, AOM_CR_FULL_RANGE);

  kps_debug_stage = 3;
  aom_image_t img;
  if (!aom_img_alloc(&img, AOM_IMG_FMT_I42016, (unsigned int)width,
                     (unsigned int)height, 1)) {
    aom_codec_destroy(&codec);
    return -5;
  }
  img.bit_depth = 10;
  img.range = AOM_CR_FULL_RANGE;
  img.cp = (aom_color_primaries_t)primaries;
  img.tc = (aom_transfer_characteristics_t)transfer;
  img.mc = (aom_matrix_coefficients_t)matrix;

  uint16_t *yp = (uint16_t *)img.planes[AOM_PLANE_Y];
  uint16_t *up = (uint16_t *)img.planes[AOM_PLANE_U];
  uint16_t *vp = (uint16_t *)img.planes[AOM_PLANE_V];
  const int ys = img.stride[AOM_PLANE_Y] / 2;
  const int us = img.stride[AOM_PLANE_U] / 2;
  const int vs = img.stride[AOM_PLANE_V] / 2;

  for (int y = 0; y < height; y++) {
    for (int x = 0; x < width; x++) {
      const uint16_t *p = rgba + ((size_t)y * (size_t)width + (size_t)x) * 4;
      int yy, uu, vv;
      rgb_to_yuv10(p[0], p[1], p[2], matrix, &yy, &uu, &vv);
      yp[(size_t)y * (size_t)ys + (size_t)x] = (uint16_t)yy;
    }
  }

  const int cw = (width + 1) / 2;
  const int ch = (height + 1) / 2;
  for (int y = 0; y < ch; y++) {
    for (int x = 0; x < cw; x++) {
      int r = 0, g = 0, b = 0, n = 0;
      for (int dy = 0; dy < 2; dy++) {
        const int sy = y * 2 + dy;
        if (sy >= height) continue;
        for (int dx = 0; dx < 2; dx++) {
          const int sx = x * 2 + dx;
          if (sx >= width) continue;
          const uint16_t *p =
              rgba + ((size_t)sy * (size_t)width + (size_t)sx) * 4;
          r += p[0];
          g += p[1];
          b += p[2];
          n++;
        }
      }
      if (n == 0) n = 1;
      int yy, uu, vv;
      rgb_to_yuv10((r + n / 2) / n, (g + n / 2) / n, (b + n / 2) / n, matrix,
                   &yy, &uu, &vv);
      up[(size_t)y * (size_t)us + (size_t)x] = (uint16_t)uu;
      vp[(size_t)y * (size_t)vs + (size_t)x] = (uint16_t)vv;
    }
  }

  kps_debug_stage = 4;
  uint8_t *buf = NULL;
  size_t cap = 0;
  size_t len = 0;

  aom_codec_err_t err = aom_codec_encode(&codec, &img, 0, 1, AOM_EFLAG_FORCE_KF);
  if (err != AOM_CODEC_OK) {
    aom_img_free(&img);
    aom_codec_destroy(&codec);
    return -6;
  }
  if (drain_packets(&codec, &buf, &cap, &len) != 0) {
    free(buf);
    aom_img_free(&img);
    aom_codec_destroy(&codec);
    return -8;
  }

  kps_debug_stage = 5;
  err = aom_codec_encode(&codec, NULL, -1, 0, 0);
  if (err != AOM_CODEC_OK) {
    free(buf);
    aom_img_free(&img);
    aom_codec_destroy(&codec);
    return -7;
  }
  if (drain_packets(&codec, &buf, &cap, &len) != 0) {
    free(buf);
    aom_img_free(&img);
    aom_codec_destroy(&codec);
    return -8;
  }

  aom_img_free(&img);
  aom_codec_destroy(&codec);

  kps_debug_stage = 7;
  if (len == 0) {
    free(buf);
    return -9;
  }
  *out_data = buf;
  *out_size = len;
  return 0;
}

void kps_free(void *p) { free(p); }

int kps_get_debug_stage(void) { return kps_debug_stage; }
int kps_get_debug_packets(void) { return kps_debug_packets; }
int kps_get_debug_kind(void) { return kps_debug_kind; }
