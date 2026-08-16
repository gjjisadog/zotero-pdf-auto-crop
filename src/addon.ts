/**
 * 插件主类（addon）：生命周期 hooks 与模块接线。
 *
 * 注意：Zotero 插件环境没有 ES module 缓存语义，bundle 为 IIFE；
 * 模块间通过闭包与单例交互，不依赖全局状态。
 */
import { registerContextMenu, unregisterContextMenu, STANDARD_FONTS_URL } from './ui/context-menu';
import { useZoteroLogger, log } from './utils/logger';
import { CropService, type CropResult } from './crop/crop-service';
import type { CropConfig } from './crop/crop-model';
import { ZoteroFileSystem } from './utils/temp-file';
import { createDefaultCanvasBackend } from './pdf/pdf-reader';

export class Addon {
  /** bootstrap.js 调用的 hooks（模板约定：Zotero.ZoteroPdfAutoCrop.hooks.onStartup()） */
  hooks = {
    onStartup: () => this.onStartup(),
    onShutdown: () => this.onShutdown(),
    onMainWindowLoad: (win: unknown) => this.onMainWindowLoad(win),
    onMainWindowUnload: (win: unknown) => this.onMainWindowUnload(win),
  };

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

    // bootstrap 全局缺少部分 DOM 构造器（DOMException/Path2D/AbortController 等），
    // 从主窗口补齐（Path2D 等需与渲染 canvas 同 realm）
    this.patchMissingDOMGlobals();

    // 程序化自检入口（prefs 驱动，V2 自动裁剪的同一管线）：
    // extensions.zotero.zpac.debugCropPath / debugRestorePath 指向文件路径时执行
    await this.runPrefDrivenSelfTest();
  }

  /** 从主窗口复制缺失的 DOM 构造器到 bootstrap 全局 */
  private patchMissingDOMGlobals(): void {
    const G = globalThis as any;
    const win = Zotero.getMainWindow?.();
    if (!win) return;
    const names = [
      // DOM 基础
      'DOMException', 'AbortController', 'AbortSignal', 'Path2D', 'DOMMatrix',
      'ImageData', 'URL', 'URLSearchParams', 'TextEncoder', 'TextDecoder',
      'atob', 'btoa', 'structuredClone', 'Blob', 'FileReader',
      // 流 / 网络（pdf.js 图像解码与字体加载需要）
      'ReadableStream', 'WritableStream', 'TransformStream',
      'CompressionStream', 'DecompressionStream',
      'fetch', 'Response', 'Request', 'Headers',
      'MessageChannel', 'MessagePort', 'BroadcastChannel',
      'Event', 'EventTarget', 'CustomEvent', 'crypto', 'performance',
    ];
    for (const name of names) {
      if (typeof G[name] === 'undefined' && typeof win[name] !== 'undefined') {
        try {
          G[name] = win[name];
        } catch {
          // 个别构造器可能不可复制，忽略
        }
      }
    }
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

  /**
   * 程序化裁剪入口（文件路径）：与右键菜单共用同一 CropService。
   * 亦为 V2「导入后自动裁剪 / 批量裁剪」的预留 API（任务 §42–§43）。
   * 注意：仅供文件系统可直接访问的附件路径使用，不处理 Zotero item 状态。
   */
  async cropFile(path: string, config?: Partial<CropConfig>): Promise<CropResult> {
    log.info(`cropFile: ${path}`);
    const fs = new ZoteroFileSystem();
    const data = await fs.readFile(path);
    const service = new CropService();
    return service.cropPdf({
      data,
      targetPath: path,
      fs,
      pdfOptions: {
        standardFontDataUrl: STANDARD_FONTS_URL,
        canvasBackend: createDefaultCanvasBackend(),
      },
      config: { requireEmbeddedFonts: true, ...config },
    });
  }

  /** 程序化恢复入口（文件路径） */
  async restoreFile(path: string): Promise<CropResult> {
    log.info(`restoreFile: ${path}`);
    const fs = new ZoteroFileSystem();
    const data = await fs.readFile(path);
    const service = new CropService();
    return service.restorePdf({
      data,
      targetPath: path,
      fs,
      pdfOptions: {
        standardFontDataUrl: STANDARD_FONTS_URL,
        canvasBackend: createDefaultCanvasBackend(),
      },
    });
  }

  /**
   * prefs 驱动的自检：设置 extensions.zotero.zpac.debugCropPath /
   * debugRestorePath 后重启，插件自动对指定文件执行裁剪/恢复并输出日志。
   * 用于自动化验证与 V2 自动裁剪的同一管线；执行后自动清除 prefs。
   */
  private async runPrefDrivenSelfTest(): Promise<void> {
    // Zotero.Prefs.get/set 自动加 extensions.zotero. 前缀
    const PREFIX = 'zpac.debug';
    let ran = false;
    try {
      const cropPath = Zotero.Prefs.get(`${PREFIX}CropPath`) as string;
      const restorePath = Zotero.Prefs.get(`${PREFIX}RestorePath`) as string;
      if (cropPath) {
        ran = true;
        log.info(`self-test crop: ${cropPath}`);
        // 实验：允许非嵌入字体渲染，验证 chrome:// standard fonts 可用性
        const r = await this.cropFile(cropPath, { requireEmbeddedFonts: false });
        log.info(`self-test crop result: ${JSON.stringify(r)}`);
      }
      if (restorePath) {
        ran = true;
        log.info(`self-test restore: ${restorePath}`);
        const r = await this.restoreFile(restorePath);
        log.info(`self-test restore result: ${JSON.stringify(r)}`);
      }
    } catch (e) {
      log.error('self-test failed', e);
    } finally {
      if (ran) {
        Zotero.Prefs.set(`${PREFIX}CropPath`, '');
        Zotero.Prefs.set(`${PREFIX}RestorePath`, '');
      }
    }
  }
}
