/**
 * Client-side Grad-CAM — readable smooth heatmap with light grain + pearl focus.
 */
(function (global) {
  'use strict';

  const GRADCAM = {
    ALPHA_FLOOR: 0.03,
    ALPHA_FADE_HI: 0.10,
    BLEND_ALPHA: 0.4,
    SMOOTH_LAYER_FACTOR: 0.88,
    CAM_BLUR_PX: 3,
    OVERLAY_BLUR_PX: 2,
    GRAIN_BLUR_PX: 0.5,
    SCATTER_STEP: 3,
    SCATTER_DENSITY: 0.72,
    SCATTER_FLOOR: 0.12,
    GRAIN_ALPHA_FACTOR: 0.24,
    DOT_RADIUS: 1.2,
    INTENSITY_JITTER: 0.05,
    PEARL_CAM_BASE: 0.32,
    PEARL_CAM_GAIN: 0.68,
    PEARL_BOOST: 0.18,
    PEARL_GAMMA: 0.48,
    TISSUE_SPREAD: 0.48,
    IMAGE_MIN_INTENSITY: 0.18,
    IMAGE_CAM_BLEND: 0.62,
    POSITIVE_THRESHOLD_PCT: 75,
    // Jet-like colormap (matches reference dashboard heatmap)
    ANCHORS: [
      [0.0, [0, 0, 130]],
      [0.11, [0, 60, 220]],
      [0.28, [0, 190, 210]],
      [0.45, [60, 210, 90]],
      [0.58, [230, 230, 40]],
      [0.72, [250, 140, 20]],
      [0.86, [220, 30, 30]],
      [1.0, [120, 0, 0]],
    ],
  };

  function smoothstep(edge0, edge1, x) {
    const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0 || 1e-6)));
    return t * t * (3 - 2 * t);
  }

  function lerpChannel(intensity, ch) {
    const i = Math.max(0, Math.min(1, intensity));
    const anchors = GRADCAM.ANCHORS;
    for (let k = 0; k < anchors.length - 1; k++) {
      const t0 = anchors[k][0];
      const t1 = anchors[k + 1][0];
      if (i >= t0 && i <= t1) {
        const c0 = anchors[k][1][ch];
        const c1 = anchors[k + 1][1][ch];
        const t = (i - t0) / (t1 - t0 || 1e-6);
        return c0 + t * (c1 - c0);
      }
    }
    return anchors[anchors.length - 1][1][ch];
  }

  function bandColor(intensity) {
    return [
      Math.round(lerpChannel(intensity, 0)),
      Math.round(lerpChannel(intensity, 1)),
      Math.round(lerpChannel(intensity, 2)),
    ];
  }

  function clamp01(v) {
    return Math.max(0, Math.min(1, v));
  }

  function normalizeActivationMatrix(matrix) {
    const rows = matrix.length;
    const cols = rows ? matrix[0].length : 0;
    let min = Infinity;
    let max = -Infinity;
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const v = Math.max(0, Number(matrix[y][x]) || 0);
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }
    const range = max - min;
    let normalized;
    if (range > 1e-10) {
      normalized = matrix.map((row) =>
        row.map((v) => (Math.max(0, Number(v) || 0) - min) / range)
      );
    } else {
      normalized = matrix.map((row) => row.map(() => 0));
    }

    let maxAfter = 0;
    for (let y = 0; y < normalized.length; y++) {
      for (let x = 0; x < normalized[y].length; x++) {
        if (normalized[y][x] > maxAfter) maxAfter = normalized[y][x];
      }
    }
    console.log('[Grad-CAM] Math.max(...activationMatrix) after min–max:', maxAfter);

    if (maxAfter > 1e-10 && maxAfter < 0.999) {
      console.warn('[Grad-CAM] Runtime auto-scale correction applied (max was', maxAfter, ')');
      normalized = normalized.map((row) => row.map((v) => v / maxAfter));
      maxAfter = 1;
      console.log('[Grad-CAM] Math.max(...activationMatrix) after auto-scale:', Math.max(...normalized.flat()));
    }

    return {
      matrix: normalized,
      stats: { min_before: min, max_before: max, range, max_after: maxAfter },
    };
  }

  function minMaxFloatBuffer(buf) {
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < buf.length; i++) {
      if (buf[i] < min) min = buf[i];
      if (buf[i] > max) max = buf[i];
    }
    if (max - min < 1e-10) {
      buf.fill(0);
      return buf;
    }
    for (let i = 0; i < buf.length; i++) {
      buf[i] = (buf[i] - min) / (max - min);
    }
    return buf;
  }

  function minMaxImageData(data) {
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < data.length; i += 4) {
      const v = data[i] / 255;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    if (max - min < 1e-10) return data;
    const out = new Uint8ClampedArray(data.length);
    for (let i = 0; i < data.length; i += 4) {
      const v = Math.round(((data[i] / 255 - min) / (max - min)) * 255);
      out[i] = out[i + 1] = out[i + 2] = v;
      out[i + 3] = 255;
    }
    return out;
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Failed to load ultrasound for Grad-CAM canvas'));
      img.src = src;
    });
  }

  function toGrayscaleBuffer(ctx, w, h) {
    const data = ctx.getImageData(0, 0, w, h).data;
    const gray = new Float32Array(w * h);
    for (let i = 0, p = 0; i < data.length; i += 4, p++) {
      gray[p] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    }
    return gray;
  }

  function toGrayscaleImageData(ctx, w, h) {
    const data = ctx.getImageData(0, 0, w, h);
    for (let i = 0; i < data.data.length; i += 4) {
      const g = 0.299 * data.data[i] + 0.587 * data.data[i + 1] + 0.114 * data.data[i + 2];
      data.data[i] = data.data[i + 1] = data.data[i + 2] = g;
    }
    return data;
  }

  function boxBlurGray(src, w, h, radius) {
    const out = new Float32Array(w * h);
    const diam = radius * 2 + 1;
    const area = diam * diam;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let sum = 0;
        for (let dy = -radius; dy <= radius; dy++) {
          const yy = Math.max(0, Math.min(h - 1, y + dy));
          for (let dx = -radius; dx <= radius; dx++) {
            const xx = Math.max(0, Math.min(w - 1, x + dx));
            sum += src[yy * w + xx];
          }
        }
        out[y * w + x] = sum / area;
      }
    }
    return out;
  }

  function dilateMax(src, w, h, radius) {
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let mx = 0;
        for (let dy = -radius; dy <= radius; dy++) {
          const yy = Math.max(0, Math.min(h - 1, y + dy));
          for (let dx = -radius; dx <= radius; dx++) {
            const xx = Math.max(0, Math.min(w - 1, x + dx));
            const v = src[yy * w + xx];
            if (v > mx) mx = v;
          }
        }
        out[y * w + x] = mx;
      }
    }
    return out;
  }

  function meanInRing(gray, w, h, cx, cy, innerR, outerR) {
    let sum = 0;
    let count = 0;
    const outerSq = outerR * outerR;
    const innerSq = innerR * innerR;
    for (let dy = -outerR; dy <= outerR; dy++) {
      const yy = cy + dy;
      if (yy < 0 || yy >= h) continue;
      for (let dx = -outerR; dx <= outerR; dx++) {
        const xx = cx + dx;
        if (xx < 0 || xx >= w) continue;
        const d2 = dx * dx + dy * dy;
        if (d2 > outerSq || d2 < innerSq) continue;
        sum += gray[yy * w + xx];
        count++;
      }
    }
    return count ? sum / count : 0;
  }

  function floodBackgroundMask(gray, w, h, threshold) {
    const bg = new Uint8Array(w * h);
    const queue = [];

    function seed(x, y) {
      const i = y * w + x;
      if (bg[i] || gray[i] >= threshold) return;
      bg[i] = 1;
      queue.push(i);
    }

    for (let x = 0; x < w; x++) {
      seed(x, 0);
      seed(x, h - 1);
    }
    for (let y = 0; y < h; y++) {
      seed(0, y);
      seed(w - 1, y);
    }

    while (queue.length) {
      const i = queue.pop();
      const x = i % w;
      const y = (i / w) | 0;
      const neighbors = [
        [x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1],
      ];
      for (let n = 0; n < neighbors.length; n++) {
        const nx = neighbors[n][0];
        const ny = neighbors[n][1];
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const ni = ny * w + nx;
        if (bg[ni] || gray[ni] >= threshold + 8) continue;
        bg[ni] = 1;
        queue.push(ni);
      }
    }
    return bg;
  }

  function darkFractionInDisk(gray, w, h, cx, cy, radius, darkCutoff) {
    let dark = 0;
    let total = 0;
    const r2 = radius * radius;
    for (let dy = -radius; dy <= radius; dy++) {
      const yy = cy + dy;
      if (yy < 0 || yy >= h) continue;
      for (let dx = -radius; dx <= radius; dx++) {
        const xx = cx + dx;
        if (xx < 0 || xx >= w) continue;
        if (dx * dx + dy * dy > r2) continue;
        total++;
        if (gray[yy * w + xx] < darkCutoff) dark++;
      }
    }
    return total ? dark / total : 0;
  }

  /**
   * Detect peripheral follicle lumens ("string of pearls") — dark circles with bright halos.
   */
  function buildPearlFollicleMap(gray, w, h) {
    const pearl = new Float32Array(w * h);
    const bgMask = floodBackgroundMask(gray, w, h, 24);
    const localMean = boxBlurGray(gray, w, h, 7);

    let sumX = 0;
    let sumY = 0;
    let tissueCount = 0;

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const g = gray[i];
        if (bgMask[i] || g >= 228) continue;
        if (g > 12) {
          sumX += x;
          sumY += y;
          tissueCount++;
        }
      }
    }

    if (tissueCount < 1) return pearl;

    const cx = sumX / tissueCount;
    const cy = sumY / tissueCount;

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const g = gray[i];
        if (bgMask[i] || g >= 228) continue;

        const lm = localMean[i];
        const halo = meanInRing(gray, w, h, x, y, 3, 11);
        const haloContrast = Math.max(0, (halo - g) / 42);

        // Follicle lumen: darker than local tissue and surrounded by brighter stroma.
        const lumenDark = g < lm * 0.9 ? Math.max(0, (lm - g) / 50) : 0;
        const isPearlCandidate = g < 95 && haloContrast > 0.12 && lumenDark > 0.08;

        if (!isPearlCandidate) continue;

        // Suppress large uniform voids (cyst/background pockets), keep small pearls.
        const voidFill = darkFractionInDisk(gray, w, h, x, y, 20, 38);
        const pearlScale = voidFill > 0.72 ? 0.12 : 1.0 - Math.max(0, voidFill - 0.45) * 0.9;

        const dx = (x - cx) / Math.max(w, 1);
        const dy = (y - cy) / Math.max(h, 1);
        const dist = Math.sqrt(dx * dx + dy * dy);
        const peripheral = Math.min(1, Math.pow(dist * 2.6, 0.85));

        const follicleCore = Math.min(1, haloContrast * 1.15) * Math.min(1, lumenDark * 1.2);
        pearl[i] = follicleCore * pearlScale * (0.2 + 0.8 * peripheral);
      }
    }

    const filled = dilateMax(pearl, w, h, 6);
    return minMaxFloatBuffer(filled);
  }

  function buildTissueMask(gray, w, h) {
    const bgMask = floodBackgroundMask(gray, w, h, 24);
    const tissue = new Float32Array(w * h);
    for (let i = 0; i < gray.length; i++) {
      const g = gray[i];
      tissue[i] = !bgMask[i] && g > 12 && g < 228 ? 1 : 0;
    }
    return tissue;
  }

  function modulateCamWithPearls(camBuf, pearlMap, tissueMask, w, h) {
    const out = new Float32Array(w * h);
    for (let i = 0; i < camBuf.length; i++) {
      const cam = camBuf[i];
      const pearl = pearlMap[i] || 0;
      const tissue = tissueMask[i] || 0;
      const pearlWeight = Math.pow(pearl, GRADCAM.PEARL_GAMMA);
      const gate = GRADCAM.PEARL_CAM_BASE + GRADCAM.PEARL_CAM_GAIN * pearlWeight;
      const pearlBoost = cam * pearlWeight * GRADCAM.PEARL_BOOST;
      const tissueWash = cam * tissue * GRADCAM.TISSUE_SPREAD;
      out[i] = Math.max(cam * gate + pearlBoost, tissueWash);
    }
    return minMaxFloatBuffer(out);
  }

  function applyPositiveScoreLift(buf, cnnScorePct) {
    const score = Number(cnnScorePct);
    if (!Number.isFinite(score) || score < GRADCAM.POSITIVE_THRESHOLD_PCT) {
      return buf;
    }
    const t = Math.min(1, (score - GRADCAM.POSITIVE_THRESHOLD_PCT) / 25);
    const gamma = 0.88 - t * 0.14;
    const lift = 0.06 + t * 0.14;
    for (let i = 0; i < buf.length; i++) {
      const v = buf[i];
      if (v <= 0) continue;
      buf[i] = clamp01(Math.pow(v, gamma) + lift * (1 - v * 0.45));
    }
    return minMaxFloatBuffer(buf);
  }

  function mapDisplayIntensity(intensity, cnnScorePct) {
    let i = intensity;
    const score = Number(cnnScorePct);
    if (Number.isFinite(score) && score >= GRADCAM.POSITIVE_THRESHOLD_PCT) {
      const t = Math.min(1, (score - GRADCAM.POSITIVE_THRESHOLD_PCT) / 25);
      i = clamp01(Math.pow(i, 0.9 - t * 0.1) + t * 0.04);
    }
    return i;
  }

  function applyFullImageCoverage(buf, camBuf, cnnScorePct) {
    let floor = GRADCAM.IMAGE_MIN_INTENSITY;
    const score = Number(cnnScorePct);
    if (Number.isFinite(score) && score >= GRADCAM.POSITIVE_THRESHOLD_PCT) {
      floor += Math.min(0.1, ((score - GRADCAM.POSITIVE_THRESHOLD_PCT) / 25) * 0.1);
    }
    const blend = GRADCAM.IMAGE_CAM_BLEND;
    for (let i = 0; i < buf.length; i++) {
      const spread = camBuf[i] * blend + floor;
      buf[i] = clamp01(Math.max(buf[i], spread));
    }
    return minMaxFloatBuffer(buf);
  }

  function activationAlpha(intensity) {
    const i = Math.max(intensity, GRADCAM.IMAGE_MIN_INTENSITY * 0.75);
    return smoothstep(GRADCAM.ALPHA_FLOOR, GRADCAM.ALPHA_FADE_HI, i) * GRADCAM.BLEND_ALPHA;
  }

  function renderSmoothLayer(oData, intensityBuf, w, h, cnnScorePct) {
    for (let p = 0; p < intensityBuf.length; p++) {
      const idx = p * 4;
      const intensity = Math.max(intensityBuf[p], GRADCAM.IMAGE_MIN_INTENSITY * 0.9);
      const rgb = bandColor(mapDisplayIntensity(intensity, cnnScorePct));
      const alpha = activationAlpha(intensity) * GRADCAM.SMOOTH_LAYER_FACTOR;
      oData.data[idx] = rgb[0];
      oData.data[idx + 1] = rgb[1];
      oData.data[idx + 2] = rgb[2];
      oData.data[idx + 3] = Math.round(alpha * 255);
    }
  }

  function drawLightGrain(ctx, intensityBuf, w, h, cnnScorePct) {
    const step = GRADCAM.SCATTER_STEP;
    const jitter = GRADCAM.INTENSITY_JITTER;
    ctx.imageSmoothingEnabled = false;
    ctx.filter = 'none';

    for (let y = 0; y < h; y += step) {
      for (let x = 0; x < w; x += step) {
        const p = y * w + x;
        const intensity = Math.max(intensityBuf[p], GRADCAM.IMAGE_MIN_INTENSITY * 0.9);
        const prob = Math.min(1, intensity * GRADCAM.SCATTER_DENSITY + GRADCAM.SCATTER_FLOOR);
        if (Math.random() > prob) continue;

        const displayI = clamp01(mapDisplayIntensity(intensity, cnnScorePct) + (Math.random() - 0.5) * jitter);
        const rgb = bandColor(displayI);
        const alpha = activationAlpha(intensity) * GRADCAM.GRAIN_ALPHA_FACTOR;
        const jx = (Math.random() - 0.5) * step * 0.7;
        const jy = (Math.random() - 0.5) * step * 0.7;

        ctx.beginPath();
        ctx.arc(x + 0.5 + jx, y + 0.5 + jy, GRADCAM.DOT_RADIUS, 0, 2 * Math.PI);
        ctx.fillStyle = 'rgba(' + rgb.join(',') + ',' + alpha + ')';
        ctx.fill();
      }
    }
  }

  async function renderGradcamCanvasOverlay(activationMatrix, ultrasoundSrc, options) {
    if (!activationMatrix || !activationMatrix.length) {
      throw new Error('Missing gradcam_activation_matrix');
    }

    const cnnScorePct = options && options.cnnScorePct != null
      ? Number(options.cnnScorePct)
      : NaN;

    const norm = normalizeActivationMatrix(activationMatrix);
    const matrix = norm.matrix;
    const rows = matrix.length;
    const cols = matrix[0].length;

    const baseImg = await loadImage(ultrasoundSrc);
    const w = baseImg.naturalWidth || baseImg.width;
    const h = baseImg.naturalHeight || baseImg.height;

    const baseCanvas = document.createElement('canvas');
    baseCanvas.width = w;
    baseCanvas.height = h;
    const baseCtx = baseCanvas.getContext('2d');
    baseCtx.drawImage(baseImg, 0, 0, w, h);
    const gray = toGrayscaleBuffer(baseCtx, w, h);
    const pearlMap = buildPearlFollicleMap(gray, w, h);
    const tissueMask = buildTissueMask(gray, w, h);

    const tiny = document.createElement('canvas');
    tiny.width = cols;
    tiny.height = rows;
    const tCtx = tiny.getContext('2d');
    const tData = tCtx.createImageData(cols, rows);
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const v = Math.round(Math.max(0, Math.min(1, matrix[y][x])) * 255);
        const idx = (y * cols + x) * 4;
        tData.data[idx] = v;
        tData.data[idx + 1] = v;
        tData.data[idx + 2] = v;
        tData.data[idx + 3] = 255;
      }
    }
    tCtx.putImageData(tData, 0, 0);

    const intensityCanvas = document.createElement('canvas');
    intensityCanvas.width = w;
    intensityCanvas.height = h;
    const iCtx = intensityCanvas.getContext('2d');
    iCtx.imageSmoothingEnabled = true;
    iCtx.imageSmoothingQuality = 'high';
    iCtx.drawImage(tiny, 0, 0, w, h);

    let intensityData = iCtx.getImageData(0, 0, w, h);
    intensityData.data.set(minMaxImageData(intensityData.data));

    if (GRADCAM.CAM_BLUR_PX > 0) {
      const blurCanvas = document.createElement('canvas');
      blurCanvas.width = w;
      blurCanvas.height = h;
      const bCtx = blurCanvas.getContext('2d');
      bCtx.putImageData(intensityData, 0, 0);
      bCtx.filter = 'blur(' + GRADCAM.CAM_BLUR_PX + 'px)';
      bCtx.drawImage(blurCanvas, 0, 0);
      bCtx.filter = 'none';
      intensityData = bCtx.getImageData(0, 0, w, h);
      intensityData.data.set(minMaxImageData(intensityData.data));
    }

    const camBuf = new Float32Array(w * h);
    for (let i = 0, p = 0; i < intensityData.data.length; i += 4, p++) {
      camBuf[p] = intensityData.data[i] / 255;
    }

    let focusedBuf = modulateCamWithPearls(camBuf, pearlMap, tissueMask, w, h);
    focusedBuf = applyPositiveScoreLift(focusedBuf, cnnScorePct);
    focusedBuf = applyFullImageCoverage(focusedBuf, camBuf, cnnScorePct);
    console.log('[Grad-CAM] Full-frame coverage applied', {
      cnnScorePct: Number.isFinite(cnnScorePct) ? cnnScorePct : null,
    });

    const overlayCanvas = document.createElement('canvas');
    overlayCanvas.width = w;
    overlayCanvas.height = h;
    const oCtx = overlayCanvas.getContext('2d');
    const oData = oCtx.createImageData(w, h);

    renderSmoothLayer(oData, focusedBuf, w, h, cnnScorePct);
    oCtx.putImageData(oData, 0, 0);

    const smoothBlurCanvas = document.createElement('canvas');
    smoothBlurCanvas.width = w;
    smoothBlurCanvas.height = h;
    const sbCtx = smoothBlurCanvas.getContext('2d');
    sbCtx.filter = 'blur(' + GRADCAM.OVERLAY_BLUR_PX + 'px)';
    sbCtx.drawImage(overlayCanvas, 0, 0);
    sbCtx.filter = 'none';

    const grainCanvas = document.createElement('canvas');
    grainCanvas.width = w;
    grainCanvas.height = h;
    const gCtx = grainCanvas.getContext('2d');
    gCtx.drawImage(smoothBlurCanvas, 0, 0);
    drawLightGrain(gCtx, focusedBuf, w, h, cnnScorePct);

    const finalOverlay = document.createElement('canvas');
    finalOverlay.width = w;
    finalOverlay.height = h;
    const foCtx = finalOverlay.getContext('2d');
    if (GRADCAM.GRAIN_BLUR_PX > 0) {
      foCtx.filter = 'blur(' + GRADCAM.GRAIN_BLUR_PX + 'px)';
    }
    foCtx.drawImage(grainCanvas, 0, 0);
    foCtx.filter = 'none';

    const out = document.createElement('canvas');
    out.width = w;
    out.height = h;
    const fCtx = out.getContext('2d');
    fCtx.drawImage(baseImg, 0, 0, w, h);
    fCtx.putImageData(toGrayscaleImageData(fCtx, w, h), 0, 0);
    fCtx.drawImage(finalOverlay, 0, 0);

    return out;
  }

  global.PcodeGradcamCanvas = {
    GRADCAM,
    normalizeActivationMatrix,
    buildPearlFollicleMap,
    renderGradcamCanvasOverlay,
  };
})(typeof window !== 'undefined' ? window : globalThis);
