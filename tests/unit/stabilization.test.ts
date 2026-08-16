import { describe, it, expect } from 'vitest';
import { analyzeLayout } from '../../src/crop/document-layout';
import { computePageCrops } from '../../src/crop/stabilization';
import type { PageAnalysis } from '../../src/crop/crop-model';
import { DEFAULT_CROP_CONFIG } from '../../src/crop/crop-model';
import { expandBox, boxWidth, boxHeight } from '../../src/crop/bounding-box';

/** 构造标准论文页分析：A4，内容集中在文本区 */
function paperPage(
  index: number,
  opts: {
    content?: { left: number; bottom: number; right: number; top: number } | null;
    rotation?: number;
    outlier?: boolean;
    blank?: boolean;
    media?: { left: number; bottom: number; right: number; top: number };
  } = {}
): PageAnalysis {
  const media = opts.media ?? { left: 0, bottom: 0, right: 595.28, top: 841.89 };
  const content = opts.content ?? { left: 100, bottom: 80, right: 500, top: 760 };
  return {
    pageIndex: index,
    mediaBox: media,
    cropBox: { ...media },
    contentBox: opts.blank ? null : content,
    rotation: opts.rotation ?? 0,
    isBlank: !!opts.blank,
    darkBackground: false,
    isOutlier: !!opts.outlier,
    analysisFailed: false,
  };
}

describe('document-layout', () => {
  it('普通论文：全部归入一个 normal 组', () => {
    const analyses = [0, 1, 2, 3].map((i) => paperPage(i));
    const layout = analyzeLayout(analyses, DEFAULT_CROP_CONFIG);
    expect(layout.groups.length).toBe(1);
    expect(layout.groups[0].kind).toBe('normal');
    expect(layout.groups[0].pageIndexes).toEqual([0, 1, 2, 3]);
  });

  it('书籍奇偶镜像页边距：自动拆分为 odd/even', () => {
    const analyses: PageAnalysis[] = [];
    for (let i = 0; i < 12; i++) {
      // 偶数页（PDF 0-based 偶数 = 书籍右页? 我们用 left 差异模拟）
      const isEven = i % 2 === 0;
      analyses.push(
        paperPage(i, {
          content: isEven
            ? { left: 150, bottom: 80, right: 500, top: 760 } // 内侧（左）边距大
            : { left: 80, bottom: 80, right: 540, top: 760 }, // 外侧（左）边距小
        })
      );
    }
    const layout = analyzeLayout(analyses, DEFAULT_CROP_CONFIG);
    const kinds = layout.groups.map((g) => g.kind).sort();
    expect(kinds).toContain('odd');
    expect(kinds).toContain('even');
    // 奇数/偶数页分别在对应组
    const oddGroup = layout.groups.find((g) => g.kind === 'odd')!;
    const evenGroup = layout.groups.find((g) => g.kind === 'even')!;
    expect(oddGroup.pageIndexes.every((i) => i % 2 === 1)).toBe(true);
    expect(evenGroup.pageIndexes.every((i) => i % 2 === 0)).toBe(true);
  });

  it('页数不足时不拆分奇偶', () => {
    const analyses: PageAnalysis[] = [];
    for (let i = 0; i < 4; i++) {
      analyses.push(paperPage(i, { content: { left: 100 + i * 5, bottom: 80, right: 500, top: 760 } }));
    }
    const layout = analyzeLayout(analyses, DEFAULT_CROP_CONFIG);
    expect(layout.groups.every((g) => g.kind === 'normal')).toBe(true);
  });

  it('整页图/封面页被标记为 outlier 并单独成组', () => {
    const analyses = [
      paperPage(0, { content: { left: 0, bottom: 0, right: 595.28, top: 841.89 } }), // 整页图
      paperPage(1),
      paperPage(2),
      paperPage(3),
    ];
    const layout = analyzeLayout(analyses, DEFAULT_CROP_CONFIG);
    const outlierGroup = layout.groups.find((g) => g.kind === 'outlier');
    expect(outlierGroup).toBeDefined();
    expect(outlierGroup!.pageIndexes).toEqual([0]);
    const normalGroup = layout.groups.find((g) => g.kind === 'normal');
    expect(normalGroup!.pageIndexes).toEqual([1, 2, 3]);
  });

  it('空白页单独成组', () => {
    const analyses = [paperPage(0, { blank: true }), paperPage(1), paperPage(2)];
    const layout = analyzeLayout(analyses, DEFAULT_CROP_CONFIG);
    const blankGroup = layout.groups.find((g) => g.kind === 'blank');
    expect(blankGroup!.pageIndexes).toEqual([0]);
  });

  it('不同页面尺寸分组', () => {
    const analyses = [
      paperPage(0),
      paperPage(1, { media: { left: 0, bottom: 0, right: 500, top: 700 } }),
      paperPage(2),
    ];
    const layout = analyzeLayout(analyses, DEFAULT_CROP_CONFIG);
    // 500x700 单独一组（容差 1pt 外）
    const smallGroup = layout.groups.find((g) => g.pageIndexes.includes(1));
    expect(smallGroup!.pageIndexes).toEqual([1]);
  });
});

