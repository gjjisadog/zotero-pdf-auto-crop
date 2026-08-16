import { describe, it, expect } from 'vitest';
import { PDFDocument, PDFName } from 'pdf-lib';
import {
  createRestoreMetadata, readRestoreMetadata, writeRestoreMetadata,
  RESTORE_INFO_KEY, RESTORE_XMP_NS,
} from '../../src/pdf/crop-metadata';
import { boxFromRect } from '../../src/crop/bounding-box';

async function makeDoc(): Promise<PDFDocument> {
  const doc = await PDFDocument.create();
  doc.addPage([612, 792]);
  doc.addPage([612, 792]);
  return doc;
}

describe('crop-metadata', () => {
  it('Info 字典编码/解码往返', async () => {
    const doc = await makeDoc();
    const meta = createRestoreMetadata([
      { crop: boxFromRect(0, 0, 612, 792) },
      { crop: boxFromRect(50, 50, 500, 700) },
      { crop: null },
    ]);
    writeRestoreMetadata(doc, meta);

    // 保存后重新加载（模拟真实流程）
    const bytes = await doc.save();
    const reloaded = await PDFDocument.load(bytes, { updateMetadata: false });
    const got = readRestoreMetadata(reloaded);
    expect(got).not.toBeNull();
    expect(got!.version).toBe(2);
    expect(got!.plugin).toBe('zotero-pdf-auto-crop');
    expect(got!.pages.length).toBe(3);
    expect(got!.pages[1].crop!.left).toBe(50);
    expect(got!.pages[1].crop!.top).toBe(750);
    expect(got!.pages[2].crop).toBeNull();
  });

  it('XMP 命名空间写入（无现有 /Metadata 时）', async () => {
    const doc = await makeDoc();
    const meta = createRestoreMetadata([{ crop: boxFromRect(0, 0, 612, 792) }]);
    writeRestoreMetadata(doc, meta);

    const metadataRef = doc.catalog.get(PDFName.of('Metadata'));
    expect(metadataRef).toBeDefined();
    const bytes = await doc.save();
    const reloaded = await PDFDocument.load(bytes, { updateMetadata: false });
    const got = readRestoreMetadata(reloaded);
    expect(got).not.toBeNull();
    expect(got!.pages.length).toBe(1);
  });

  it('已有 /Metadata 时不覆盖现有 XMP', async () => {
    const doc = await makeDoc();
    // 模拟其他工具写入的 XMP
    const existing = doc.context.stream(
      new TextEncoder().encode('<?xpacket?><x:xmpmeta><rdf:RDF><rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>My Doc</dc:title></rdf:Description></rdf:RDF></x:xmpmeta><?xpacket?>'),
      { Type: 'Metadata', Subtype: 'XML' }
    );
    doc.catalog.set(PDFName.of('Metadata'), doc.context.register(existing));

    const meta = createRestoreMetadata([{ crop: boxFromRect(0, 0, 612, 792) }]);
    writeRestoreMetadata(doc, meta);

    // 保存后：现有 XMP 未被替换（仍含 dc:title），Info 键可读
    const bytes = await doc.save();
    const reloaded = await PDFDocument.load(bytes, { updateMetadata: false });
    const stream = reloaded.context.lookup(reloaded.catalog.get(PDFName.of('Metadata'))!);
    const text = new TextDecoder().decode((stream as any).getContents());
    expect(text).toContain('My Doc');
    expect(text).not.toContain(RESTORE_XMP_NS);
    const got = readRestoreMetadata(reloaded);
    expect(got).not.toBeNull();
  });

  it('无效数据返回 null', async () => {
    const doc = await makeDoc();
    expect(readRestoreMetadata(doc)).toBeNull();
  });

  it('损坏的 Info 数据返回 null（不抛异常）', async () => {
    const doc = await makeDoc();
    const info = doc.context.obj({}) as any;
    doc.context.trailerInfo.Info = doc.context.register(info);
    info.set(PDFName.of(RESTORE_INFO_KEY), (doc.context as any).obj('not json'));
    expect(readRestoreMetadata(doc)).toBeNull();
  });
});
