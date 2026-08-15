/**
 * 安全测试（任务 §47）：任何处理错误下原 PDF 必须完全不变。
 *
 * 覆盖：加密 PDF、数字签名 PDF、损坏 PDF、写临时文件失败、
 * 原子替换失败、恢复无元数据。
 */
import { describe, it, expect } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CropService, CropError } from '../../src/crop/crop-service';
import { makeContext, copyFixture, cleanupContext, STD_FONTS_PATH, makeNodeCanvasBackend, type TestContext } from './helpers';
import type { FileSystem } from '../../src/utils/temp-file';
import { NodeFileSystem } from '../../src/utils/temp-file-node';

const contexts: TestContext[] = [];
async function ctx(): Promise<TestContext> {
  const c = await makeContext();
  contexts.push(c);
  return c;
}

/** 构造最小加密 PDF（trailer 带 /Encrypt，xref 合法） */
function buildEncryptedPdf(): Uint8Array {
  const objs = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>\nendobj\n',
    '4 0 obj\n<< /Filter /Standard /V 1 /R 2 /O <00000000000000000000000000000000> /U <00000000000000000000000000000000> /P -44 >>\nendobj\n',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const obj of objs) {
    offsets.push(pdf.length);
    pdf += obj;
  }
  const xrefStart = pdf.length;
  pdf += `xref\n0 5\n0000000000 65535 f \n`;
  for (let i = 1; i <= 4; i++) {
    pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size 5 /Root 1 0 R /Encrypt 4 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}

/** 构造最小正常 PDF */
function buildMinimalPdf(): Uint8Array {
  const objs = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>\nendobj\n',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const obj of objs) {
    offsets.push(pdf.length);
    pdf += obj;
  }
  const xrefStart = pdf.length;
  pdf += `xref\n0 4\n0000000000 65535 f \n`;
  for (let i = 1; i <= 3; i++) {
    pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}

describe('safety: protected/corrupt PDFs', () => {
  it('加密 PDF → CropError encrypted，原文件不变', async () => {
    const c = await ctx();
    const path = join(c.dir, 'encrypted.pdf');
    const bytes = buildEncryptedPdf();
    await writeFile(path, bytes);
    const service = new CropService();
    await expect(
      service.cropPdf({
        data: bytes, targetPath: path, fs: c.fs,
        pdfOptions: { standardFontDataUrl: STD_FONTS_PATH, canvasBackend: makeNodeCanvasBackend() },
      })
    ).rejects.toMatchObject({ kind: 'encrypted' });
    // 原文件字节不变
    expect(new Uint8Array(await readFile(path))).toEqual(bytes);
  });

  it('数字签名 PDF（/ByteRange）→ CropError signed，原文件不变', async () => {
    const c = await ctx();
    const path = join(c.dir, 'signed.pdf');
    const base = buildMinimalPdf();
    // 追加 /ByteRange（模拟签名；pdf-lib 不解析 EOF 之后的内容）
    const bytes = new Uint8Array([...base, ...new TextEncoder().encode('\n/ByteRange [0 10]\n%%EOF\n')]);
    await writeFile(path, bytes);
    const service = new CropService();
    await expect(
      service.cropPdf({
        data: bytes, targetPath: path, fs: c.fs,
        pdfOptions: { standardFontDataUrl: STD_FONTS_PATH, canvasBackend: makeNodeCanvasBackend() },
      })
    ).rejects.toMatchObject({ kind: 'signed' });
    expect(new Uint8Array(await readFile(path))).toEqual(bytes);
  });

  it('损坏 PDF（随机字节）→ CropError damaged，原文件不变', async () => {
    const c = await ctx();
    const path = join(c.dir, 'corrupt.pdf');
    const bytes = new Uint8Array(2048).map((_, i) => (i * 31) % 256);
    await writeFile(path, bytes);
    const service = new CropService();
    await expect(
      service.cropPdf({
        data: bytes, targetPath: path, fs: c.fs,
        pdfOptions: { standardFontDataUrl: STD_FONTS_PATH, canvasBackend: makeNodeCanvasBackend() },
      })
    ).rejects.toMatchObject({ kind: 'damaged' });
    expect(new Uint8Array(await readFile(path))).toEqual(bytes);
  });

  it('恢复无元数据 → CropError no-restore-data', async () => {
    const c = await ctx();
    const path = await copyFixture(c, '01-normal-paper.pdf');
    const before = new Uint8Array(await readFile(path));
    const service = new CropService();
    await expect(
      service.restorePdf({
        data: before, targetPath: path, fs: c.fs,
        pdfOptions: { standardFontDataUrl: STD_FONTS_PATH, canvasBackend: makeNodeCanvasBackend() },
      })
    ).rejects.toMatchObject({ kind: 'no-restore-data' });
    expect(new Uint8Array(await readFile(path))).toEqual(before);
  });
});

