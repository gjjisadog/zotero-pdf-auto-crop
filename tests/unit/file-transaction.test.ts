/**
 * PdfFileTransaction 单元测试（H1-2 / H1-3 事务层）：
 * - 稳定快照：stat→read→stat 复检，读取期间指纹变化 → source-changed
 * - 原子替换：临时文件 → 指纹校验 → 单次 move；任一步失败原文件不变
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PdfFileTransaction } from '../../src/crop/file-transaction';
import { NodeFileSystem } from '../../src/utils/temp-file-node';
import type { FileSystem } from '../../src/utils/temp-file';

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
async function makeDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'zpac-tx-'));
  dirs.push(d);
  return d;
}

describe('file-transaction: acquireStableSnapshot', () => {
  it('返回与 stat 一致的稳定字节', async () => {
    const dir = await makeDir();
    const path = join(dir, 'a.pdf');
    const bytes = new Uint8Array([1, 2, 3, 4]);
    await writeFile(path, bytes);
    const txn = new PdfFileTransaction(new NodeFileSystem(), path);
    const snap = await txn.acquireStableSnapshot();
    expect([...snap.data]).toEqual([1, 2, 3, 4]);
    expect(snap.stat.size).toBe(4);
  });

  it('读取期间源文件指纹变化 → source-changed，不返回数据', async () => {
    const dir = await makeDir();
    const path = join(dir, 'b.pdf');
    await writeFile(path, new Uint8Array([1, 2, 3]));
    // readFile 返回旧字节后立刻改写文件（模拟外部程序写入）
    const base = new NodeFileSystem();
    const tamperFs: FileSystem = {
      readFile: async (p) => {
        const data = await base.readFile(p);
        await base.writeFile(p, new Uint8Array([1, 2, 3, 4, 5]));
        return data;
      },
      writeFile: (p, d) => base.writeFile(p, d),
      moveReplace: (s, d) => base.moveReplace(s, d),
      remove: (p) => base.remove(p),
      exists: (p) => base.exists(p),
      stat: (p) => base.stat(p),
    };
    const txn = new PdfFileTransaction(tamperFs, path);
    await expect(txn.acquireStableSnapshot()).rejects.toMatchObject({ kind: 'source-changed' });
  });

  it('读取失败 → io', async () => {
    const txn = new PdfFileTransaction(new NodeFileSystem(), join(await makeDir(), 'missing.pdf'));
    await expect(txn.acquireStableSnapshot()).rejects.toMatchObject({ kind: 'io' });
  });
});

describe('file-transaction: atomicReplace', () => {
  it('成功：替换目标为输出字节', async () => {
    const dir = await makeDir();
    const path = join(dir, 'c.pdf');
    await writeFile(path, new Uint8Array([9, 9]));
    const fs = new NodeFileSystem();
    const stat = await fs.stat(path);
    const txn = new PdfFileTransaction(fs, path);
    await txn.atomicReplace(new Uint8Array([1, 2, 3]), stat);
    expect([...(await readFile(path))]).toEqual([1, 2, 3]);
    // 临时文件已清理
    expect(await readFile(join(dir, '.c.pdf.zpac.tmp.pdf')).catch(() => null)).toBeNull();
  });

  it('替换前源文件指纹变化 → source-changed，原文件不变、临时文件清理', async () => {
    const dir = await makeDir();
    const path = join(dir, 'd.pdf');
    await writeFile(path, new Uint8Array([9, 9]));
    const base = new NodeFileSystem();
    const stat = await base.stat(path);
    let statCalls = 0;
    const tamperFs: FileSystem = {
      readFile: (p) => base.readFile(p),
      writeFile: (p, d) => base.writeFile(p, d),
      moveReplace: (s, d) => base.moveReplace(s, d),
      remove: (p) => base.remove(p),
      exists: (p) => base.exists(p),
      stat: async (p) => {
        statCalls++;
        const s = await base.stat(p);
        // 第一次经 tamperFs 的 stat = 替换前校验（初始 stat 直接走 base）：
        // 模拟文件被外部改写
        if (statCalls >= 1) return { ...s, lastModified: s.lastModified + 5000 };
        return s;
      },
    };
    const txn = new PdfFileTransaction(tamperFs, path);
    await expect(txn.atomicReplace(new Uint8Array([1, 2, 3]), stat)).rejects.toMatchObject({ kind: 'source-changed' });
    expect([...(await readFile(path))]).toEqual([9, 9]); // 原文件不变
    expect(await readFile(join(dir, '.d.pdf.zpac.tmp.pdf')).catch(() => null)).toBeNull(); // 临时清理
  });

  it('替换失败 → io，原文件不变、临时文件清理', async () => {
    const dir = await makeDir();
    const path = join(dir, 'e.pdf');
    await writeFile(path, new Uint8Array([9, 9]));
    const base = new NodeFileSystem();
    const stat = await base.stat(path);
    let removed = false;
    const failFs: FileSystem = {
      readFile: (p) => base.readFile(p),
      writeFile: (p, d) => base.writeFile(p, d),
      moveReplace: async () => {
        throw new Error('target locked');
      },
      remove: async (p) => {
        removed = true;
        await base.remove(p);
      },
      exists: (p) => base.exists(p),
      stat: (p) => base.stat(p),
    };
    const txn = new PdfFileTransaction(failFs, path);
    await expect(txn.atomicReplace(new Uint8Array([1, 2, 3]), stat)).rejects.toMatchObject({ kind: 'io' });
    expect([...(await readFile(path))]).toEqual([9, 9]);
    expect(removed).toBe(true);
  });
});
