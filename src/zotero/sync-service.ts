/**
 * Zotero Sync 通知（sync-service）—— 最小化（P1-4）。
 *
 * 技术调查 §2.5：Zotero 每次同步会自动比较磁盘文件 mtime/MD5 与数据库
 * （storageModTime/storageHash），文件变化即自动上传——**Sync 完全交给
 * Zotero**，插件不做任何 storage 内部调用。
 * 这里只触发公开的 notifier，刷新 UI 中的附件状态。
 */
import { log } from '../utils/logger';

export async function notifyAttachmentFileChanged(item: Zotero.Item): Promise<void> {
  try {
    Zotero.Notifier.trigger('modify', 'file', [item.id]);
    Zotero.Notifier.trigger('redraw', 'item', item.id, { column: 'hasAttachment' });
  } catch (e) {
    log.warn(`notifier failed: ${(e as Error).message}`);
  }
}
