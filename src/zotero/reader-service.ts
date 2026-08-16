/**
 * Zotero Reader 服务（reader-service）—— 兼容适配层（P1-3）。
 *
 * 裁剪/恢复替换文件后，对正在阅读该附件的 Reader 执行 reload：
 * reader.reload() 会重读磁盘文件，并通过内存 viewState 保留页码/滚动/缩放
 * （技术调查 §2.3 源码确认）。
 *
 * 注意：枚举打开 Reader 依赖 Zotero 内部字段（Zotero.Reader._readers /
 * _isTabClosed）。这些带下划线的字段是私有实现细节，集中封装在本适配层：
 * 若未来 Zotero 改动导致私有 API 不可用，裁剪功能不受影响，
 * 仅跳过自动刷新（unavailable=true），由调用方提示用户重新打开 PDF。
 */
import { log } from '../utils/logger';

export interface ReaderReloadResult {
  /** 私有 API 是否可用（false = 无法自动刷新，需提示用户重开） */
  available: boolean;
  /** 找到的打开中 reader 数量 */
  found: number;
  /** 成功 reload 的数量 */
  reloaded: number;
}

/**
 * 枚举打开指定附件的 Reader。
 * @returns Reader 数组；私有 API 不可用时返回 null
 */
export function getOpenReadersForItem(itemID: number): any[] | null {
  const reader = (Zotero as any).Reader;
  if (!reader || !Array.isArray(reader._readers)) {
    log.warn('Zotero.Reader._readers unavailable; skipping auto reload');
    return null;
  }
  try {
    return reader._readers.filter((r: any) => r.itemID === itemID && !r._isTabClosed);
  } catch (e) {
    log.warn(`enumerating readers failed: ${(e as Error).message}`);
    return null;
  }
}

/** 刷新所有打开该附件的 Reader */
export async function reloadReadersForItem(itemID: number): Promise<ReaderReloadResult> {
  const readers = getOpenReadersForItem(itemID);
  if (readers === null) {
    return { available: false, found: 0, reloaded: 0 };
  }
  let reloaded = 0;
  for (const reader of readers) {
    try {
      await reader.reload();
      reloaded++;
      log.debug(`reader reloaded for item ${itemID}`);
    } catch (e) {
      log.error(`reader reload failed for item ${itemID}`, e);
    }
  }
  return { available: true, found: readers.length, reloaded };
}
