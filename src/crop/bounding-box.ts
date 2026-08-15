/**
 * PDF 页面盒（Page Box）基础类型与运算。
 *
 * 约定：PageBox 使用 PDF 未旋转坐标（与 /MediaBox、/CropBox 一致），
 * 左下角为原点，`left <= right`、`bottom <= top`。
 */

export interface PageBox {
  left: number;
  bottom: number;
  right: number;
  top: number;
}

/** 由左下角 + 宽高构造（pdf-lib getMediaBox 的返回形态） */
export function boxFromRect(x: number, y: number, width: number, height: number): PageBox {
  return { left: x, bottom: y, right: x + width, top: y + height };
}

/** 转换为左下角 + 宽高形态 */
export function boxToRect(box: PageBox): { x: number; y: number; width: number; height: number } {
  return {
    x: box.left,
    y: box.bottom,
    width: box.right - box.left,
    height: box.top - box.bottom,
  };
}

export function boxWidth(box: PageBox): number {
  return box.right - box.left;
}

export function boxHeight(box: PageBox): number {
  return box.top - box.bottom;
}

export function boxArea(box: PageBox): number {
  return boxWidth(box) * boxHeight(box);
}

/** outer 是否完全包含 inner（含边界容差） */
export function boxContains(outer: PageBox, inner: PageBox, epsilon = 0.01): boolean {
  return (
    inner.left >= outer.left - epsilon &&
    inner.bottom >= outer.bottom - epsilon &&
    inner.right <= outer.right + epsilon &&
    inner.top <= outer.top + epsilon
  );
}

/** 并集 */
export function boxUnion(a: PageBox, b: PageBox): PageBox {
  return {
    left: Math.min(a.left, b.left),
    bottom: Math.min(a.bottom, b.bottom),
    right: Math.max(a.right, b.right),
    top: Math.max(a.top, b.top),
  };
}

/** 交集；无交集时返回 null */
export function boxIntersect(a: PageBox, b: PageBox): PageBox | null {
  const left = Math.max(a.left, b.left);
  const bottom = Math.max(a.bottom, b.bottom);
  const right = Math.min(a.right, b.right);
  const top = Math.min(a.top, b.top);
  if (left >= right || bottom >= top) {
    return null;
  }
  return { left, bottom, right, top };
}

/** 四边外扩（pad 可为负） */
export function expandBox(box: PageBox, pad: number): PageBox {
  return {
    left: box.left - pad,
    bottom: box.bottom - pad,
    right: box.right + pad,
    top: box.top + pad,
  };
}

/** 钳制到 mediaBox 内；若 box 与 mediaBox 无交集则返回 mediaBox */
export function clampBox(box: PageBox, mediaBox: PageBox): PageBox {
  const inter = boxIntersect(box, mediaBox);
  if (!inter) {
    return { ...mediaBox };
  }
  return {
    left: Math.max(box.left, mediaBox.left),
    bottom: Math.max(box.bottom, mediaBox.bottom),
    right: Math.min(box.right, mediaBox.right),
    top: Math.min(box.top, mediaBox.top),
  };
}

/** 近似相等（每边误差 < epsilon） */
export function boxesEqual(a: PageBox, b: PageBox, epsilon = 0.01): boolean {
  return (
    Math.abs(a.left - b.left) < epsilon &&
    Math.abs(a.bottom - b.bottom) < epsilon &&
    Math.abs(a.right - b.right) < epsilon &&
    Math.abs(a.top - b.top) < epsilon
  );
}
