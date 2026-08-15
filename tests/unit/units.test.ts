import { describe, it, expect } from 'vitest';
import { mmToPt, ptToMm, MM_TO_PT, DEFAULT_SAFE_MARGIN_MM, DEFAULT_SAFE_MARGIN_PT } from '../../src/utils/units';

describe('units', () => {
  it('1 inch = 72 pt, 1 mm ≈ 2.83465 pt', () => {
    expect(MM_TO_PT).toBeCloseTo(2.83465, 4);
    expect(mmToPt(25.4)).toBeCloseTo(72, 5);
  });

  it('2 mm 安全边距换算', () => {
    expect(mmToPt(DEFAULT_SAFE_MARGIN_MM)).toBeCloseTo(5.6693, 4);
    expect(DEFAULT_SAFE_MARGIN_PT).toBeCloseTo(5.6693, 4);
  });

  it('round trip', () => {
    expect(ptToMm(mmToPt(10))).toBeCloseTo(10, 8);
  });
});