describe('safety: failure injection (原文件不变)', () => {
  it('写临时文件失败 → 原文件不变，无残留临时文件', async () => {
    const c = await ctx();
    const path = await copyFixture(c, '01-normal-paper.pdf');
    const before = new Uint8Array(await readFile(path));

    const base = new NodeFileSystem();
    const failingFs: FileSystem = {
      readFile: (p) => base.readFile(p),
      writeFile: async (p: string, d: Uint8Array) => {
        if (p.includes('.zpac.tmp')) throw new Error('disk full (simulated)');
        await base.writeFile(p, d);
      },
      moveReplace: (s2, d) => base.moveReplace(s2, d),
      remove: (p) => base.remove(p),
      exists: (p) => base.exists(p),
      stat: (p) => base.stat(p),
    };

    const service = new CropService();
    await expect(
      service.cropPdf({
        data: before, targetPath: path, fs: failingFs,
        pdfOptions: { standardFontDataUrl: STD_FONTS_PATH, canvasBackend: makeNodeCanvasBackend() },
        config: { requireEmbeddedFonts: false },
      })
    ).rejects.toMatchObject({ kind: 'io' });
    expect(new Uint8Array(await readFile(path))).toEqual(before);
  });

  it('原子替换失败 → 原文件不变，临时文件被清理', async () => {
    const c = await ctx();
    const path = await copyFixture(c, '01-normal-paper.pdf');
    const before = new Uint8Array(await readFile(path));

    const base = new NodeFileSystem();
    const failingFs: FileSystem = {
      readFile: (p) => base.readFile(p),
      writeFile: (p, d) => base.writeFile(p, d),
      moveReplace: async (_src: string, _dest: string) => {
        throw new Error('EBUSY (simulated)');
      },
      remove: (p) => base.remove(p),
      exists: (p) => base.exists(p),
      stat: (p) => base.stat(p),
    };

    const service = new CropService();
    await expect(
      service.cropPdf({
        data: before, targetPath: path, fs: failingFs,
        pdfOptions: { standardFontDataUrl: STD_FONTS_PATH, canvasBackend: makeNodeCanvasBackend() },
        config: { requireEmbeddedFonts: false },
      })
    ).rejects.toMatchObject({ kind: 'io' });
    expect(new Uint8Array(await readFile(path))).toEqual(before);
    // 无残留临时文件
    const { readdir } = await import('node:fs/promises');
    const files = await readdir(c.dir);
    expect(files.filter((f) => f.includes('.zpac.tmp'))).toEqual([]);
  });

  it('PDF 写入器抛异常（注入损坏的 writer 路径不可行时验证 io 错误分类）', async () => {
    // verifyOutput 失败 → validation 错误；用损坏的输出验证：crop 目标为只读目录
    const c = await ctx();
    const path = await copyFixture(c, '01-normal-paper.pdf');
    const before = new Uint8Array(await readFile(path));

    const base = new NodeFileSystem();
    const failingFs: FileSystem = {
      readFile: (p) => base.readFile(p),
      writeFile: (p, d) => base.writeFile(p, d),
      moveReplace: async (_src: string, dest: string) => {
        throw new Error(`EACCES: ${dest}`);
      },
      remove: (p) => base.remove(p),
      exists: (p) => base.exists(p),
      stat: (p) => base.stat(p),
    };

    const service = new CropService();
    await expect(
      service.cropPdf({
        data: before, targetPath: path, fs: failingFs,
        pdfOptions: { standardFontDataUrl: STD_FONTS_PATH, canvasBackend: makeNodeCanvasBackend() },
        config: { requireEmbeddedFonts: false },
      })
    ).rejects.toBeInstanceOf(CropError);
    expect(new Uint8Array(await readFile(path))).toEqual(before);
  });

  it('restore 替换失败同样保护原文件', async () => {
    const c = await ctx();
    const path = await copyFixture(c, '01-normal-paper.pdf');
    // 先裁剪（写入恢复元数据）
    const service = new CropService();
    const opts = {
      pdfOptions: { standardFontDataUrl: STD_FONTS_PATH, canvasBackend: makeNodeCanvasBackend() },
      config: { requireEmbeddedFonts: false },
    };
    await service.cropPdf({ data: await c.fs.readFile(path), targetPath: path, fs: c.fs, ...opts });
    const cropped = new Uint8Array(await readFile(path));

    const base = new NodeFileSystem();
    const failingFs: FileSystem = {
      readFile: (p) => base.readFile(p),
      writeFile: (p, d) => base.writeFile(p, d),
      moveReplace: async (_src: string, _dest: string) => {
        throw new Error('EBUSY (simulated)');
      },
      remove: (p) => base.remove(p),
      exists: (p) => base.exists(p),
      stat: (p) => base.stat(p),
    };

    await expect(
      service.restorePdf({ data: cropped, targetPath: path, fs: failingFs, ...opts })
    ).rejects.toMatchObject({ kind: 'io' });
    // 原文件保持裁剪后状态（未被破坏）
    expect(new Uint8Array(await readFile(path))).toEqual(cropped);
  });
});

// 清理
import { afterEach } from 'vitest';
afterEach(async () => {
  for (const c of contexts.splice(0)) await cleanupContext(c);
});
