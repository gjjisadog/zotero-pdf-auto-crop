import { createCanvas } from '@napi-rs/canvas';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';

globalThis.pdfjsWorker = await import('pdfjs-dist/legacy/build/pdf.worker.mjs');
const stdFontsPath = join(dirname(fileURLToPath(import.meta.url)), '../node_modules/pdfjs-dist/standard_fonts/');

import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
const doc = await PDFDocument.create();
const font = await doc.embedFont(StandardFonts.Helvetica);
const page = doc.addPage([612, 792]);
page.drawText('Hello Auto Crop World', { x: 120, y: 600, size: 24, font, color: rgb(0,0,0) });
page.drawRectangle({ x: 200, y: 300, width: 200, height: 100, color: rgb(0.2,0.4,0.8) });
const bytes = await doc.save();

const pdf = await pdfjsLib.getDocument({ data: bytes, standardFontDataUrl: stdFontsPath }).promise;
const p = await pdf.getPage(1);
const viewport = p.getViewport({ scale: 100/72 });
const canvas = createCanvas(viewport.width, viewport.height);
const ctx = canvas.getContext('2d');
await p.render({ canvasContext: ctx, viewport }).promise;
const img = ctx.getImageData(0, 0, viewport.width, viewport.height);
let minX=1e9, minY=1e9, maxX=-1, maxY=-1;
for (let y=0; y<viewport.height; y++) {
  for (let x=0; x<viewport.width; x++) {
    const i = (y*viewport.width+x)*4;
    const [r,g,b,a] = [img.data[i], img.data[i+1], img.data[i+2], img.data[i+3]];
    if (a > 128 && (r<245 || g<245 || b<245)) {
      if (x<minX) minX=x; if (x>maxX) maxX=x; if (y<minY) minY=y; if (y>maxY) maxY=y;
    }
  }
}
console.log('bbox:', minX, minY, maxX, maxY);
console.log('PASS:', minY < 300 && maxX >= 555);
