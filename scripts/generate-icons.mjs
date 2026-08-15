/**
 * 生成插件图标（48/96 PNG）。开发期工具：node scripts/generate-icons.mjs
 */
import { createCanvas } from '@napi-rs/canvas';

function drawIcon(size) {
  const c = createCanvas(size, size);
  const ctx = c.getContext('2d');
  const s = size / 96;

  // 背景（浅蓝）
  ctx.fillStyle = '#e8f1fa';
  ctx.fillRect(0, 0, size, size);

  // 页面（白色纸面 + 边框）
  const px = 14 * s, py = 10 * s, pw = 68 * s, ph = 76 * s;
  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = '#2e5f8a';
  ctx.lineWidth = 3 * s;
  ctx.fillRect(px, py, pw, ph);
  ctx.strokeRect(px, py, pw, ph);

  // 正文行（深色文本块，模拟正文）
  ctx.fillStyle = '#2e5f8a';
  for (let i = 0; i < 5; i++) {
    const ly = py + 14 * s + i * 12 * s;
    const lw = (i % 2 === 0 ? 52 : 40) * s;
    ctx.fillRect(px + 8 * s, ly, lw, 5 * s);
  }

  // 裁剪标记（四角箭头向内的蓝色折线）
  ctx.strokeStyle = '#1e88e5';
  ctx.lineWidth = 4 * s;
  ctx.lineCap = 'round';
  const m = 6 * s; // 标记长度
  // 左上
  ctx.beginPath();
  ctx.moveTo(px - 2 * s, py + m);
  ctx.lineTo(px - 2 * s, py - 2 * s);
  ctx.lineTo(px + m, py - 2 * s);
  ctx.stroke();
  // 右上
  ctx.beginPath();
  ctx.moveTo(px + pw + 2 * s, py + m);
  ctx.lineTo(px + pw + 2 * s, py - 2 * s);
  ctx.lineTo(px + pw - m, py - 2 * s);
  ctx.stroke();
  // 左下
  ctx.beginPath();
  ctx.moveTo(px - 2 * s, py + ph - m);
  ctx.lineTo(px - 2 * s, py + ph + 2 * s);
  ctx.lineTo(px + m, py + ph + 2 * s);
  ctx.stroke();
  // 右下
  ctx.beginPath();
  ctx.moveTo(px + pw + 2 * s, py + ph - m);
  ctx.lineTo(px + pw + 2 * s, py + ph + 2 * s);
  ctx.lineTo(px + pw - m, py + ph + 2 * s);
  ctx.stroke();

  return c.toBuffer('image/png');
}

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const outDir = join(dirname(fileURLToPath(import.meta.url)), '../addon/content/icons');
await mkdir(outDir, { recursive: true });
await writeFile(join(outDir, 'icon-48.png'), drawIcon(48));
await writeFile(join(outDir, 'icon-96.png'), drawIcon(96));
console.log('icons generated in', outDir);
