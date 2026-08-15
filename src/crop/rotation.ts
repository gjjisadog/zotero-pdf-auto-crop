/**
 * 页面旋转坐标映射（0/90/180/270，顺时针）。
 *
 * PDF 的 /MediaBox、/CropBox 位于「未旋转」坐标（左下原点）；
 * 观看器按 /Rotate 顺时针旋转后显示。用户看到的 Left/Right/Top/Bottom
 * 是显示方向，因此安全边距与内容盒必须先变换到显示坐标再施加。
 *
 * 约定：display 坐标采用「左下原点、y 向上」的数学坐标（与 PDF 一致），
 * 便于在两种坐标间往返；像素分析的画布坐标（y 向下）由 page-analyzer
 * 自行翻转。
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

/** 未旋转尺寸 -> 显示尺寸 */
export function displaySize(size: PageSize, rotation: Rotation): PageSize {
  return rotation === 90 || rotation === 270
    ? { width: size.height, height: size.width }
    : { width: size.width, height: size.height };
}

/**
 * 未旋转坐标点 -> 显示坐标点。
 * 推导（左下原点）：顺时针旋转 r 度后，点 (x,y) 映射为
 * r=90:  (y, W-x)；r=180: (W-x, H-y)；r=270: (H-y, x)；r=0: (x,y)
 */
export function pdfPointToDisplay(
  x: number,
  y: number,
  size: PageSize,
  rotation: Rotation
): { x: number; y: number } {
  switch (rotation) {
    case 0:
      return { x, y };
    case 90:
      return { x: y, y: size.width - x };
    case 180:
      return { x: size.width - x, y: size.height - y };
    case 270:
      return { x: size.height - y, y: x };
  }
}

/** 显示坐标点 -> 未旋转坐标点（pdfPointToDisplay 的逆） */
export function displayPointToPdf(
  x: number,
  y: number,
  size: PageSize,
  rotation: Rotation
): { x: number; y: number } {
  switch (rotation) {
    case 0:
      return { x, y };
    case 90:
      return { x: size.width - y, y: x };
    case 180:
      return { x: size.width - x, y: size.height - y };
    case 270:
      return { x: y, y: size.height - x };
  }
}

/** 未旋转 bbox -> 显示 bbox（轴对齐矩形仍为轴对齐矩形） */
export function pdfBoxToDisplay(box: PageBox, size: PageSize, rotation: Rotation): PageBox {
  const bl = pdfPointToDisplay(box.left, box.bottom, size, rotation);
  const tr = pdfPointToDisplay(box.right, box.top, size, rotation);
  return {
    left: Math.min(bl.x, tr.x),
    bottom: Math.min(bl.y, tr.y),
    right: Math.max(bl.x, tr.x),
    top: Math.max(bl.y, tr.y),
  };
}

/** 显示 bbox -> 未旋转 bbox */
export function displayBoxToPdf(box: PageBox, size: PageSize, rotation: Rotation): PageBox {
  const bl = displayPointToPdf(box.left, box.bottom, size, rotation);
  const tr = displayPointToPdf(box.right, box.top, size, rotation);
  return {
    left: Math.min(bl.x, tr.x),
    bottom: Math.min(bl.y, tr.y),
    right: Math.max(bl.x, tr.x),
    top: Math.max(bl.y, tr.y),
  };
}

/**
 * 按显示方向外扩：content（未旋转）-> 显示 + pad -> 未旋转。
 * 这样 2 mm 安全边距始终是「用户看到的」左/右/上/下。
 */
export function expandInDisplaySpace(box: PageBox, size: PageSize, rotation: Rotation, pad: number): PageBox {
  const display = pdfBoxToDisplay(box, size, rotation);
  const expanded = {
    left: display.left - pad,
    bottom: display.bottom - pad,
    right: display.right + pad,
    top: display.top + pad,
  };
  return displayBoxToPdf(expanded, size, rotation);
}
