/**
 * H2-3 集成测试：非零/负 MediaBox 原点 + 旋转页面的裁剪正确性。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import {
  makeContext, cleanupContext, copyFixture, runCrop, openPdf, renderAndAnalyze,
  type TestContext,
} from './helpers';

const contexts: TestContext[] = [];
afterEach(async () => {
  for (const c of contexts.splice(0)) await cleanupContext(c);
});
async function ctx(): Promise<TestContext> {
  const c = await makeContext();
  contexts.push(c);
  return c;
}

describe('integration: nonzero/negative MediaBox origin + rotation (H2-3)', () => {
  it('11-nonzero-mediabox: 裁剪框在 MediaBox 内且内容不切', async () => {
    const c = await ctx();
    const path = await copyFixture(c, '11-nonzero-mediabox.pdf');
    const before = await PDFDocument.load(await c.fs.readFile(path), { updateMetadata: false });
    const media = before.getPage(0).getMediaBox();
    expect(media.x).toBe(20); // 原点 20,30

    const result = await runCrop(c, path);
    expect(result.status).toBe('cropped');

    const out = await PDFDocument.load(await c.fs.readFile(path), { updateMetadata: false });
    const cb = out.getPage(0).getCropBox();
    // CropBox 必须在 MediaBox 内
    expect(cb.x).toBeGreaterThanOrEqual(media.x - 0.01);
    expect(cb.y).toBeGreaterThanOrEqual(media.y - 0.01);
    expect(cb.x + cb.width).toBeLessThanOrEqual(media.x + media.width + 0.01);
    expect(cb.y + cb.height).toBeLessThanOrEqual(media.y + media.height + 0.01);

    // 渲染输出，内容不触边
    const handle = await openPdf(await c.fs.readFile(path));
    const { content, width, height } = await renderAndAnalyze(handle, 1);
    expect(content).not.toBeNull();
    expect(content!.left).toBeGreaterThanOrEqual(1);
    expect(content!.bottom).toBeGreaterThanOrEqual(1);
    expect(content!.right).toBeLessThanOrEqual(width - 1);
    expect(content!.top).toBeLessThanOrEqual(height - 1);
    handle.destroy();
  });

  it('12-negative-origin-rotated: 负原点 + 旋转 90 裁剪后内容不切', async () => {
    const c = await ctx();
    const path = await copyFixture(c, '12-negative-origin-rotated.pdf');
    const before = await PDFDocument.load(await c.fs.readFile(path), { updateMetadata: false });
    const media = before.getPage(0).getMediaBox();
    expect(media.x).toBe(-20);

    const result = await runCrop(c, path);
    expect(result.status).toBe('cropped');

    const out = await PDFDocument.load(await c.fs.readFile(path), { updateMetadata: false });
    for (let i = 0; i < out.getPageCount(); i++) {
      const cb = out.getPage(i).getCropBox();
      const m = out.getPage(i).getMediaBox();
      expect(cb.x).toBeGreaterThanOrEqual(m.x - 0.01);
      expect(cb.y).toBeGreaterThanOrEqual(m.y - 0.01);
      expect(cb.x + cb.width).toBeLessThanOrEqual(m.x + m.width + 0.01);
      expect(cb.y + cb.height).toBeLessThanOrEqual(m.y + m.height + 0.01);
    }

    // 渲染输出（旋转页），内容完整不触边
    const handle = await openPdf(await c.fs.readFile(path));
    for (let p = 1; p <= 2; p++) {
      const { content, width, height } = await renderAndAnalyze(handle, p);
      expect(content, `page ${p}`).not.toBeNull();
      expect(content!.left).toBeGreaterThanOrEqual(0.5);
      expect(content!.bottom).toBeGreaterThanOrEqual(0.5);
      expect(content!.right).toBeLessThanOrEqual(width - 0.5);
      expect(content!.top).toBeLessThanOrEqual(height - 0.5);
    }
    handle.destroy();
  });
});
