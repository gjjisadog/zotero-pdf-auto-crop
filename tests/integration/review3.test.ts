/**
 * 第三轮 review 集成测试：
 *
 * H1-1 贴边真实内容不裁（15 照片条 / 16 色条），扫描黑边可排除（17）
 * H2-1 间接引用 CropBox（18 直接 / 19 继承）解析与恢复
 * H1-2 cropFile 稳定快照 + 快照期篡改中止（data 与 path 不再分离）
 * H1-3 restore 签名拒绝 + 替换前指纹校验（与 crop 同等保护）
 * H2-3 restore 同时比较几何与直接/继承结构状态
 * 保险   CropBox 超出 MediaBox 时最终框必须 ⊆ MediaBox
 */
import { describe, it, expect, afterEach } from 'vitest';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { join } from 'node:path';
import {
  makeContext, cleanupContext, copyFixture, openPdf, renderAndAnalyze,
  runCropFile, runRestoreFile, STD_FONTS_PATH, makeNodeCanvasBackend, type TestContext,
} from './helpers';
import { PdfWriter } from '../../src/pdf/pdf-writer';
import { CropService } from '../../src/crop/crop-service';
import type { FileSystem } from '../../src/utils/temp-file';
import { NodeFileSystem } from '../../src/utils/temp-file-node';
import { boxContains } from '../../src/crop/bounding-box';

const contexts: TestContext[] = [];
afterEach(async () => {
  for (const c of contexts.splice(0)) await cleanupContext(c);
});
async function ctx(): Promise<TestContext> {
  const c = await makeContext();
  contexts.push(c);
  return c;
}

describe('integration: 贴边真实内容不裁 / 扫描黑边可排除（H1-1）', () => {
  it('15-edge-photo: 贴边照片条保留（左侧不裁），内容不切', async () => {
    const c = await ctx();
    const path = await copyFixture(c, '15-edge-photo.pdf');
    const result = await runCropFile(c, path);
    expect(result.status).toBe('cropped');
    const writer = await PdfWriter.open(await c.fs.readFile(path));
    const m0 = writer.getPageBoxes(0);
    expect(m0.crop!.left).toBeCloseTo(m0.media.left, 2); // 左侧未裁（照片条触边）
    // 右侧白边仍被裁掉
    expect(m0.media.right - m0.crop!.right).toBeGreaterThan(20);
    // 内容不切
    const handle = await openPdf(await c.fs.readFile(path));
    for (let p = 1; p <= 2; p++) {
      const { content } = await renderAndAnalyze(handle, p);
      expect(content, `page ${p}`).not.toBeNull();
      expect(content!.left).toBeGreaterThanOrEqual(-1);
    }
    handle.destroy();
  });

  it('16-edge-color-bar: 贴边色条保留（左侧不裁），内容不切', async () => {
    const c = await ctx();
    const path = await copyFixture(c, '16-edge-color-bar.pdf');
    const result = await runCropFile(c, path);
    expect(result.status).toBe('cropped');
    const writer = await PdfWriter.open(await c.fs.readFile(path));
    const m0 = writer.getPageBoxes(0);
    expect(m0.crop!.left).toBeCloseTo(m0.media.left, 2);
    expect(m0.media.right - m0.crop!.right).toBeGreaterThan(20);
    const handle = await openPdf(await c.fs.readFile(path));
    for (let p = 1; p <= 2; p++) {
      const { content } = await renderAndAnalyze(handle, p);
      expect(content, `page ${p}`).not.toBeNull();
    }
    handle.destroy();
  });

  it('17-scan-black-border: 近黑均匀黑边（高置信度伪影）被排除裁剪', async () => {
    const c = await ctx();
    const path = await copyFixture(c, '17-scan-black-border.pdf');
    const result = await runCropFile(c, path);
    expect(result.status).toBe('cropped');
    const writer = await PdfWriter.open(await c.fs.readFile(path));
    const m0 = writer.getPageBoxes(0);
    // 黑边宽 3% = 18.36pt，裁掉的左侧应 ≥ 黑边宽度
    expect(m0.crop!.left - m0.media.left).toBeGreaterThanOrEqual(0.03 * 612 - 3);
    // 内容不切（2mm 安全边距内）
    const handle = await openPdf(await c.fs.readFile(path));
    for (let p = 1; p <= 2; p++) {
      const { content } = await renderAndAnalyze(handle, p);
      expect(content, `page ${p}`).not.toBeNull();
      expect(content!.left).toBeGreaterThanOrEqual(-1);
    }
    handle.destroy();
  });
});

