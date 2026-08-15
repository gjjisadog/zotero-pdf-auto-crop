/**
 * 统一日志（logger）。
 *
 * Zotero 环境输出到 Zotero 日志（Zotero.debug / Zotero.logError），
 * Node（测试/开发）输出到 console。不记录 PDF 全文等敏感数据。
 */

export interface Logger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string, err?: unknown): void;
}

class ConsoleLogger implements Logger {
  debug(message: string): void {
    console.debug(`[zpac] ${message}`);
  }
  info(message: string): void {
    console.log(`[zpac] ${message}`);
  }
  warn(message: string): void {
    console.warn(`[zpac] ${message}`);
  }
  error(message: string, err?: unknown): void {
    console.error(`[zpac] ${message}`, err ?? '');
  }
}

/** Zotero 环境日志（bootstrap 作用域注入 Zotero 全局时启用） */
class ZoteroLogger implements Logger {
  debug(message: string): void {
    Zotero.debug(`Zotero PDF Auto Crop: ${message}`);
  }
  info(message: string): void {
    Zotero.debug(`Zotero PDF Auto Crop: ${message}`);
  }
  warn(message: string): void {
    Zotero.debug(`Zotero PDF Auto Crop: ${message}`);
  }
  error(message: string, err?: unknown): void {
    if (err instanceof Error) {
      Zotero.logError(new Error(`Zotero PDF Auto Crop: ${message}`, { cause: err }));
    } else {
      Zotero.logError(new Error(`Zotero PDF Auto Crop: ${message}`));
    }
  }
}

let current: Logger = new ConsoleLogger();

export function setLogger(logger: Logger): void {
  current = logger;
}

export function useZoteroLogger(): void {
  current = new ZoteroLogger();
}

export const log = {
  debug: (m: string) => current.debug(m),
  info: (m: string) => current.info(m),
  warn: (m: string) => current.warn(m),
  error: (m: string, e?: unknown) => current.error(m, e),
};
