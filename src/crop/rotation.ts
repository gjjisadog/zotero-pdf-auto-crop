/**
 * 页面旋转坐标映射（0/90/180/270，顺时针）。
 *
 * PDF 的 /MediaBox、/CropBox 位于「未旋转」坐标（左下原点，但原点坐标
 * 可以是任意值，例如 MediaBox = [20 30 632 822] 或 [-20 -30 592 762]）。
 * 观看器按 /Rotate 顺时针旋转后显示；用户看到的 Left/Right/Top/Bottom
 * 是显示方向，因此安全边距与内容盒必须先变换到显示坐标再施加。
 *
 * 坐标管线（H2-3：显式局部坐标，支持非零 MediaBox 原点）：
 *   absolute PDF 坐标
 *     ↓ 减 (box.left, box.bottom)
 *   local [0,W]×[0,H]
 *     ↓ 旋转
 *   display 坐标（原点 0）
 * 逆变换：display → 逆旋转 → local → 加 (box.left, box.bottom) → absolute。
 *
 * 约定：display 坐标采用「左下原点、y 向上」的数学坐标（与 PDF 一致）；
 * 像素分析的画布坐标（y 向下）由 page-analyzer 自行翻转。
 */
import type { PageBox } from './bounding-box';

export type Rotation = 0 | 90 | 180 | 270;

export function normalizeRotation(r: number): Rotation {
  let n = ((r % 360) + 360) % 360;
  if (n === 90 || n === 180 || n === 270) return n as Rotation;
  return 0;
}

export interface PageSize {
  width: number;
  height: number;
}

/** 从页面盒提取尺寸与原点 */
export function boxToSize(box: PageBox): PageSize {
  return { width: box.right - box.left, height: box.top - box.bottom };
}

/** 未旋转尺寸 -> 显示尺寸 */
export function displaySize(size: PageSize, rotation: Rotation): PageSize {
  return rotation === 90 || rotation === 270
    ? { width: size.height, height: size.width }
    : { width: size.width, height: size.height };
}

/**
 * 未旋转绝对坐标点 -> 显示坐标点（左下原点）。
 * 推导：local = (x-L, y-B)；顺时针旋转 r 度后
 * r=90:  (yl, W-xl)；r=180: (W-xl, H-yl)；r=270: (H-yl, xl)；r=0: (xl, yl)
 */
export function pdfPointToDisplay(
  x: number,
  y: number,
  box: PageBox,
  rotation: Rotation
): { x: number; y: number } {
  const xl = x - box.left;
  const yl = y - box.bottom;
  const w = box.right - box.left;
  const h = box.top - box.bottom;
  switch (rotation) {
    case 0:
      return { x: xl, y: yl };
    case 90:
      return { x: yl, y: w - xl };
    case 180:
      return { x: w - xl, y: h - yl };
    case 270:
      return { x: h - yl, y: xl };
  }
}

/** 显示坐标点 -> 未旋转绝对坐标点（pdfPointToDisplay 的逆） */
export function displayPointToPdf(
  x: number,
  y: number,
  box: PageBox,
  rotation: Rotation
): { x: number; y: number } {
  const w = box.right - box.left;
  const h = box.top - box.bottom;
  let xl: number;
  let yl: number;
  switch (rotation) {
    case 0:
      xl = x;
      yl = y;
      break;
    case 90:
      xl = w - y;
      yl = x;
      break;
    case 180:
      xl = w - x;
      yl = h - y;
      break;
    case 270:
      xl = y;
      yl = h - x;
      break;
  }
  return { x: xl + box.left, y: yl + box.bottom };
}

/** 未旋转绝对 bbox -> 显示 bbox（轴对齐矩形仍为轴对齐矩形） */
export function pdfBoxToDisplay(box: PageBox, refBox: PageBox, rotation: Rotation): PageBox {
  const bl = pdfPointToDisplay(box.left, box.bottom, refBox, rotation);
  const tr = pdfPointToDisplay(box.right, box.top, refBox, rotation);
  return {
    left: Math.min(bl.x, tr.x),
    bottom: Math.min(bl.y, tr.y),
    right: Math.max(bl.x, tr.x),
    top: Math.max(bl.y, tr.y),
  };
}

/** 显示 bbox -> 未旋转绝对 bbox */
export function displayBoxToPdf(box: PageBox, refBox: PageBox, rotation: Rotation): PageBox {
  const bl = displayPointToPdf(box.left, box.bottom, refBox, rotation);
  const tr = displayPointToPdf(box.right, box.top, refBox, rotation);
  return {
    left: Math.min(bl.x, tr.x),
    bottom: Math.min(bl.y, tr.y),
    right: Math.max(bl.x, tr.x),
    top: Math.max(bl.y, tr.y),
  };
}

/**
 * 按显示方向外扩：content（未旋转绝对）-> 显示 + pad -> 未旋转绝对。
 * 这样 2 mm 安全边距始终是「用户看到的」左/右/上/下。
 */
export function expandInDisplaySpace(box: PageBox, refBox: PageBox, rotation: Rotation, pad: number): PageBox {
  const display = pdfBoxToDisplay(box, refBox, rotation);
  const expanded = {
    left: display.left - pad,
    bottom: display.bottom - pad,
    right: display.right + pad,
    top: display.top + pad,
  };
  return displayBoxToPdf(expanded, refBox, rotation);
}
