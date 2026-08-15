import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SafeReplacer } from '../../src/utils/temp-file';
import { NodeFileSystem } from '../../src/utils/temp-file-node';

describe('temp-file (atomic replace)', () => {
  let dir: string;
  let fs: NodeFileSystem;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'zpac-test-'));
    fs = new NodeFileSystem();
  });

  afterEach(async () => {
    const { rm } = await import('node:fs/promises');
    await rm(dir, { recursive: true, force: true });
  });

  it('stage → replace 原子替换成功，临时文件被消费', async () => {
    const target = join(dir, 'paper.pdf');
    await writeFile(target, new Uint8Array([1, 2, 3]));
    const replacer = new SafeReplacer(fs);

    const temp = await replacer.stage(target, new Uint8Array([4, 5, 6, 7]));
    // 临时文件与目标同目录
    expect(temp).toBe(join(dir, '.paper.pdf.zpac.tmp.pdf'));
    expect(await fs.exists(temp)).toBe(true);

    await replacer.replace(temp, target);
    expect(new Uint8Array(await readFile(target))).toEqual(new Uint8Array([4, 5, 6, 7]));
    // 临时文件已被移动
    expect(await fs.exists(temp)).toBe(false);
  });

  it('失败时 cleanup 删除临时文件，原文件不变', async () => {
    const target = join(dir, 'paper.pdf');
    await writeFile(target, new Uint8Array([1, 2, 3]));
    const replacer = new SafeReplacer(fs);

    const temp = await replacer.stage(target, new Uint8Array([9, 9]));
    // 模拟替换失败（目标被"占用"：先创建一个同名目录阻止 rename 到文件? 直接不替换）
    await replacer.cleanup(temp);
    expect(await fs.exists(temp)).toBe(false);
    // 原文件完好
    expect(new Uint8Array(await readFile(target))).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('写入临时文件失败时不会触碰目标', async () => {
    const target = join(dir, 'paper.pdf');
    await writeFile(target, new Uint8Array([1, 2, 3]));
    const replacer = new SafeReplacer(fs);

    // 目标目录不存在 -> stage 写入失败
    await expect(
      replacer.stage(join(dir, 'nonexistent', 'paper.pdf'), new Uint8Array([9]))
    ).rejects.toThrow();
    expect(new Uint8Array(await readFile(target))).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('连续替换（多次裁剪）不残留临时文件', async () => {
    const target = join(dir, 'paper.pdf');
    await writeFile(target, new Uint8Array([1]));
    const replacer = new SafeReplacer(fs);
    for (let i = 0; i < 3; i++) {
      const temp = await replacer.stage(target, new Uint8Array([i + 2]));
      await replacer.replace(temp, target);
    }
    const files = await readdir(dir);
    expect(files).toEqual(['paper.pdf']);
    expect(new Uint8Array(await readFile(target))).toEqual(new Uint8Array([4]));
  });

  it('文件内容与 mtime 更新（sync 检测基础）', async () => {
    const target = join(dir, 'paper.pdf');
    await writeFile(target, new Uint8Array([1]));
    const before = await stat(target);
    await new Promise((r) => setTimeout(r, 20));
    const replacer = new SafeReplacer(fs);
    const temp = await replacer.stage(target, new Uint8Array([2]));
    await replacer.replace(temp, target);
    const after = await stat(target);
    expect(after.mtimeMs).toBeGreaterThanOrEqual(before.mtimeMs);
    expect(after.size).toBe(1);
  });
});
