/**
 * 插件入口（index.ts）。
 *
 * 构建脚本（scripts/build-xpi.mjs）用 esbuild 将本文件打包为
 * content/scripts/zotero-pdf-auto-crop.js（IIFE），由 bootstrap.js
 * 通过 loadSubScript 注入 bootstrap 作用域；`Zotero.ZoteroPdfAutoCrop`
 * 即为插件实例，bootstrap 通过它调用 hooks。
 */
import { Addon } from './addon';

// 在 bootstrap 作用域中 Zotero 是全局对象（loadSubScript 注入）
declare const Zotero: any;

if (!Zotero.ZoteroPdfAutoCrop) {
  Zotero.ZoteroPdfAutoCrop = new Addon();
}