describe('stabilization', () => {
  it('正常组：所有页共用并集 + 2mm 边距，内容不被切', () => {
    const analyses = [
      paperPage(0, { content: { left: 100, bottom: 80, right: 500, top: 760 } }),
      paperPage(1, { content: { left: 102, bottom: 82, right: 498, top: 758 } }),
      paperPage(2, { content: { left: 101, bottom: 81, right: 500, top: 761 } }),
    ];
    const layout = analyzeLayout(analyses, DEFAULT_CROP_CONFIG);
    const crops = computePageCrops(analyses, layout, DEFAULT_CROP_CONFIG);
    const pad = DEFAULT_CROP_CONFIG.safeMarginPt;
    for (const c of crops) {
      expect(c.cropBox.left).toBeCloseTo(100 - pad, 4);
      expect(c.cropBox.bottom).toBeCloseTo(80 - pad, 4);
      expect(c.cropBox.right).toBeCloseTo(500 + pad, 4);
      expect(c.cropBox.top).toBeCloseTo(761 + pad, 4);
      expect(c.changed).toBe(true);
      // 安全：内容盒必须在裁剪框内
      const content = analyses[c.pageIndex].contentBox!;
      expect(c.cropBox.left).toBeLessThanOrEqual(content.left + 1e-6);
      expect(c.cropBox.bottom).toBeLessThanOrEqual(content.bottom + 1e-6);
      expect(c.cropBox.right).toBeGreaterThanOrEqual(content.right - 1e-6);
      expect(c.cropBox.top).toBeGreaterThanOrEqual(content.top - 1e-6);
    }
  });

  it('异常页（封面/目录/整页图）：保持原样完全不裁剪，不因整页图破坏组裁剪', () => {
    const analyses = [
      paperPage(0, { content: { left: 0, bottom: 0, right: 595.28, top: 841.89 } }),
      paperPage(1),
      paperPage(2),
    ];
    const layout = analyzeLayout(analyses, DEFAULT_CROP_CONFIG);
    const crops = computePageCrops(analyses, layout, DEFAULT_CROP_CONFIG);
    const pad = DEFAULT_CROP_CONFIG.safeMarginPt;
    const c0 = crops.find((c) => c.pageIndex === 0)!;
    // 异常页完全不裁剪（用户诉求：封面目录不去管他）
    expect(c0.changed).toBe(false);
    expect(c0.cropBox).toEqual(analyses[0].cropBox);
    // 正常页正常裁剪
    const c1 = crops.find((c) => c.pageIndex === 1)!;
    expect(c1.cropBox.left).toBeCloseTo(100 - pad, 4);
  });

  it('带封面的书：封面不裁剪，正文页统一裁剪', () => {
    // 页 0 封面（内容占满），页 1-3 正文
    const analyses = [
      paperPage(0, { content: { left: 0, bottom: 0, right: 595.28, top: 841.89 } }),
      paperPage(1),
      paperPage(2),
      paperPage(3),
    ];
    const layout = analyzeLayout(analyses, DEFAULT_CROP_CONFIG);
    const crops = computePageCrops(analyses, layout, DEFAULT_CROP_CONFIG);
    const pad = DEFAULT_CROP_CONFIG.safeMarginPt;
    const cover = crops.find((c) => c.pageIndex === 0)!;
    expect(cover.changed).toBe(false);
    const body = crops.filter((c) => c.pageIndex > 0);
    for (const c of body) {
      expect(c.changed).toBe(true);
      expect(c.cropBox.left).toBeCloseTo(100 - pad, 4);
    }
  });

  it('空白页不裁剪', () => {
    const analyses = [paperPage(0, { blank: true }), paperPage(1)];
    const layout = analyzeLayout(analyses, DEFAULT_CROP_CONFIG);
    const crops = computePageCrops(analyses, layout, DEFAULT_CROP_CONFIG);
    const c0 = crops.find((c) => c.pageIndex === 0)!;
    expect(c0.changed).toBe(false);
    expect(c0.cropBox).toEqual(analyses[0].cropBox);
  });

  it('裁剪量上限：内容占满页时不裁剪超过 35%', () => {
    // 内容只占左上角极小区域 → 单边裁剪被限制
    const analyses = [
      paperPage(0, { content: { left: 20, bottom: 20, right: 100, top: 100 } }),
    ];
    const layout = analyzeLayout(analyses, DEFAULT_CROP_CONFIG);
    const crops = computePageCrops(analyses, layout, DEFAULT_CROP_CONFIG);
    const c = crops[0];
    const media = analyses[0].mediaBox;
    // 左/下裁剪 ≤ 35% 页宽/高
    expect(c.cropBox.left).toBeGreaterThanOrEqual(media.left);
    expect(c.cropBox.left).toBeLessThanOrEqual(boxWidth(media) * 0.35);
    expect(c.cropBox.bottom).toBeLessThanOrEqual(boxHeight(media) * 0.35);
    // 右/上仍包含内容
    expect(c.cropBox.right).toBeGreaterThanOrEqual(100);
    expect(c.cropBox.top).toBeGreaterThanOrEqual(100);
  });

  it('旋转页：2mm 边距按显示方向施加', () => {
    // 90° 页：未旋转 content left=100 对应显示 top 方向……
    const media = { left: 0, bottom: 0, right: 612, top: 792 };
    const analyses = [
      paperPage(0, {
        media,
        rotation: 90,
        content: { left: 100, bottom: 100, right: 500, top: 700 },
      }),
      paperPage(1, {
        media,
        rotation: 90,
        content: { left: 102, bottom: 98, right: 498, top: 702 },
      }),
    ];
    const layout = analyzeLayout(analyses, DEFAULT_CROP_CONFIG);
    const crops = computePageCrops(analyses, layout, DEFAULT_CROP_CONFIG);
    const pad = DEFAULT_CROP_CONFIG.safeMarginPt;
    const c0 = crops.find((c) => c.pageIndex === 0)!;
    // 内容并集 left=100,bottom=98,right=500,top=702；外扩后未旋转坐标
    expect(c0.cropBox.left).toBeCloseTo(100 - pad, 4);
    expect(c0.cropBox.bottom).toBeCloseTo(98 - pad, 4);
    expect(c0.cropBox.right).toBeCloseTo(500 + pad, 4);
    expect(c0.cropBox.top).toBeCloseTo(702 + pad, 4);
  });

  it('多次裁剪始终基于原始盒：稳定化输入不变则输出不变', () => {
    const analyses = [paperPage(0), paperPage(1), paperPage(2)];
    const layout = analyzeLayout(analyses, DEFAULT_CROP_CONFIG);
    const first = computePageCrops(analyses, layout, DEFAULT_CROP_CONFIG);
    const second = computePageCrops(analyses, layout, DEFAULT_CROP_CONFIG);
    for (let i = 0; i < first.length; i++) {
      expect(first[i].cropBox).toEqual(second[i].cropBox);
    }
  });

  it('expandBox 辅助：安全边距恒为正', () => {
    const b = { left: 10, bottom: 10, right: 20, top: 20 };
    const expanded = expandBox(b, DEFAULT_CROP_CONFIG.safeMarginPt);
    expect(expanded.left).toBeLessThan(b.left);
    expect(expanded.right).toBeGreaterThan(b.right);
  });
});
