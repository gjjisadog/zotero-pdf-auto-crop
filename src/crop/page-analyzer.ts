/**
 * 像素级白边检测（page-analyzer）。
 *
 * 输入：渲染后的页面位图（画布坐标：y 向下、左上原点）；
 * 输出：显示坐标（y 向上、左下原点）的内容包围盒。
 *
 * 设计要点（任务 §36）：
 * - 不要求纯白背景：先估计页面背景色（边缘带中位数），再按灰度差阈值判定内容，
 *   兼容纸黄/浅灰的扫描件；
 * - 抗噪点：水平/垂直两遍「连续 run」过滤，孤立 1–2 px 噪点不计入；
 * - 宁多留白：任何误判方向都是「内容区域更大 → 裁剪更少」，绝不会切掉正文。
 */

export interface RenderedPage {
  /** 位图宽度（px） */
  width: number;
  /** 位图高度（px） */
  height: number;
  /** RGBA 像素，长度 = width*height*4 */
  data: Uint8ClampedArray | Uint8Array;
}

export interface PixelAnalyzeOptions {
  /** 灰度差阈值（0-255），默认 14 */
  grayThreshold?: number;
  /** 内容 run 的最小连续像素数（水平/垂直），默认 2 */
  minRun?: number;
  /** 行/列内容像素的最小数量，默认 3 */
  minCount?: number;
  /** 空白页判定：内容像素占比低于该值视为空白，默认 5e-4 */
  blankFraction?: number;
  /** 背景估计使用的边缘带宽度比例，默认 0.03 */
  edgeBandFraction?: number;
}

export interface PixelAnalyzeResult {
  /** 显示坐标内容盒（左下原点）；空白页为 null */
  contentBox: { left: number; bottom: number; right: number; top: number } | null;
  /** 背景灰度估计值 */
  backgroundGray: number;
  /** 内容像素占比 */
  contentFraction: number;
}

const DEFAULT_OPTS: Required<PixelAnalyzeOptions> = {
  grayThreshold: 14,
  minRun: 2,
  minCount: 3,
  blankFraction: 5e-4,
  edgeBandFraction: 0.03,
};

export function analyzePagePixels(page: RenderedPage, options: PixelAnalyzeOptions = {}): PixelAnalyzeResult {
  const opts = { ...DEFAULT_OPTS, ...options };
  const { width: w, height: h, data } = page;
  if (w <= 0 || h <= 0 || data.length < w * h * 4) {
    throw new Error(`Invalid rendered page dimensions ${w}x${h}`);
  }

  // 1. 灰度化
  const gray = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < w * h; i++, p += 4) {
    // 半透明像素按白色处理（抗边缘抗锯齿）
    const a = data[p + 3];
    if (a < 128) {
      gray[i] = 255;
      continue;
    }
    gray[i] = Math.round(0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2]);
  }

  // 2. 背景估计：四周边缘带的中位数灰度
  const bandW = Math.max(1, Math.round(w * opts.edgeBandFraction));
  const bandH = Math.max(1, Math.round(h * opts.edgeBandFraction));
  const edgeSamples: number[] = [];
  const edgeCollect = (x: number, y: number) => edgeSamples.push(gray[y * w + x]);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < bandW; x++) edgeCollect(x, y);
    for (let x = w - bandW; x < w; x++) edgeCollect(x, y);
  }
  for (let y = 0; y < bandH; y++) {
    for (let x = bandW; x < w - bandW; x++) edgeCollect(x, y);
  }
  for (let y = h - bandH; y < h; y++) {
    for (let x = bandW; x < w - bandW; x++) edgeCollect(x, y);
  }
  edgeSamples.sort((a, b) => a - b);
  const backgroundGray = edgeSamples[Math.floor(edgeSamples.length / 2)];

  // 3. 内容标记：|gray - bg| > threshold
  const isContent = new Uint8Array(w * h);
  let contentCount = 0;
  const thresh = opts.grayThreshold;
  for (let i = 0; i < w * h; i++) {
    const diff = gray[i] - backgroundGray;
    if (diff > thresh || diff < -thresh) {
      isContent[i] = 1;
      contentCount++;
    }
  }

  const contentFraction = contentCount / (w * h);
  if (contentFraction < opts.blankFraction) {
    return { contentBox: null, backgroundGray, contentFraction };
  }

  // 4. 水平 run 过滤：每行取「连续内容段 ≥ minRun 且该行内容数 ≥ minCount」的行的 x 范围
  let minX = w;
  let maxX = -1;
  const rowHasContent = new Uint8Array(h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let run = 0;
    let count = 0;
    let rowMin = w;
    let rowMax = -1;
    for (let x = 0; x <= w; x++) {
      if (x < w && isContent[row + x]) {
        run++;
        count++;
      } else {
        if (run >= opts.minRun) {
          // 该段起点 = x - run
          if (x - run < rowMin) rowMin = x - run;
          if (x - 1 > rowMax) rowMax = x - 1;
        }
        run = 0;
      }
    }
    if (count >= opts.minCount && rowMin <= rowMax) {
      rowHasContent[y] = 1;
      if (rowMin < minX) minX = rowMin;
      if (rowMax > maxX) maxX = rowMax;
    }
  }
  if (maxX < 0) {
    return { contentBox: null, backgroundGray, contentFraction };
  }

  // 5. 垂直 run 过滤：每列取「连续内容段 ≥ minRun 且该列内容数 ≥ minCount」的列的 y 范围
  let minY = h;
  let maxY = -1;
  const colHasContent = new Uint8Array(w);
  for (let x = 0; x < w; x++) {
    let run = 0;
    let count = 0;
    let colMin = h;
    let colMax = -1;
    for (let y = 0; y <= h; y++) {
      if (y < h && isContent[y * w + x]) {
        run++;
        count++;
      } else {
        if (run >= opts.minRun) {
          if (y - run < colMin) colMin = y - run;
          if (y - 1 > colMax) colMax = y - 1;
        }
        run = 0;
      }
    }
    if (count >= opts.minCount && colMin <= colMax) {
      colHasContent[x] = 1;
      if (colMin < minY) minY = colMin;
      if (colMax > maxY) maxY = colMax;
    }
  }
  if (maxY < 0) {
    return { contentBox: null, backgroundGray, contentFraction };
  }

  // 6. 画布坐标（y 向下）→ 显示坐标（y 向上，左下原点）
  return {
    contentBox: {
      left: minX,
      bottom: h - 1 - maxY,
      right: maxX,
      top: h - 1 - minY,
    },
    backgroundGray,
    contentFraction,
  };
}

/** 显示坐标 bbox（像素）→ 未旋转 PDF 坐标 bbox（pt） */
export function displayPixelsToPdfBox(
  box: { left: number; bottom: number; right: number; top: number },
  scale: number
): { left: number; bottom: number; right: number; top: number } {
  return {
    left: box.left / scale,
    bottom: box.bottom / scale,
    right: box.right / scale,
    top: box.top / scale,
  };
}
