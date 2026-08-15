/**
 * 插件入口（index.ts）。
 *
 * 构建脚本（scripts/build-xpi.mjs）用 esbuild 将本文件打包为
 * content/scripts/zotero-pdf-auto-crop.js（IIFE），由 bootstrap.js
 * 通过 loadSubScript 注入 bootstrap 作用域；`Zotero.ZoteroPdfAutoCrop`
 * 即为插件实例，bootstrap 通过它调用 hooks。
 */
import { Addon } from './addon';

// Firefox bootstrap 全局缺少部分 DOM/Web 构造器，pdf.js（及 core-js polyfill）
// 在运行时需要它们。仅在确实缺失时注入最小实现，不覆盖 Firefox 原生实现。
const G = globalThis as any;
// DOM 构造器（DOMException/Path2D/AbortController 等）在 onStartup 中
// 从主窗口统一补齐（需要与 canvas 同 realm）
if (typeof G.console === 'undefined') {
  const dumpLine = (level: string, args: unknown[]) => {
    const text = `[zpac:${level}] ${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}`;
    try {
      if (typeof G.Zotero?.debug === 'function') G.Zotero.debug(text);
    } catch {
      /* ignore */
    }
  };
  G.console = {
    log: (...a: unknown[]) => dumpLine('log', a),
    info: (...a: unknown[]) => dumpLine('info', a),
    warn: (...a: unknown[]) => dumpLine('warn', a),
    error: (...a: unknown[]) => dumpLine('error', a),
    debug: (...a: unknown[]) => dumpLine('debug', a),
    assert: (cond: unknown, ...a: unknown[]) => {
      if (!cond) dumpLine('assert', a);
    },
  };
}
if (typeof G.atob === 'undefined') {
  G.atob = (b64: string) => {
    const bin = G.Utilities?.Internal?.base64Decode?.(b64) ?? decodeBase64Manual(b64);
    return bin;
  };
}
if (typeof G.btoa === 'undefined') {
  G.btoa = (str: string) => {
    if (typeof G.Utilities?.Internal?.base64Encode === 'function') {
      return G.Utilities.Internal.base64Encode(str);
    }
    return encodeBase64Manual(str);
  };
}

/** 手工 base64 解码（兜底，bootstrap 无 Buffer） */
function decodeBase64Manual(b64: string): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (const c of b64) {
    if (c === '=') break;
    const v = chars.indexOf(c);
    if (v < 0) continue;
    buffer = (buffer << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out += String.fromCharCode((buffer >> bits) & 0xff);
    }
  }
  return out;
}

/** 手工 base64 编码（兜底） */
function encodeBase64Manual(str: string): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let out = '';
  for (let i = 0; i < str.length; i += 3) {
    const b1 = str.charCodeAt(i);
    const b2 = i + 1 < str.length ? str.charCodeAt(i + 1) : NaN;
    const b3 = i + 2 < str.length ? str.charCodeAt(i + 2) : NaN;
    out += chars[b1 >> 2];
    out += chars[((b1 & 3) << 4) | ((b2 >> 4) & 0xf)];
    out += isNaN(b2) ? '=' : chars[((b2 & 0xf) << 2) | ((b3 >> 6) & 3)];
    out += isNaN(b3) ? '=' : chars[b3 & 0x3f];
  }
  return out;
}

// 在 bootstrap 作用域中 Zotero 是全局对象（loadSubScript 注入）
declare const Zotero: any;

if (!Zotero.ZoteroPdfAutoCrop) {
  Zotero.ZoteroPdfAutoCrop = new Addon();
}
