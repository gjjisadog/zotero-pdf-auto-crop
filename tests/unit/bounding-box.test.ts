import { describe, it, expect } from 'vitest';
import {
  boxFromRect, boxToRect, boxWidth, boxHeight, boxArea,
  boxContains, boxUnion, boxIntersect, expandBox, clampBox, boxesEqual,
} from '../../src/crop/bounding-box';

describe('bounding-box', () => {
  it('boxFromRect / boxToRect 往返', () => {
    const b = boxFromRect(10, 20, 100, 200);
    expect(b).toEqual({ left: 10, bottom: 20, right: 110, top: 220 });
    const r = boxToRect(b);
    expect(r).toEqual({ x: 10, y: 20, width: 100, height: 200 });
  });

  it('width/height/area', () => {
    const b = { left: 0, bottom: 0, right: 612, top: 792 };
    expect(boxWidth(b)).toBe(612);
    expect(boxHeight(b)).toBe(792);
    expect(boxArea(b)).toBe(612 * 792);
  });

  it('boxContains 边界与容差', () => {
    const outer = { left: 0, bottom: 0, right: 612, top: 792 };
    expect(boxContains(outer, { left: 100, bottom: 100, right: 500, top: 700 })).toBe(true);
    expect(boxContains(outer, { left: -1, bottom: 0, right: 500, top: 700 })).toBe(false);
    expect(boxContains(outer, { left: -0.005, bottom: 0, right: 500, top: 700 })).toBe(true);
  });

  it('boxUnion', () => {
    const a = { left: 0, bottom: 0, right: 100, top: 100 };
    const b = { left: 50, bottom: 50, right: 200, top: 80 };
    expect(boxUnion(a, b)).toEqual({ left: 0, bottom: 0, right: 200, top: 100 });
  });

  it('boxIntersect 有/无交集', () => {
    const a = { left: 0, bottom: 0, right: 100, top: 100 };
    const b = { left: 50, bottom: 50, right: 200, top: 200 };
    expect(boxIntersect(a, b)).toEqual({ left: 50, bottom: 50, right: 100, top: 100 });
    const c = { left: 200, bottom: 200, right: 300, top: 300 };
    expect(boxIntersect(a, c)).toBeNull();
  });

  it('expandBox 四边外扩', () => {
    const b = { left: 10, bottom: 20, right: 30, top: 40 };
    expect(expandBox(b, 5)).toEqual({ left: 5, bottom: 15, right: 35, top: 45 });
  });

  it('clampBox 钳制到 mediaBox', () => {
    const media = { left: 0, bottom: 0, right: 612, top: 792 };
    const b = { left: -10, bottom: 5, right: 700, top: 800 };
    expect(clampBox(b, media)).toEqual({ left: 0, bottom: 5, right: 612, top: 792 });
  });

  it('clampBox 无交集时返回 mediaBox', () => {
    const media = { left: 0, bottom: 0, right: 100, top: 100 };
    const b = { left: 200, bottom: 200, right: 300, top: 300 };
    expect(clampBox(b, media)).toEqual(media);
  });

  it('boxesEqual 容差', () => {
    expect(boxesEqual({ left: 0, bottom: 0, right: 1, top: 1 }, { left: 0.005, bottom: 0, right: 1, top: 1 })).toBe(true);
    expect(boxesEqual({ left: 0, bottom: 0, right: 1, top: 1 }, { left: 0.05, bottom: 0, right: 1, top: 1 })).toBe(false);
  });
});
