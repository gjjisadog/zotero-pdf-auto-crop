/**
 * 裁剪稳定化：为每页计算稳定、安全的 CropBox（任务 §11–§14）。
 *
 * 规则：
 * - 正常组（normal/odd/even）：组内所有内容盒的并集 + 安全边距（显示方向），
 *   组内所有页共用同一个 CropBox，避免翻页跳动；
 * - 异常页/空白页/失败页：单独处理——异常页用该页自身内容盒 + 安全边距
 *   （通常等于几乎不裁剪）；空白页/失败页保持当前 CropBox 不动；
 * - 裁剪量上限：单边不超过页面尺寸的 maxCropFraction（防误检过度裁剪）；
 * - 安全钳制：CropBox 必须完全包含组内所有正常页的内容盒（绝不切内容）。
 */
import type { PageAnalysis, PageCrop, CropConfig, DocumentLayout, PageGroupKind } from './crop-model';
import type { PageBox } from './bounding-box';
import { boxUnion, boxContains, expandBox, clampBox, boxWidth, boxHeight, boxIntersect } from './bounding-box';
import { pdfBoxToDisplay, displayBoxToPdf, displaySize } from './rotation';

/** 组内所有页共用的裁剪框（未旋转坐标） */
function computeGroupCropBox(analyses: PageAnalysis[], indexes: number[], config: CropConfig): PageBox {
  const rep = analyses[indexes[0]];
  const mediaBox = rep.mediaBox;
  const size = { width: boxWidth(mediaBox), height: boxHeight(mediaBox) };
  const rotation = rep.rotation as 0 | 90 | 180 | 270;

  // 显示坐标并集
  let union: PageBox | null = null;
  for (const idx of indexes) {
    const cb = analyses[idx].contentBox;
    if (!cb) continue;
    const display = pdfBoxToDisplay(cb, size, rotation);
    union = union ? boxUnion(union, display) : display;
  }
  if (!union) return { ...mediaBox };

  // 显示坐标 + 安全边距 → 未旋转坐标
  let crop = displayBoxToPdf(
    expandBox(union, config.safeMarginPt),
    size,
    rotation
  );
  crop = clampBox(crop, mediaBox);

  // 裁剪量上限（显示方向）：每边最多裁掉 maxCropFraction × 对应显示尺寸，
  // 防止误检（如扫描黑边）导致过度裁剪。
  const display = displaySize(size, rotation);
  const displayCrop = pdfBoxToDisplay(crop, size, rotation);
  const maxCropW = display.width * config.maxCropFraction;
  const maxCropH = display.height * config.maxCropFraction;
  const limited: PageBox = {
    left: Math.min(displayCrop.left, maxCropW),
    bottom: Math.min(displayCrop.bottom, maxCropH),
    right: Math.max(displayCrop.right, display.width - maxCropW),
    top: Math.max(displayCrop.top, display.height - maxCropH),
  };
  // 防御：限制后仍保证有效矩形
  const safeDisplay: PageBox = {
    left: Math.min(limited.left, limited.right - 1),
    bottom: Math.min(limited.bottom, limited.top - 1),
    right: Math.max(limited.right, limited.left + 1),
    top: Math.max(limited.top, limited.bottom + 1),
  };
  return displayBoxToPdf(safeDisplay, size, rotation);
}

/** 异常页单独处理：自身内容盒 + 安全边距（几乎不裁剪，保证安全） */
function computeOutlierCropBox(analysis: PageAnalysis, config: CropConfig): PageBox {
  const mediaBox = analysis.mediaBox;
  if (!analysis.contentBox) return { ...analysis.cropBox };
  const size = { width: boxWidth(mediaBox), height: boxHeight(mediaBox) };
  const rotation = analysis.rotation as 0 | 90 | 180 | 270;
  const display = pdfBoxToDisplay(analysis.contentBox, size, rotation);
  let crop = displayBoxToPdf(expandBox(display, config.safeMarginPt), size, rotation);
  return clampBox(crop, mediaBox);
}

export function computePageCrops(
  analyses: PageAnalysis[],
  layout: DocumentLayout,
  config: CropConfig
): PageCrop[] {
  const result: PageCrop[] = [];

  for (const group of layout.groups) {
    const kind: PageGroupKind = group.kind;
    if (kind === 'blank') {
      // 空白页/失败页：不动
      for (const idx of group.pageIndexes) {
        const a = analyses[idx];
        result.push({
          pageIndex: idx,
          cropBox: { ...a.cropBox },
          groupId: group.id,
          kind,
          changed: false,
        });
      }
      continue;
    }
    if (kind === 'outlier') {
      for (const idx of group.pageIndexes) {
        const a = analyses[idx];
        const cropBox = computeOutlierCropBox(a, config);
        result.push({
          pageIndex: idx,
          cropBox,
          groupId: group.id,
          kind,
          changed: !boxesEqualish(cropBox, a.cropBox),
        });
      }
      continue;
    }
    // normal / odd / even：组内统一框
    const groupBox = computeGroupCropBox(analyses, group.pageIndexes, config);
    // 安全校验：组内每个正常页的内容盒必须完全在裁剪框内
    // （并集保证不会违反，这里做防御性检查并回退到不裁剪）
    for (const idx of group.pageIndexes) {
      const a = analyses[idx];
      if (a.contentBox && !boxContains(groupBox, a.contentBox)) {
        // 防御：任何内容被切 → 该页不裁剪（安全优先）
        result.push({
          pageIndex: idx,
          cropBox: { ...a.cropBox },
          groupId: group.id,
          kind,
          changed: false,
        });
        continue;
      }
      // 保证裁剪框与 MediaBox 有交集（非空页面）
      const safe = boxIntersect(groupBox, a.mediaBox) ? groupBox : { ...a.mediaBox };
      result.push({
        pageIndex: idx,
        cropBox: safe,
        groupId: group.id,
        kind,
        changed: !boxesEqualish(safe, a.cropBox),
      });
    }
  }

  // 按页序输出
  result.sort((a, b) => a.pageIndex - b.pageIndex);
  return result;
}

function boxesEqualish(a: PageBox, b: PageBox, epsilon = 0.05): boolean {
  return (
    Math.abs(a.left - b.left) < epsilon &&
    Math.abs(a.bottom - b.bottom) < epsilon &&
    Math.abs(a.right - b.right) < epsilon &&
    Math.abs(a.top - b.top) < epsilon
  );
}
