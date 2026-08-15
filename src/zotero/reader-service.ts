/**
 * Zotero Reader 服务（reader-service）。
 *
 * 裁剪/恢复替换文件后，对正在阅读该附件的 Reader 执行 reload：
 * reader.reload() 会重读磁盘文件，并通过内存 viewState 保留页码/滚动/缩放
 * （技术调查 §2.3 源码确认）。
 */
import { log } from '../utils/logger';

export function getOpenReadersForItem(itemID: number): any[] {
  const readers = Zotero.Reader._readers;
  if (!Array.isArray(readers)) return [];
  return readers.filter((r: any) => r.itemID === itemID && !r._isTabClosed);
}

/** 刷新所有打开该附件的 Reader；返回刷新成功的数量 */
export async function reloadReadersForItem(itemID: number): Promise<number> {
  const readers = getOpenReadersForItem(itemID);
  let ok = 0;
  for (const reader of readers) {
    try {
      await reader.reload();
      ok++;
      log.debug(`reader reloaded for item ${itemID}`);
    } catch (e) {
      log.error(`reader reload failed for item ${itemID}`, e);
    }
  }
  return ok;
}
