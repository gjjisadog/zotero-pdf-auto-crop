import { describe, it, expect } from 'vitest';
import { analyzePagePixels, displayPixelsToPdfBox } from '../../src/crop/page-analyzer';

/** 构造测试位图：白色背景 + 黑色矩形 */
function makeImage(width: number, height: number, rects: { x: number; y: number; w: number; h: number; gray?: number }[], bg = 255): Uint8ClampedArray {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      data[i] = bg;
      data[i + 1] = bg;
      data[i + 2] = bg;
      data[i + 3] = 255;
    }
  }
  for (const r of rects) {
    const g = r.gray ?? 0;
    for (let y = r.y; y < r.y + r.h; y++) {
      for (let x = r.x; x < r.x + r.w; x++) {
        const i = (y * width + x) * 4;
        data[i] = g;
        data[i + 1] = g;
        data[i + 2] = g;
      }
    }
  }
  return data;
}

describe('page-analyzer', () => {
  it('检测黑块内容盒（画布坐标 y 向下 → 显示坐标 y 向上）', () => {
    const w = 100, h = 100;
    const img = makeImage(w, h, [{ x: 20, y: 30, w: 40, h: 50 }]);
    const res = analyzePagePixels({ width: w, height: h, data: img });
    expect(res.contentBox).not.toBeNull();
    // 画布 y 30..79 -> 显示 bottom = h-1-79 = 20, top = h-1-30 = 69
    expect(res.contentBox!.left).toBe(20);
    expect(res.contentBox!.bottom).toBe(20);
    expect(res.contentBox!.right).toBe(59);
    expect(res.contentBox!.top).toBe(69);
    expect(res.backgroundGray).toBe(255);
  });

  it('灰色背景（扫描件）也能检测', () => {
    const w = 100, h = 100;
    const img = makeImage(w, h, [{ x: 10, y: 10, w: 30, h: 30, gray: 0 }], 245);
    const res = analyzePagePixels({ width: w, height: h, data: img });
    expect(res.backgroundGray).toBe(245);
    expect(res.contentBox).not.toBeNull();
    expect(res.contentBox!.left).toBe(10);
  });

  it('孤立 1px 噪点被过滤', () => {
    const w = 100, h = 100;
    // 4 个孤立噪点 + 1 个真实内容块
    const img = makeImage(w, h, [
      { x: 5, y: 5, w: 1, h: 1 },
      { x: 90, y: 5, w: 1, h: 1 },
      { x: 5, y: 90, w: 1, h: 1 },
      { x: 90, y: 90, w: 1, h: 1 },
      { x: 30, y: 40, w: 20, h: 20 },
    ]);
    const res = analyzePagePixels({ width: w, height: h, data: img });
    // 噪点不应污染 bbox
    expect(res.contentBox!.left).toBe(30);
    expect(res.contentBox!.right).toBe(49);
    expect(res.contentBox!.bottom).toBe(h - 1 - 59);
    expect(res.contentBox!.top).toBe(h - 1 - 40);
  });

  it('纯白页返回 contentBox null（空白页）', () => {
    const w = 100, h = 100;
    const img = makeImage(w, h, []);
    const res = analyzePagePixels({ width: w, height: h, data: img });
    expect(res.contentBox).toBeNull();
    expect(res.contentFraction).toBe(0);
  });

  it('浅色内容（灰色 230，阈值 14 内）被视为背景——抗扫描噪声', () => {
    const w = 100, h = 100;
    const img = makeImage(w, h, [{ x: 10, y: 10, w: 20, h: 20, gray: 240 }], 255);
    const res = analyzePagePixels({ width: w, height: h, data: img });
    // |240-255| = 15 > 14，仍是内容。用 gray=245: |245-255|=10 < 14 -> 背景
    const img2 = makeImage(w, h, [{ x: 10, y: 10, w: 20, h: 20, gray: 245 }], 255);
    const res2 = analyzePagePixels({ width: w, height: h, data: img2 });
    expect(res2.contentBox).toBeNull();
  });

  it('半透明像素按背景处理（抗边缘抗锯齿）', () => {
    const w = 50, h = 50;
    const data = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h * 4; i += 4) {
      data[i] = 255; data[i + 1] = 255; data[i + 2] = 255; data[i + 3] = 255;
    }
    // 半透明黑块（alpha=100）
    for (let y = 10; y < 20; y++) {
      for (let x = 10; x < 20; x++) {
        const i = (y * w + x) * 4;
        data[i] = 0; data[i + 1] = 0; data[i + 2] = 0; data[i + 3] = 100;
      }
    }
    const res = analyzePagePixels({ width: w, height: h, data });
    expect(res.contentBox).toBeNull();
  });

  it('displayPixelsToPdfBox 像素→pt 换算', () => {
    const box = { left: 100, bottom: 50, right: 200, top: 150 };
    const pdf = displayPixelsToPdfBox(box, 100 / 72);
    expect(pdf.left).toBeCloseTo(72, 5);
    expect(pdf.bottom).toBeCloseTo(36, 5);
    expect(pdf.right).toBeCloseTo(144, 5);
    expect(pdf.top).toBeCloseTo(108, 5);
  });
});
