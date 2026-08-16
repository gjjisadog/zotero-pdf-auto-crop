import { describe, it, expect } from 'vitest';
import {
  normalizeRotation, displaySize, pdfPointToDisplay, displayPointToPdf,
  pdfBoxToDisplay, displayBoxToPdf, expandInDisplaySpace, boxToSize,
} from '../../src/crop/rotation';
import type { PageBox } from '../../src/crop/bounding-box';

describe('rotation', () => {
  const box: PageBox = { left: 0, bottom: 0, right: 612, top: 792 }; // 未旋转 Letter
  const size = boxToSize(box);

  it('normalizeRotation', () => {
    expect(normalizeRotation(0)).toBe(0);
    expect(normalizeRotation(90)).toBe(90);
    expect(normalizeRotation(360)).toBe(0);
    expect(normalizeRotation(-90)).toBe(270);
    expect(normalizeRotation(450)).toBe(90);
    expect(normalizeRotation(45)).toBe(0);
  });

  it('displaySize 90/270 宽高互换', () => {
    expect(displaySize(size, 0)).toEqual({ width: 612, height: 792 });
    expect(displaySize(size, 90)).toEqual({ width: 792, height: 612 });
    expect(displaySize(size, 180)).toEqual({ width: 612, height: 792 });
    expect(displaySize(size, 270)).toEqual({ width: 792, height: 612 });
  });

  it('90° 时四角映射正确（顺时针）', () => {
    // 未旋转左下 (0,0) -> 显示右下（旋转 90° 后左下角在右下）
    expect(pdfPointToDisplay(0, 0, box, 90)).toEqual({ x: 0, y: 612 });
    expect(pdfPointToDisplay(612, 0, box, 90)).toEqual({ x: 0, y: 0 });
    expect(pdfPointToDisplay(612, 792, box, 90)).toEqual({ x: 792, y: 0 });
    expect(pdfPointToDisplay(0, 792, box, 90)).toEqual({ x: 792, y: 612 });
  });

  it('180° 四角映射', () => {
    expect(pdfPointToDisplay(0, 0, box, 180)).toEqual({ x: 612, y: 792 });
    expect(pdfPointToDisplay(612, 792, box, 180)).toEqual({ x: 0, y: 0 });
  });

  it('270° 四角映射', () => {
    expect(pdfPointToDisplay(0, 0, box, 270)).toEqual({ x: 792, y: 0 });
    expect(pdfPointToDisplay(612, 0, box, 270)).toEqual({ x: 792, y: 612 });
    expect(pdfPointToDisplay(612, 792, box, 270)).toEqual({ x: 0, y: 612 });
    expect(pdfPointToDisplay(0, 792, box, 270)).toEqual({ x: 0, y: 0 });
  });

  it('round trip 所有角度', () => {
    for (const r of [0, 90, 180, 270] as const) {
      for (const [x, y] of [[0, 0], [100, 200], [612, 792], [300, 400]] as const) {
        const d = pdfPointToDisplay(x, y, box, r);
        const p = displayPointToPdf(d.x, d.y, box, r);
        expect(p.x).toBeCloseTo(x, 6);
        expect(p.y).toBeCloseTo(y, 6);
      }
    }
  });

  it('box 映射保持轴对齐', () => {
    const box: PageBox = { left: 100, bottom: 100, right: 500, top: 700 };
    for (const r of [0, 90, 180, 270] as const) {
      const d = pdfBoxToDisplay(box, box, r);
      const back = displayBoxToPdf(d, box, r);
      expect(back.left).toBeCloseTo(box.left, 6);
      expect(back.bottom).toBeCloseTo(box.bottom, 6);
      expect(back.right).toBeCloseTo(box.right, 6);
      expect(back.top).toBeCloseTo(box.top, 6);
    }
  });

  it('expandInDisplaySpace：90° 时「显示左」= 未旋转 bottom（2mm 方向正确）', () => {
    // 内容盒未旋转：left=100, bottom=100, right=500, top=700
    const content: PageBox = { left: 100, bottom: 100, right: 500, top: 700 };
    const pad = 5.6693; // 2mm
    // 90° 显示：left -> 未旋转 bottom 方向。显示 left = 内容 bottom 方向（y 轴）
    // 外扩后显示 left 减小 5.67 -> 未旋转 bottom 减小 5.67
    const expanded = expandInDisplaySpace(content, box, 90, pad);
    expect(expanded.bottom).toBeCloseTo(100 - pad, 4);
    expect(expanded.top).toBeCloseTo(700 + pad, 4);
    // 显示 right = 未旋转 top 方向？90° 时显示 x' = y，显示右 = y 大 = 未旋转 top
    // 显示 bottom = 未旋转 right 方向（x 大）
    expect(expanded.right).toBeCloseTo(500 + pad, 4);
    expect(expanded.left).toBeCloseTo(100 - pad, 4);
  });

  it('非零 MediaBox 原点 + 旋转：坐标往返正确（H2-3）', () => {
    // MediaBox = [20 30 632 822]（原点 20,30，尺寸 612x792）
    const nb: PageBox = { left: 20, bottom: 30, right: 632, top: 822 };
    for (const r of [0, 90, 180, 270] as const) {
      // 局部左下角 (20,30) 旋转后应落在显示区域的对应角
      const d = pdfPointToDisplay(20, 30, nb, r);
      const back = displayPointToPdf(d.x, d.y, nb, r);
      expect(back.x).toBeCloseTo(20, 6);
      expect(back.y).toBeCloseTo(30, 6);
      // 局部右上角
      const d2 = pdfPointToDisplay(632, 822, nb, r);
      const back2 = displayPointToPdf(d2.x, d2.y, nb, r);
      expect(back2.x).toBeCloseTo(632, 6);
      expect(back2.y).toBeCloseTo(822, 6);
    }
    // 90°：局部 (0,0) -> 显示 (0, W)；绝对 (20,30) 同样
    const d90 = pdfPointToDisplay(20, 30, nb, 90);
    expect(d90.x).toBeCloseTo(0, 6);
    expect(d90.y).toBeCloseTo(612, 6);
    const d90tr = pdfPointToDisplay(632, 822, nb, 90);
    expect(d90tr.x).toBeCloseTo(792, 6);
    expect(d90tr.y).toBeCloseTo(0, 6);
  });

  it('负原点 MediaBox + 旋转（H2-3）', () => {
    const nb: PageBox = { left: -20, bottom: -30, right: 592, top: 762 };
    const d = pdfPointToDisplay(-20, -30, nb, 90);
    expect(d.x).toBeCloseTo(0, 6);
    expect(d.y).toBeCloseTo(612, 6);
    const back = displayPointToPdf(d.x, d.y, nb, 90);
    expect(back.x).toBeCloseTo(-20, 6);
    expect(back.y).toBeCloseTo(-30, 6);
  });

  it('expandInDisplaySpace：0° 时四个方向不变', () => {
    const content: PageBox = { left: 100, bottom: 100, right: 500, top: 700 };
    const pad = 5.6693;
    const expanded = expandInDisplaySpace(content, box, 0, pad);
    expect(expanded.left).toBeCloseTo(100 - pad, 4);
    expect(expanded.bottom).toBeCloseTo(100 - pad, 4);
    expect(expanded.right).toBeCloseTo(500 + pad, 4);
    expect(expanded.top).toBeCloseTo(700 + pad, 4);
  });
});
