/**
 * Node 文件系统实现（仅测试/开发用；不进入插件 bundle）。
 */
import type { FileSystem, FileStats } from './temp-file';

export class NodeFileSystem implements FileSystem {
  async readFile(path: string): Promise<Uint8Array> {
    const { readFile } = await import('node:fs/promises');
    return new Uint8Array(await readFile(path));
  }
  async writeFile(path: string, data: Uint8Array): Promise<void> {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path, data);
  }
  async moveReplace(src: string, dest: string): Promise<void> {
    const { rename } = await import('node:fs/promises');
    await rename(src, dest); // POSIX 与 Windows NTFS 下同卷 rename 均为原子覆盖
  }
  async remove(path: string): Promise<void> {
    const { rm } = await import('node:fs/promises');
    await rm(path, { force: true });
  }
  async exists(path: string): Promise<boolean> {
    const { access } = await import('node:fs/promises');
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  }
  async stat(path: string): Promise<FileStats> {
    const { stat } = await import('node:fs/promises');
    const s = await stat(path);
    return { size: s.size, lastModified: s.mtimeMs };
  }
}
