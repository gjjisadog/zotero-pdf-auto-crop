/**
 * 文档布局分析：页面分组（尺寸/旋转 + 奇偶自动识别）+ 异常页判定。
 */
import type { PageAnalysis, DocumentLayout, PageGroup, CropConfig } from './crop-model';
import { normalizeRotation, displaySize } from './rotation';
import { boxArea, boxWidth, boxHeight } from './bounding-box';

function median(values: number[]): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** 尺寸聚类：与已存在的组中心比较，容差 1 pt */
function findSizeGroup(
  groups: { width: number; height: number }[],
  width: number,
  height: number
): number {
  for (let i = 0; i < groups.length; i++) {
    if (Math.abs(groups[i].width - width) <= 1 && Math.abs(groups[i].height - height) <= 1) {
      return i;
    }
  }
  groups.push({ width, height });
  return groups.length - 1;
}

/**
 * 按 (未旋转尺寸, 旋转) 分组。
 * 返回 sizeGroup -> rotation -> pageIndexes。
 */
function groupBySizeAndRotation(
  analyses: PageAnalysis[]
): Map<string, number[]> {
  const sizeGroups: { width: number; height: number }[] = [];
  const map = new Map<string, number[]>();
  for (const a of analyses) {
    const si = findSizeGroup(sizeGroups, boxWidth(a.mediaBox), boxHeight(a.mediaBox));
    const rotation = normalizeRotation(a.rotation);
    const key = `${si}:${rotation}`;
    const arr = map.get(key);
    if (arr) arr.push(a.pageIndex);
    else map.set(key, [a.pageIndex]);
  }
  return map;
}

/**
 * 奇偶自动识别：若组内奇数页与偶数页的「左侧内容边中位数」差异
 * 超过页宽的一定比例（书籍镜像页边距），则拆分为 odd/even 两组。
 */
function splitOddEvenIfMirrored(
  analyses: PageAnalysis[],
  indexes: number[],
  config: CropConfig
): { odd: number[]; even: number[] } | null {
  if (indexes.length < config.oddEvenMinPages) return null;
  const odd: number[] = [];
  const even: number[] = [];
  const oddLefts: number[] = [];
  const evenLefts: number[] = [];
  for (const idx of indexes) {
    const a = analyses[idx];
    if (!a.contentBox || a.isBlank || a.isOutlier) continue;
    const w = boxWidth(a.mediaBox);
    if (idx % 2 === 0) {
      even.push(idx);
      evenLefts.push(a.contentBox.left / w);
    } else {
      odd.push(idx);
      oddLefts.push(a.contentBox.left / w);
    }
  }
  if (oddLefts.length < 3 || evenLefts.length < 3) return null;
  const diff = Math.abs(median(oddLefts) - median(evenLefts));
  if (diff < config.oddEvenMarginDiffFraction) return null;
  return { odd, even };
}

/**
 * 异常页判定（在组内统计完成后调用）：
 * 内容盒任一边偏离组中位数超过 max(比例×页面尺寸, 最小 pt) 即视为异常。
 * 空白页、分析失败页也标记。
 */