describe('integration: 间接引用 CropBox（H2-1, fixtures 18/19）', () => {
  it('18-direct-indirect: 间接引用的直接 CropBox 正确解析、裁剪、恢复', async () => {
    const c = await ctx();
    const path = await copyFixture(c, '18-direct-indirect-cropbox.pdf');
    // 解析：crop = [20 20 592 772]（间接引用），direct = true
    const writer0 = await PdfWriter.open(await c.fs.readFile(path));
    expect(writer0.hasDirectCropBox(0)).toBe(true);
    expect(writer0.getPageBoxes(0).crop).toEqual({ left: 20, bottom: 20, right: 592, top: 772 });

    const result = await runCropFile(c, path);
    expect(result.status).toBe('cropped');
    const writer = await PdfWriter.open(await c.fs.readFile(path));
    const crop = writer.getPageBoxes(0).crop!;
    // 不 reveal 原可见区域外（仍 ⊆ [20 20 592 772]）
    expect(crop.left).toBeGreaterThanOrEqual(20 - 0.01);
    expect(crop.right).toBeLessThanOrEqual(592 + 0.01);

    // 恢复：原始就是 direct（间接引用）→ 恢复后仍是 direct 且几何复原
    const restored = await runRestoreFile(c, path);
    expect(restored.status).toBe('restored');
    const writer2 = await PdfWriter.open(await c.fs.readFile(path));
    expect(writer2.hasDirectCropBox(0)).toBe(true);
    expect(writer2.getPageBoxes(0).crop).toEqual({ left: 20, bottom: 20, right: 592, top: 772 });
  });

  it('19-inherited-indirect: 继承的间接 CropBox 解析正确；裁剪后恢复删除直接 CropBox', async () => {
    const c = await ctx();
    const path = await copyFixture(c, '19-inherited-indirect-cropbox.pdf');
    const writer0 = await PdfWriter.open(await c.fs.readFile(path));
    expect(writer0.hasDirectCropBox(0)).toBe(false); // 页面自身无 CropBox
    expect(writer0.hasEffectiveCropBox(0)).toBe(true); // 沿 Page Tree 继承（间接引用）
    expect(writer0.getPageBoxes(0).crop).toEqual({ left: 20, bottom: 20, right: 592, top: 772 });

    const result = await runCropFile(c, path);
    expect(result.status).toBe('cropped');
    const writer = await PdfWriter.open(await c.fs.readFile(path));
    expect(writer.hasDirectCropBox(0)).toBe(true); // 插件写入直接 CropBox
    expect(writer.getPageBoxes(0).crop!.left).toBeGreaterThanOrEqual(20 - 0.01);

    // H2-3：恢复必须删除直接 CropBox（几何可能相同，结构必须还原）
    const restored = await runRestoreFile(c, path);
    expect(restored.status).toBe('restored');
    const writer2 = await PdfWriter.open(await c.fs.readFile(path));
    expect(writer2.hasDirectCropBox(0)).toBe(false);
    expect(writer2.hasEffectiveCropBox(0)).toBe(true);
    expect(writer2.getPageBoxes(0).crop).toEqual({ left: 20, bottom: 20, right: 592, top: 772 });
  });

  it('H2-3 结构恢复：几何已一致但存在多余 direct CropBox 时仍删除', async () => {
    const c = await ctx();
    const path = await copyFixture(c, '19-inherited-indirect-cropbox.pdf');
    await runCropFile(c, path);
    // 把直接 CropBox 改回与原始可见区域完全相同的值（几何一致、结构不同）
    const writer = await PdfWriter.open(await c.fs.readFile(path));
    writer.setPageCrop(0, { left: 20, bottom: 20, right: 592, top: 772 });
    writer.setPageCrop(1, { left: 20, bottom: 20, right: 592, top: 772 });
    await c.fs.writeFile(path, await writer.save());
    expect((await PdfWriter.open(await c.fs.readFile(path))).hasDirectCropBox(0)).toBe(true);

    const restored = await runRestoreFile(c, path);
    expect(restored.status).toBe('restored');
    const writer2 = await PdfWriter.open(await c.fs.readFile(path));
    expect(writer2.hasDirectCropBox(0)).toBe(false); // 多余 direct 被删除
    expect(writer2.getPageBoxes(0).crop).toEqual({ left: 20, bottom: 20, right: 592, top: 772 });
  });
});

