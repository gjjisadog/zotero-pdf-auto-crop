/**
 * PDF 文件事务层（file-transaction）—— 裁剪/恢复/未来批量的共同数据安全底座
 * （H1-2 / H1-3）。
 *
 * 解决的问题：处理前后源文件可能被 Zotero Sync / Dropbox / 外部编辑器改写。
 * 绝对不能让「旧的 data」与「新的 targetPath」同时进入替换环节：
 *
 *   acquireStableSnapshot():
 *     stat1 → read → stat2；stat1 与 stat2 不一致 → 中止（读到的字节与
 *     将要替换的目标不是同一版本，宁可取消也不覆盖）。
 *
 *   atomicReplace():
 *     写同目录临时文件 → assertSourceUnchanged（替换前再验一次指纹）→
 *     单次原子替换。任一步失败：临时文件清理，原文件完全不变。
 *
 * cropPdf / restorePdf 传入显式 data 时（测试/批处理注入），由调用方
 * 提供 knownSourceStat（或本层在替换前自取一次 stat），保证替换前校验
 * 始终存在——校验逻辑只有一份，两条入口行为一致。
 */
import type { FileSystem, FileStats } from '../utils/temp-file';
import { SafeReplacer } from '../utils/temp-file';
import { CropError } from './crop-error';

export interface StableSnapshot {
  /** 与 stat 严格对应的文件字节（已复制到当前 realm） */
  data: Uint8Array;
  stat: FileStats;
}

export class PdfFileTransaction {
  private readonly replacer: SafeReplacer;

  constructor(
    private readonly fs: FileSystem,
    private readonly targetPath: string
  ) {
    // 注意：字段初始化器在参数属性赋值之前执行，replacer 必须在构造体内创建
    this.replacer = new SafeReplacer(fs);
  }

  /**
   * 稳定快照：stat → read → stat 复检。
   * 读取前后指纹不一致 → 源文件正在被其他程序修改，抛 source-changed。
   */
  async acquireStableSnapshot(): Promise<StableSnapshot> {
    let stat1: FileStats;
    try {
      stat1 = await this.fs.stat(this.targetPath);
    } catch (e) {
      throw new CropError('io', '无法读取原 PDF 文件状态。', e);
    }
    let data: Uint8Array;
    try {
      data = await this.fs.readFile(this.targetPath);
    } catch (e) {
      throw new CropError('io', '无法读取原 PDF 文件。', e);
    }
    const stat2 = await this.fs.stat(this.targetPath);
    if (stat2.size !== stat1.size || stat2.lastModified !== stat1.lastModified) {
      throw new CropError(
        'source-changed',
        '读取 PDF 期间文件正在被其他程序修改，为避免覆盖新版本，本次操作已取消。原文件未做修改。'
      );
    }
    return { data: new Uint8Array(data), stat: stat2 };
  }

  /** 替换前校验：源文件指纹必须与快照一致（size + mtime） */
  async assertSourceUnchanged(stat: FileStats): Promise<void> {
    try {
      const now = await this.fs.stat(this.targetPath);
      if (now.size !== stat.size || now.lastModified !== stat.lastModified) {
        throw new CropError(
          'source-changed',
          '处理期间 PDF 已被其他程序修改，为避免覆盖新版本，本次操作已取消。原文件未做修改。'
        );
      }
    } catch (e) {
      if (e instanceof CropError) throw e;
      throw new CropError('io', '替换前校验源文件失败，原文件未做任何修改。', e);
    }
  }

  /**
   * 原子替换：写临时文件 → 校验源未变 → 单次 move 替换。
   * 任何一步失败：清理临时文件，原文件保持原样。
   */
  async atomicReplace(outBytes: Uint8Array, stat: FileStats): Promise<void> {
    let tempPath: string;
    try {
      tempPath = await this.replacer.stage(this.targetPath, outBytes);
    } catch (e) {
      throw new CropError('io', '写入临时文件失败，原文件未做任何修改。', e);
    }
    try {
      await this.assertSourceUnchanged(stat);
    } catch (e) {
      await this.replacer.cleanup(tempPath);
      throw e;
    }
    try {
      await this.replacer.replace(tempPath, this.targetPath);
    } catch (e) {
      await this.replacer.cleanup(tempPath);
      throw new CropError('io', '替换原文件失败，原文件未做任何修改。', e);
    }
  }
}
