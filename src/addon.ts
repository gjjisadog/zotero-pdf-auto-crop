/**
 * 插件主类（addon）：生命周期 hooks 与模块接线。
 *
 * 注意：Zotero 插件环境没有 ES module 缓存语义，bundle 为 IIFE；
 * 模块间通过闭包与单例交互，不依赖全局状态。
 */
import { registerContextMenu, unregisterContextMenu } from './ui/context-menu';
import { useZoteroLogger, log } from './utils/logger';

export class Addon {
  /** 已注册的菜单 key（shutdown 时卸载） */
  private menuKeys: string[] = [];

  async onStartup(): Promise<void> {
    await Promise.all([
      Zotero.initializationPromise,
      Zotero.unlockPromise,
      Zotero.uiReadyPromise,
    ]);
    useZoteroLogger();
    log.info('starting up');

    // 条目右键菜单（V1 唯一入口）
    const keys = registerContextMenu();
    this.menuKeys = keys;
  }

  async onMainWindowLoad(_win: unknown): Promise<void> {
    // V1 无窗口相关资源（菜单由 Zotero.MenuManager 统一管理）
  }

  async onMainWindowUnload(_win: unknown): Promise<void> {}

  async onShutdown(): Promise<void> {
    log.info('shutting down');
    for (const key of this.menuKeys) {
      try {
        unregisterContextMenu(key);
      } catch (e) {
        log.error('failed to unregister menu', e);
      }
    }
    this.menuKeys = [];
  }
}