describe('integration: cropFile 稳定快照（H1-2）', () => {
  it('生产路径 cropFile：裁剪成功，重复裁剪幂等（no-change）', async () => {
    const c = await ctx();
    const path = await copyFixture(c, '01-normal-paper.pdf');
    const first = await runCropFile(c, path);
    expect(first.status).toBe('cropped');
    expect(first.changedPageCount).toBeGreaterThan(0);
    const second = await runCropFile(c, path);
    expect(second.status).toBe('no-change');
  });

  it('快照读取期间文件被改写 → source-changed，不覆盖新版本', async () => {
    const c = await ctx();
    const path = await copyFixture(c, '01-normal-paper.pdf');
    const original = new Uint8Array(await c.fs.readFile(path));
    const base = new NodeFileSystem();
    let readOnce = false;
    const tamperFs: FileSystem = {
      readFile: async (p) => {
        const data = await base.readFile(p);
        if (!readOnce) {
          readOnce = true;
          // 模拟外部程序在读取后立刻改写文件
          await base.writeFile(p, new Uint8Array([...data, 1, 2, 3]));
        }
        return data;
      },
      writeFile: (p, d) => base.writeFile(p, d),
      moveReplace: (s, d) => base.moveReplace(s, d),
      remove: (p) => base.remove(p),
      exists: (p) => base.exists(p),
      stat: (p) => base.stat(p),
    };
    const service = new CropService();
    await expect(
      service.cropFile({
        targetPath: path,
        fs: tamperFs,
        pdfOptions: {
          standardFontDataUrl: STD_FONTS_PATH,
          canvasBackend: makeNodeCanvasBackend(),
        },
        config: { requireEmbeddedFonts: false },
      })
    ).rejects.toMatchObject({ kind: 'source-changed' });
    // 文件仍是外部写入的版本（不是裁剪输出，也不是旧版本被覆盖）
    const after = new Uint8Array(await c.fs.readFile(path));
    expect(after.length).toBe(original.length + 3);
    expect(after.slice(0, original.length)).toEqual(original);
  });
});

describe('integration: restore 数据安全（H1-3）', () => {
  it('已签名 PDF 拒绝恢复（/ByteRange），文件不变', async () => {
    const c = await ctx();
    const path = await copyFixture(c, '01-normal-paper.pdf');
    const base = new Uint8Array(await c.fs.readFile(path));
    // 追加 /ByteRange（模拟签名；pdf-lib 不解析 EOF 之后的内容）
    const signed = new Uint8Array([...base, ...new TextEncoder().encode('\n/ByteRange [0 10]\n%%EOF\n')]);
    await c.fs.writeFile(path, signed);
    const service = new CropService();
    await expect(
      service.restoreFile({
        targetPath: path,
        fs: c.fs,
        pdfOptions: {
          standardFontDataUrl: STD_FONTS_PATH,
          canvasBackend: makeNodeCanvasBackend(),
        },
      })
    ).rejects.toMatchObject({ kind: 'signed' });
    expect(new Uint8Array(await c.fs.readFile(path))).toEqual(signed);
  });

  it('恢复替换前源文件被修改 → source-changed，文件不变', async () => {
    const c = await ctx();
    const path = await copyFixture(c, '01-normal-paper.pdf');
    await runCropFile(c, path);
    const cropped = new Uint8Array(await c.fs.readFile(path));
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
        if (statCalls >= 2) return { ...s, lastModified: s.lastModified + 5000 };
        return s;
      },
    };
    const service = new CropService();
    await expect(
      service.restorePdf({
        data: cropped,
        targetPath: path,
        fs: tamperedFs,
        pdfOptions: {
          standardFontDataUrl: STD_FONTS_PATH,
          canvasBackend: makeNodeCanvasBackend(),
        },
      })
    ).rejects.toMatchObject({ kind: 'source-changed' });
    expect(new Uint8Array(await c.fs.readFile(path))).toEqual(cropped);
  });
});

describe('integration: 保险——CropBox 超出 MediaBox 的不规范 PDF', () => {
  it('裁剪后最终 CropBox 必须 ⊆ MediaBox（不 reveal 原来看不到的内容）', async () => {
    const c = await ctx();
    const path = join(c.dir, 'out-of-media.pdf');
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([612, 792]);
    // CropBox 明显超出 MediaBox（左/右/下/上各外扩 50pt）
    page.setMediaBox(0, 0, 612, 792);
    page.setCropBox(-50, -50, 712, 892);
    page.drawText('Out of media box title', { x: 80, y: 700, size: 16, font, color: rgb(0.1, 0.1, 0.1) });
    for (let i = 0; i < 18; i++) {
      page.drawText(`Line ${i + 1}: lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt.`,
        { x: 80, y: 660 - i * 14, size: 10, font, color: rgb(0.1, 0.1, 0.1), maxWidth: 450 });
    }
    await c.fs.writeFile(path, new Uint8Array(await doc.save()));

    const result = await runCropFile(c, path);
    expect(['cropped', 'no-change']).toContain(result.status);

    const writer = await PdfWriter.open(await c.fs.readFile(path));
    const boxes = writer.getPageBoxes(0);
    expect(boxes.crop).not.toBeNull();
    // 保险：最终框 ⊆ MediaBox
    expect(boxContains(boxes.media, boxes.crop!)).toBe(true);
  });
});
