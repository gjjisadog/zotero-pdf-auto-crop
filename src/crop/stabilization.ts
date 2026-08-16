/**
 * 裁剪稳定化：为每页计算稳定、安全的 CropBox（任务 §11–§14）。
 *
 * 规则：
 * - 正常组（normal/odd/even）：组内所有内容盒的并集 + 安全边距（显示方向），
 *   组内所有页共用同一个「显示局部（display-local）」裁剪框，避免翻页跳动；
 * - 组级统计统一在 display-local 坐标进行（H2-2）：每页用自己的 MediaBox
 *   转局部坐标——同尺寸但 MediaBox 原点不同的页面可以安全同组；
 *   最终每页用自己的 MediaBox 逆变换回绝对坐标；
 * - 特殊页（blank/dark/outlier）：保持「原始可见区域」不变（P1-1），
 *   即重新裁剪时也恢复为原始状态，而不是保留上一次裁剪的结果；
 * - 裁剪量上限：单边不超过页面尺寸的 maxCropFraction（防误检过度裁剪）；
 * - 安全钳制：裁剪框必须完全包含组内所有正常页的内容盒（绝不切内容）。
 */
import type { PageAnalysis, PageCrop, CropConfig, DocumentLayout, PageGroupKind } from './crop-model';
import type { PageBox } from './bounding-box';
import { boxUnion, boxContains, expandBox, clampBox, boxIntersect } from './bounding-box';
import { pdfBoxToDisplay, displayBoxToPdf, displaySize, boxToSize } from './rotation';

/**
 * 组内所有页共用的裁剪框（display-local 坐标，左下原点）。
 * 组内每页用自己的 MediaBox 把绝对内容盒转到 display-local（H2-2），
 * 因此同尺寸不同 MediaBox 原点的页面可以安全同组。
 */
function computeGroupDisplayCropBox(
  analyses: PageAnalysis[],
  indexes: number[],
  config: CropConfig
): PageBox {
  const rep = analyses[indexes[0]];
  const size = boxToSize(rep.mediaBox);
  const rotation = rep.rotation as 0 | 90 | 180 | 270;

  // display-local 并集（每页用自己的 MediaBox）
  let union: PageBox | null = null;
  for (const idx of indexes) {
    const a = analyses[idx];
    const cb = a.contentBox;
    if (!cb) continue;
    const display = pdfBoxToDisplay(cb, a.mediaBox, rotation);
    union = union ? boxUnion(union, display) : display;
  }
  if (!union) {
    // 无内容：返回全显示区域（不裁剪）
    const d = displaySize(size, rotation);
    return { left: 0, bottom: 0, right: d.width, top: d.height };
  }

  // display-local + 安全边距
  const expanded = expandBox(union, config.safeMarginPt);

  // 裁剪量上限（显示方向）：每边最多裁掉 maxCropFraction × 对应显示尺寸，
  // 防止误检（如扫描黑边）导致过度裁剪。
  const display = displaySize(size, rotation);
  const maxCropW = display.width * config.maxCropFraction;
  const maxCropH = display.height * config.maxCropFraction;
  const limited: PageBox = {
    left: Math.min(expanded.left, maxCropW),
    bottom: Math.min(expanded.bottom, maxCropH),
    right: Math.max(expanded.right, display.width - maxCropW),
    top: Math.max(expanded.top, display.height - maxCropH),
  };
  // 防御：限制后仍保证有效矩形
  const safeDisplay: PageBox = {
    left: Math.min(limited.left, limited.right - 1),
    bottom: Math.min(limited.bottom, limited.top - 1),
    right: Math.max(limited.right, limited.left + 1),
    top: Math.max(limited.top, limited.bottom + 1),
  };
  return safeDisplay;
}

export function computePageCrops(
  analyses: PageAnalysis[],
  layout: DocumentLayout,
  config: CropConfig
): PageCrop[] {
  const result: PageCrop[] = [];

  for (const group of layout.groups) {
    const kind: PageGroupKind = group.kind;
    if (kind === 'blank' || kind === 'dark' || kind === 'outlier') {
      // 特殊页（封面/目录/版权/整页图/空白/深色/附录）：保持「原始可见区域」不变（P1-1）。
      // 重新裁剪时也恢复为原始状态，而不是保留上一次裁剪的结果。
      for (const idx of group.pageIndexes) {
        const a = analyses[idx];
        const desired = { ...a.originalVisibleBox };
        result.push({
          pageIndex: idx,
          cropBox: desired,
          groupId: group.id,
          kind,
          changed: !boxesEqualish(desired, a.cropBox),
        });
      }
      continue;
    }
    // normal / odd / even：组内统一 display-local 框，每页用自己的 MediaBox 逆变换
    const groupDisplay = computeGroupDisplayCropBox(analyses, group.pageIndexes, config);
    const rotation = analyses[group.pageIndexes[0]].rotation as 0 | 90 | 180 | 270;
    for (const idx of group.pageIndexes) {
      const a = analyses[idx];
      // display-local → 该页绝对坐标（H2-2：每页用自己的 MediaBox 原点）
      const groupBox = displayBoxToPdf(groupDisplay, a.mediaBox, rotation);
      // 安全校验：内容盒必须完全在裁剪框内（并集保证，防御性检查回退到不裁剪）
      if (a.contentBox && !boxContains(groupBox, a.contentBox)) {
        result.push({
          pageIndex: idx,
          cropBox: { ...a.originalVisibleBox },
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

void clampBox;
