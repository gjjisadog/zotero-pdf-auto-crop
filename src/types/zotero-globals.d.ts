/**
 * Zotero / Firefox 特权环境全局声明（bootstrap 作用域可用，技术调查 §1.2）。
 * zotero-types 已声明 Zotero 命名空间（见 tsconfig types）；这里补充 IOUtils 等。
 */
declare const IOUtils: {
  read(path: string): Promise<Uint8Array>;
  readDirectory(path: string): Promise<{ name: string; type: string }[]>;
  write(path: string, data: Uint8Array, options?: { mode?: number; flush?: boolean }): Promise<void>;
  move(src: string, dest: string, options?: { noOverwrite?: boolean }): Promise<void>;
  remove(path: string, options?: { ignoreAbsent?: boolean; recursive?: boolean }): Promise<void>;
  exists(path: string): Promise<boolean>;
  stat(path: string): Promise<{ size: number; lastModified: number; type: string }>;
  makeDirectory(path: string, options?: { ignoreExisting?: boolean }): Promise<void>;
};

declare const PathUtils: {
  join(...parts: string[]): string;
  dirname(path: string): string;
  basename(path: string): string;
  filename(path: string): string;
};

declare const Services: any;
declare const Components: any;
declare const ChromeUtils: any;

declare module 'pdfjs-dist/legacy/build/pdf.worker.mjs' {
  export const WorkerMessageHandler: any;
}
