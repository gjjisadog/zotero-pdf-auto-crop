/**
 * 进度窗口封装（progress）：把 CropService 的 onProgress 映射到
 * Zotero.ProgressWindow（技术调查 §2.2：new pw.ItemProgress(...).setProgress(...)）。
 */
export interface ProgressHandle {
  setText(text: string): void;
  setPercent(percent: number): void;
  done(): void;
  close(): void;
}

export function createProgressWindow(headline: string): ProgressHandle | null {
  const win = Zotero.getMainWindow();
  if (!win) return null;
  try {
    const pw = new Zotero.ProgressWindow({ closeOnClick: true });
    pw.changeHeadline(headline);
    const itemProgress = new pw.ItemProgress('file', '');
    pw.show();
    let finished = false;
    return {
      setText(text: string) {
        itemProgress.setText(text);
      },
      setPercent(percent: number) {
        itemProgress.setProgress(Math.max(0, Math.min(100, Math.round(percent))));
      },
      done() {
        if (finished) return;
        finished = true;
        itemProgress.setProgress(100);
        pw.startCloseTimer(2500);
      },
      close() {
        pw.close();
      },
    };
  } catch (e) {
    console.error('failed to create progress window', e);
    return null;
  }
}
