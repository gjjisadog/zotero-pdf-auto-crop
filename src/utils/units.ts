/**
 * 单位换算。内部统一使用 PDF point（1 inch = 72 pt）。
 */

/** 1 mm ≈ 2.83465 pt（1 inch = 25.4 mm = 72 pt） */
export const MM_TO_PT = 72 / 25.4;

/** 默认安全边距：2 mm（任务规格 §6） */
export const DEFAULT_SAFE_MARGIN_MM = 2;

/** 默认安全边距（pt） */
export const DEFAULT_SAFE_MARGIN_PT = DEFAULT_SAFE_MARGIN_MM * MM_TO_PT;

export function mmToPt(mm: number): number {
  return mm * MM_TO_PT;
}

export function ptToMm(pt: number): number {
  return pt / MM_TO_PT;
}