export function markOutliers(analyses: PageAnalysis[], config: CropConfig): void {
  // 先按 (尺寸,旋转) 统计各「内容非空页」的中位数盒
  const groups = groupBySizeAndRotation(analyses);
  for (const indexes of groups.values()) {
    const withContent = indexes.filter((i) => {
      const a = analyses[i];
      return a.contentBox && !a.isBlank && !a.analysisFailed;
    });
    if (withContent.length === 0) continue;
    const lefts = withContent.map((i) => analyses[i].contentBox!.left);
    const bottoms = withContent.map((i) => analyses[i].contentBox!.bottom);
    const rights = withContent.map((i) => analyses[i].contentBox!.right);
    const tops = withContent.map((i) => analyses[i].contentBox!.top);
    const mL = median(lefts);
    const mB = median(bottoms);
    const mR = median(rights);
    const mT = median(tops);
    const medArea = median(
      withContent.map((i) => boxArea(analyses[i].contentBox!))
    );
    const ref = analyses[withContent[0]];
    const w = boxWidth(ref.mediaBox);
    const h = boxHeight(ref.mediaBox);
    const devX = Math.max(w * config.outlierEdgeDeviationFraction, config.outlierMinEdgeDeviationPt);
    const devY = Math.max(h * config.outlierEdgeDeviationFraction, config.outlierMinEdgeDeviationPt);

    for (const idx of indexes) {
      const a = analyses[idx];
      if (a.analysisFailed) {
        a.isOutlier = true;
        continue;
      }
      if (a.isBlank) continue;
      if (!a.contentBox) {
        a.isOutlier = true;
        continue;
      }
      const cb = a.contentBox;
      const area = boxArea(cb);
      // 面积异常（整页图 / 极简页）
      if (medArea > 0 && (area < medArea * 0.25 || area > medArea * 5)) {
        a.isOutlier = true;
        continue;
      }
      // 边缘偏离异常
      if (
        Math.abs(cb.left - mL) > devX ||
        Math.abs(cb.bottom - mB) > devY ||
        Math.abs(cb.right - mR) > devX ||
        Math.abs(cb.top - mT) > devY
      ) {
        a.isOutlier = true;
      }
    }
  }
}

/** 构建完整文档布局（分组 + 异常标记） */
export function analyzeLayout(analyses: PageAnalysis[], config: CropConfig): DocumentLayout {
  // 空白页与失败页先标记（不参与任何统计）
  for (const a of analyses) {
    if (a.analysisFailed) {
      a.isBlank = false;
      continue;
    }
    if (!a.contentBox) {
      a.isBlank = true;
    }
  }
  markOutliers(analyses, config);

  const groups: PageGroup[] = [];
  const groupOf = new Map<number, string>();
  const bySizeRotation = groupBySizeAndRotation(analyses);

  let groupCounter = 0;
  const nextId = () => `g${groupCounter++}`;

  for (const indexes of bySizeRotation.values()) {
    const representative = analyses[indexes[0]];
    const width = boxWidth(representative.mediaBox);
    const height = boxHeight(representative.mediaBox);
    const rotation = normalizeRotation(representative.rotation);
    const display = displaySize({ width, height }, rotation);

    // 空白页组
    const blanks = indexes.filter((i) => analyses[i].isBlank || analyses[i].analysisFailed);
    if (blanks.length > 0) {
      groups.push({
        id: nextId(),
        kind: 'blank',
        pageIndexes: blanks,
        width: display.width,
        height: display.height,
        rotation,
      });
      for (const i of blanks) groupOf.set(i, groups[groups.length - 1].id);
    }

    // 主体页：尝试奇偶拆分
    const main = indexes.filter((i) => !analyses[i].isBlank && !analyses[i].analysisFailed);
    if (main.length === 0) continue;
    const split = splitOddEvenIfMirrored(analyses, main, config);
    const buckets: { kind: 'normal' | 'odd' | 'even'; indexes: number[] }[] = split
      ? [
          { kind: 'even', indexes: split.even },
          { kind: 'odd', indexes: split.odd },
        ]
      : [{ kind: 'normal', indexes: main }];

    for (const bucket of buckets) {
      if (bucket.indexes.length === 0) continue;
      // 组内再分：异常页单独成组（special），正常页成组
      const normal = bucket.indexes.filter((i) => !analyses[i].isOutlier);
      const outliers = bucket.indexes.filter((i) => analyses[i].isOutlier);
      if (normal.length > 0) {
        const g: PageGroup = {
          id: nextId(),
          kind: bucket.kind,
          pageIndexes: normal,
          width: display.width,
          height: display.height,
          rotation,
        };
        groups.push(g);
        for (const i of normal) groupOf.set(i, g.id);
      }
      for (const i of outliers) {
        const g: PageGroup = {
          id: nextId(),
          kind: 'outlier',
          pageIndexes: [i],
          width: display.width,
          height: display.height,
          rotation,
        };
        groups.push(g);
        groupOf.set(i, g.id);
      }
    }
  }

  return { groups, groupOf };
}
