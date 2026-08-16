/**
 * 第二轮 review 集成测试：
 * - H2-1：继承的 CropBox（fixture 13）——裁剪不 reveal 继承区域外，恢复删除直接 CropBox
 * - H2-2：同尺寸不同 MediaBox 原点（fixture 14）——同组稳定化不误判、不切内容
 * - H1：处理期间源文件被修改 → 取消替换，原文件不变
 */
import { describe, it, expect, afterEach } from 'vitest';
import { PDFDocument, PDFName, PDFArray } from 'pdf-lib';
import {
  makeContext, cleanupContext, copyFixture, runCrop, runRestore, openPdf,
  renderAndAnalyze, type TestContext,
} from './helpers';
import { CropService } from '../../src/crop/crop-service';
import type { FileSystem } from '../../src/utils/temp-file';
import { NodeFileSystem } from '../../src/utils/temp-file-node';

const contexts: TestContext[] = [];
afterEach(async () => {
  for (const c of contexts.splice(0)) await cleanupContext(c);
});
async function ctx(): Promise<TestContext> {
  const c = await makeContext();
  contexts.push(c);
  return c;
}

describe('integration: inherited CropBox (H2-1, fixture 13)', () => {
  it('裁剪不越出继承的 CropBox；恢复后删除直接 CropBox 恢复继承', async () => {
    const c = await ctx();
    const path = await copyFixture(c, '13-inherited-cropbox.pdf');

    const result = await runCrop(c, path);
    expect(result.status).toBe('cropped');

    const out = await PDFDocument.load(await c.fs.readFile(path), { updateMetadata: false });
    const node = (out.getPage(0) as any).node;
    // 裁剪后：直接 CropBox 存在且 ⊆ 继承区域 [20 20 592 772]
    const direct = node.get(PDFName.of('CropBox'));
    expect(direct).toBeInstanceOf(PDFArray);
    const rect = direct.asRectangle();
    expect(rect.x).toBeGreaterThanOrEqual(20 - 0.01);
    expect(rect.y).toBeGreaterThanOrEqual(20 - 0.01);
    expect(rect.x + rect.width).toBeLessThanOrEqual(592 + 0.01);
    expect(rect.y + rect.height).toBeLessThanOrEqual(772 + 0.01);
    // 内容不切
    const handle = await openPdf(await c.fs.readFile(path));
    const { content, width, height } = await renderAndAnalyze(handle, 1);
    expect(content).not.toBeNull();
    expect(content!.left).toBeGreaterThanOrEqual(1);
    expect(content!.right).toBeLessThanOrEqual(width - 1);
    expect(content!.top).toBeLessThanOrEqual(height - 1);
    handle.destroy();

    // 恢复：删除直接 CropBox → 重新继承父节点 [20 20 592 772]
    const restored = await runRestore(c, path);
    expect(restored.status).toBe('restored');
    const after = await PDFDocument.load(await c.fs.readFile(path), { updateMetadata: false });
    const node2 = (after.getPage(0) as any).node;
    expect(node2.get(PDFName.of('CropBox'))).toBeUndefined();
    const eff = after.getPage(0).getCropBox();
    expect(eff.x).toBe(20);
    expect(eff.width).toBe(572);
  });
});

describe('integration: same size, different MediaBox origin (H2-2, fixture 14)', () => {
  it('两页同组稳定化：各自裁剪、互不误判、内容不切', async () => {
    const c = await ctx();
    const path = await copyFixture(c, '14-mixed-mediabox-origin-same-size.pdf');

    const result = await runCrop(c, path);
    expect(result.status).toBe('cropped');
    // 两页都裁剪（不因 origin 差异误判为 outlier）
    expect(result.changedPageCount).toBe(2);

    const out = await PDFDocument.load(await c.fs.readFile(path), { updateMetadata: false });
    const p0 = out.getPage(0);
    const p1 = out.getPage(1);
    const m0 = p0.getMediaBox(), c0 = p0.getCropBox();
    const m1 = p1.getMediaBox(), c1 = p1.getCropBox();
    // CropBox 在各自 MediaBox 内
    expect(c0.x).toBeGreaterThanOrEqual(m0.x - 0.01);
    expect(c1.x).toBeGreaterThanOrEqual(m1.x - 0.01);
    // display-local 一致：内容相对各自原点偏移相同 → 裁剪框相对原点偏移相同
    expect(c0.x - m0.x).toBeCloseTo(c1.x - m1.x, 2);
    expect(c0.y - m0.y).toBeCloseTo(c1.y - m1.y, 2);
    expect(c0.width).toBeCloseTo(c1.width, 2);
    expect(c0.height).toBeCloseTo(c1.height, 2);

    // 内容不切
    const handle = await openPdf(await c.fs.readFile(path));
    for (let p = 1; p <= 2; p++) {
      const { content, width, height } = await renderAndAnalyze(handle, p);
      expect(content, `page ${p}`).not.toBeNull();
      expect(content!.left).toBeGreaterThanOrEqual(1);
      expect(content!.right).toBeLessThanOrEqual(width - 1);
      expect(content!.top).toBeLessThanOrEqual(height - 1);
    }
    handle.destroy();
  });
});

describe('integration: source modified during processing (H1)', () => {
  it('分析期间源文件被修改 → source-changed 取消，原文件不变', async () => {
    const c = await ctx();
    const path = await copyFixture(c, '01-normal-paper.pdf');
    const original = new Uint8Array(await c.fs.readFile(path));

    // 注入 fs：stat 第二次调用返回不同的 mtime（模拟处理期间文件被外部修改）
    const base = new NodeFileSystem();
    let statCalls = 0;
    const tamperedFs: FileSystem = {
      readFile: (p) => base.readFile(p),
      writeFile: (p, d) => base.writeFile(p, d),
      moveReplace: (s, d) => base.moveReplace(s, d),
      remove: (p) => base.remove(p),
      exists: (p) => base.exists(p),
      stat: async (p) => {
        statCalls++;
        const s = await base.stat(p);
        // 第二次调用 = 替换前校验：模拟其他程序改写了文件
        if (statCalls >= 2) {
          return { ...s, lastModified: s.lastModified + 5000 };
        }
        return s;
      },
    };

    const service = new CropService();
    await expect(
      service.cropPdf({
        data: original,
        targetPath: path,
        fs: tamperedFs,
        pdfOptions: {
          standardFontDataUrl: '/Users/wangxuwen/Zotero PDF Auto Crop/node_modules/pdfjs-dist/standard_fonts/',
          canvasBackend: {
            createCanvas(w: number, h: number) {
              const { createCanvas } = require('@napi-rs/canvas');
              return createCanvas(w, h);
            },
          },
        },
        config: { requireEmbeddedFonts: false },
      })
    ).rejects.toMatchObject({ kind: 'source-changed' });
    // 原文件完全不变
    expect(new Uint8Array(await c.fs.readFile(path))).toEqual(original);
  });
});
