/**
 * 临时文件与原子替换（temp-file）。
 *
 * 流程（任务 §24–§25）：写入同目录临时文件 → 校验 → 原子替换原文件。
 * 任何一步失败：原文件完全不变，临时文件被清理。
 *
 * 文件系统抽象为接口：Node（测试）用 temp-file-node.ts 的 NodeFileSystem，
 * Zotero 用本文件的 ZoteroFileSystem（IOUtils）。
 * 临时文件与目标文件必须在同一目录（保证 rename 的原子性）。
 */

export interface FileStats {
  size: number;
  lastModified: number;
}

export interface FileSystem {
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
  /** 原子替换：用 src 覆盖 dest（同目录 rename）；若目标存在则覆盖 */
  moveReplace(src: string, dest: string): Promise<void>;
  remove(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  stat(path: string): Promise<FileStats>;
}

/** Zotero 实现（IOUtils） */
export class ZoteroFileSystem implements FileSystem {
  async readFile(path: string): Promise<Uint8Array> {
    return IOUtils.read(path);
  }
  async writeFile(path: string, data: Uint8Array): Promise<void> {
    await IOUtils.write(path, data);
  }
  async moveReplace(src: string, dest: string): Promise<void> {
    try {
      await IOUtils.move(src, dest, { noOverwrite: false });
    } catch (e) {
      // Windows：目标被占用时 IOUtils.move 可能失败；尝试删除后移动
      if (await IOUtils.exists(dest)) {
        await IOUtils.remove(dest, { ignoreAbsent: true });
      }
      await IOUtils.move(src, dest, { noOverwrite: false });
    }
  }
  async remove(path: string): Promise<void> {
    await IOUtils.remove(path, { ignoreAbsent: true });
  }
  async exists(path: string): Promise<boolean> {
    return IOUtils.exists(path);
  }
  async stat(path: string): Promise<FileStats> {
    const s = await IOUtils.stat(path);
    return { size: s.size, lastModified: s.lastModified };
  }
}

/** 安全替换编排 */
export class SafeReplacer {
  constructor(private readonly fs: FileSystem) {}

  /** 生成同目录临时文件路径 */
  static tempPathFor(targetPath: string): string {
    const dir = targetPath.includes('/') ? targetPath.slice(0, targetPath.lastIndexOf('/')) : '.';
    const base = targetPath.slice(targetPath.lastIndexOf('/') + 1);
    return `${dir}/.${base}.zpac.tmp.pdf`;
  }

  /**
   * 原子替换：data 写入临时文件 → 调用方校验 → 替换。
   * 返回目标路径；调用方负责在失败时调用 cleanup。
   */
  async stage(targetPath: string, data: Uint8Array): Promise<string> {
    const tempPath = SafeReplacer.tempPathFor(targetPath);
    await this.fs.writeFile(tempPath, data);
    return tempPath;
  }

  async replace(tempPath: string, targetPath: string): Promise<void> {
    await this.fs.moveReplace(tempPath, targetPath);
  }

  async cleanup(tempPath: string): Promise<void> {
    try {
      await this.fs.remove(tempPath);
    } catch {
      // 清理失败不阻断主流程
    }
  }
}
