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
 *
 * 扫描黑边/阴影处理（H1-1，第三轮 review）：
 * - 边缘暗带只在其「高置信度」确定为扫描伪影时才允许从内容中排除；
 * - 置信度 = 多信号同时成立：整列/整行内容占比高（fillRatio）、带宽窄、
 *   带内灰度均匀（扫描阴影/黑边近似单色；真实照片/色条纹理复杂）、
 *   且带内平均灰度明显暗于页面背景（近黑黑边/阴影，排除浅色真实内容）；
 * - 任一信号不满足 → 该侧不排除 → 真实贴边图片/色条/侧栏绝不被裁掉；
 * - 结果同时给出 rawContentBox（不做任何暗带排除）与 cleanedContentBox
 *   （仅排除已确认伪影），contentBox = cleaned（只排除了确认噪声，满足
 *   「Final CropBox 必须包含所有不能确认是噪声的内容」）。
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
  /**
   * 边缘暗带判定：边缘列/行的「内容像素占比」超过该值视为暗带候选
   * （整列都是偏离背景的像素 = 阴影/黑边/渐变伪影）；默认 0.6。
   * 暗带最大宽度默认 5% 页面尺寸。
   */
  darkBandRatio?: number;
  darkBandMaxFraction?: number;
  /**
   * 暗带置信度（H1-1）：候选暗带内灰度方差低于该值 = 均匀
   * （扫描阴影/黑边近似单色；照片/色条/图表有纹理）。默认 400（std≈20）。
   */
  darkBandGrayVariance?: number;
  /**
   * 暗带置信度（H1-1）：带内平均灰度比背景暗超过该值才可能是扫描伪影
   * （近黑黑边/阴影；浅色真实内容不被误伤）。默认 25。
   */
  darkBandDarkness?: number;
}

export interface PixelAnalyzeResult {
  /**
   * 实际使用的内容盒（显示坐标，左下原点）：仅排除「高置信度」暗带后的结果；
   * 空白页为 null。
   */
  contentBox: { left: number; bottom: number; right: number; top: number } | null;
  /** 不做任何暗带排除的内容盒（安全基准/测试用）；空白页为 null */
  rawContentBox: { left: number; bottom: number; right: number; top: number } | null;
  /** 仅排除高置信度暗带后的内容盒；空白页为 null */
  cleanedContentBox: { left: number; bottom: number; right: number; top: number } | null;
  /** 背景灰度估计值 */
  backgroundGray: number;
  /** 内容像素占比（含暗带，用于空白页判定） */
  contentFraction: number;
}

