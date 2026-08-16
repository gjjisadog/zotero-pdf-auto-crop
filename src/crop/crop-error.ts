/**
 * 裁剪错误类型（crop-error）。
 *
 * 独立成模块：文件事务层（file-transaction）与 CropService 共用，
 * 避免循环依赖。
 */

export type CropErrorKind =
  | 'encrypted'       // 加密 PDF（任务 §30：拒绝）
  | 'signed'          // 数字签名 PDF（任务 §31：拒绝）
  | 'damaged'         // 解析失败（任务 §32：保留原文件）
  | 'no-restore-data' // 恢复时没有元数据
  | 'restore-mismatch' // 恢复数据页数与文档不符
  | 'io'              // 文件系统错误
  | 'source-changed'  // 处理期间源文件被其他程序修改（H1：不覆盖新版本）
  | 'validation'      // 输出校验失败
  | 'unsupported'     // 其他不支持的情况
  | 'unknown';

export class CropError extends Error {
  readonly kind: CropErrorKind;

  constructor(kind: CropErrorKind, message: string, cause?: unknown) {
    super(
      cause instanceof Error ? `${message} [${cause.message}]` : message,
      cause !== undefined ? { cause } : undefined
    );
    this.name = 'CropError';
    this.kind = kind;
  }
}
