import { describe, it, expect } from 'vitest';
import {
  normalizeRotation, displaySize, pdfPointToDisplay, displayPointToPdf,
  pdfBoxToDisplay, displayBoxToPdf, expandInDisplaySpace,
} from '../../src/crop/rotation';
import type { PageBox } from '../../src/crop/bounding-box';

describe('rotation', () => {
  const size = { width: 612, height: 792 }; // 未旋转 Letter

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
    expect(pdfPointToDisplay(0, 0, size, 90)).toEqual({ x: 0, y: 612 });
    expect(pdfPointToDisplay(612, 0, size, 90)).toEqual({ x: 0, y: 0 });
    expect(pdfPointToDisplay(612, 792, size, 90)).toEqual({ x: 792, y: 0 });
    expect(pdfPointToDisplay(0, 792, size, 90)).toEqual({ x: 792, y: 612 });
  });

  it('180° 四角映射', () => {
    expect(pdfPointToDisplay(0, 0, size, 180)).toEqual({ x: 612, y: 792 });
    expect(pdfPointToDisplay(612, 792, size, 180)).toEqual({ x: 0, y: 0 });
  });

  it('270° 四角映射', () => {
    expect(pdfPointToDisplay(0, 0, size, 270)).toEqual({ x: 792, y: 0 });
    expect(pdfPointToDisplay(612, 0, size, 270)).toEqual({ x: 792, y: 612 });
    expect(pdfPointToDisplay(612, 792, size, 270)).toEqual({ x: 0, y: 612 });
    expect(pdfPointToDisplay(0, 792, size, 270)).toEqual({ x: 0, y: 0 });
  });

  it('round trip 所有角度', () => {
    for (const r of [0, 90, 180, 270] as const) {
      for (const [x, y] of [[0, 0], [100, 200], [612, 792], [300, 400]] as const) {
        const d = pdfPointToDisplay(x, y, size, r);
        const p = displayPointToPdf(d.x, d.y, size, r);
        expect(p.x).toBeCloseTo(x, 6);
        expect(p.y).toBeCloseTo(y, 6);
      }
    }
  });

  it('box 映射保持轴对齐', () => {
    const box: PageBox = { left: 100, bottom: 100, right: 500, top: 700 };
    for (const r of [0, 90, 180, 270] as const) {
      const d = pdfBoxToDisplay(box, size, r);
      const back = displayBoxToPdf(d, size, r);
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
    const expanded = expandInDisplaySpace(content, size, 90, pad);
    expect(expanded.bottom).toBeCloseTo(100 - pad, 4);
    expect(expanded.top).toBeCloseTo(700 + pad, 4);
    // 显示 right = 未旋转 top 方向？90° 时显示 x' = y，显示右 = y 大 = 未旋转 top
    // 显示 bottom = 未旋转 right 方向（x 大）
    expect(expanded.right).toBeCloseTo(500 + pad, 4);
    expect(expanded.left).toBeCloseTo(100 - pad, 4);
  });

  it('expandInDisplaySpace：0° 时四个方向不变', () => {
    const content: PageBox = { left: 100, bottom: 100, right: 500, top: 700 };
    const pad = 5.6693;
    const expanded = expandInDisplaySpace(content, size, 0, pad);
    expect(expanded.left).toBeCloseTo(100 - pad, 4);
    expect(expanded.bottom).toBeCloseTo(100 - pad, 4);
    expect(expanded.right).toBeCloseTo(500 + pad, 4);
    expect(expanded.top).toBeCloseTo(700 + pad, 4);
  });
});