const DEFAULT_OPTS: Required<PixelAnalyzeOptions> = {
  grayThreshold: 14,
  minRun: 2,
  minCount: 3,
  blankFraction: 5e-4,
  edgeBandFraction: 0.03,
  darkBandRatio: 0.6,
  darkBandMaxFraction: 0.05,
  darkBandGrayVariance: 400,
  darkBandDarkness: 25,
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
    return { contentBox: null, rawContentBox: null, cleanedContentBox: null, backgroundGray, contentFraction };
  }

  // 4. 边缘暗带候选（扫描阴影/黑边）：整列/整行内容像素占比极高的边缘连续带
  // 5. 逐边置信度判定（H1-1）：占比 + 窄带 + 均匀 + 明显暗于背景，
  //    全部满足才视为扫描伪影并从内容中排除；任一不满足 → 该侧保留。
  const maxBand = Math.max(1, Math.round(w * opts.darkBandMaxFraction));
  const colRatio = new Float32Array(w);
  for (let x = 0; x < w; x++) {
    let cnt = 0;
    for (let y = 0; y < h; y++) cnt += isContent[y * w + x];
    colRatio[x] = cnt / h;
  }
  const rowRatio = new Float32Array(h);
  for (let y = 0; y < h; y++) {
    let cnt = 0;
    const row = y * w;
    for (let x = 0; x < w; x++) cnt += isContent[row + x];
    rowRatio[y] = cnt / w;
  }
  const ratio = opts.darkBandRatio;
  let skipLeft = 0;
  while (skipLeft < maxBand && colRatio[skipLeft] > ratio) skipLeft++;
  let skipRight = 0;
  while (skipRight < maxBand && colRatio[w - 1 - skipRight] > ratio) skipRight++;
  let skipBottom = 0;
  while (skipBottom < maxBand && rowRatio[skipBottom] > ratio) skipBottom++;
  let skipTop = 0;
  while (skipTop < maxBand && rowRatio[h - 1 - skipTop] > ratio) skipTop++;

  // 逐边置信度：带内灰度「均匀」且「明显暗于背景」
  const bandLooksLikeArtifact = (
    startX: number,
    endX: number,
    startY: number,
    endY: number
  ): boolean => {
    let sum = 0;
    let sumSq = 0;
    let n = 0;
    for (let y = startY; y < endY; y++) {
      for (let x = startX; x < endX; x++) {
        const g = gray[y * w + x];
        sum += g;
        sumSq += g * g;
        n++;
      }
    }
    if (n === 0) return false;
    const mean = sum / n;
    const variance = sumSq / n - mean * mean;
    if (variance >= opts.darkBandGrayVariance) return false; // 有纹理 → 真实内容
    if (mean > backgroundGray - opts.darkBandDarkness) return false; // 不暗 → 浅色真实内容
    return true;
  };

  if (skipLeft > 0 && !bandLooksLikeArtifact(0, skipLeft, 0, h)) skipLeft = 0;
  if (skipRight > 0 && !bandLooksLikeArtifact(w - skipRight, w, 0, h)) skipRight = 0;
  if (skipBottom > 0 && !bandLooksLikeArtifact(0, w, 0, skipBottom)) skipBottom = 0;
  if (skipTop > 0 && !bandLooksLikeArtifact(0, w, h - skipTop, h)) skipTop = 0;

  // 6. 双内容盒：raw（不排除任何暗带）与 cleaned（仅排除已确认伪影）。
  //    水平/垂直 run 过滤保证孤立噪点不影响 bbox。
  const rawBox = bboxFromContent(isContent, w, h, opts);
  if (skipLeft + skipRight + skipBottom + skipTop > 0) {
    for (let x = 0; x < skipLeft; x++) {
      for (let y = 0; y < h; y++) isContent[y * w + x] = 0;
    }
    for (let x = w - skipRight; x < w; x++) {
      for (let y = 0; y < h; y++) isContent[y * w + x] = 0;
    }
    for (let y = 0; y < skipBottom; y++) {
      for (let x = 0; x < w; x++) isContent[y * w + x] = 0;
    }
    for (let y = h - skipTop; y < h; y++) {
      for (let x = 0; x < w; x++) isContent[y * w + x] = 0;
    }
  }
  const cleanedBox = bboxFromContent(isContent, w, h, opts);

  return {
    contentBox: cleanedBox,
    rawContentBox: rawBox,
    cleanedContentBox: cleanedBox,
    backgroundGray,
    contentFraction,
  };
}

/**
 * 从内容标记计算显示坐标 bbox（画布坐标 y 向下 → 显示坐标 y 向上）。
 * 水平 run 过滤：每行取「连续内容段 ≥ minRun 且该行内容数 ≥ minCount」；
 * 垂直同理。返回 null 表示无可信内容。
 */
function bboxFromContent(
  isContent: Uint8Array,
  w: number,
  h: number,
  opts: Required<PixelAnalyzeOptions>
): { left: number; bottom: number; right: number; top: number } | null {
  // 水平 run 过滤：每行取「连续内容段 ≥ minRun 且该行内容数 ≥ minCount」的行的 x 范围
  let minX = w;
  let maxX = -1;
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
      if (rowMin < minX) minX = rowMin;
      if (rowMax > maxX) maxX = rowMax;
    }
  }
  if (maxX < 0) {
    return null;
  }

  // 垂直 run 过滤：每列取「连续内容段 ≥ minRun 且该列内容数 ≥ minCount」的列的 y 范围
  let minY = h;
  let maxY = -1;
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
      if (colMin < minY) minY = colMin;
      if (colMax > maxY) maxY = colMax;
    }
  }
  if (maxY < 0) {
    return null;
  }

  // 画布坐标（y 向下）→ 显示坐标（y 向上，左下原点）
  return {
    left: minX,
    bottom: h - 1 - maxY,
    right: maxX,
    top: h - 1 - minY,
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
