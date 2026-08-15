/**
 * Zotero Sync 通知（sync-service）。
 *
 * 技术调查 §2.5：Zotero 每次同步都会自动比较磁盘文件 mtime/MD5 与数据库
 * （storageModTime/storageHash），文件变化即自动上传——插件无需（也不应）
 * 手动写同步状态。这里做两件增强：
 * 1. 触发 'modify'/'file' notifier，刷新 UI 中的附件状态；
 * 2. 调用公开的 checkForUpdatedFiles 立即把该附件标记为待上传，
 *    让「下次同步直接上传」而不是等待文件监视器全量扫描。
 */
import { log } from '../utils/logger';

export async function notifyAttachmentFileChanged(item: Zotero.Item): Promise<void> {
  try {
    Zotero.Notifier.trigger('modify', 'file', [item.id]);
    Zotero.Notifier.trigger('redraw', 'item', item.id, { column: 'hasAttachment' });
  } catch (e) {
    log.warn(`notifier failed: ${(e as Error).message}`);
  }
  try {
    // 公开 API：立即把该附件标记为待上传（供下次 sync 上传新版本）
    await Zotero.Sync.Storage.Local.checkForUpdatedFiles(item.libraryID, [item.id]);
    log.debug(`attachment ${item.libraryKey} marked for sync upload`);
  } catch (e) {
    // 失败不影响正确性：正常 sync 的 checkForUpdatedFiles 也会检测到变化
    log.warn(`checkForUpdatedFiles failed: ${(e as Error).message}`);
  }
}
