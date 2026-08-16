/**
 * 操作日志（operation-log）：追加到 profile/zpac-operations.log（最近 500 行）。
 *
 * 正常模式下 Zotero 无文件日志；右键菜单与程序化入口的成功/失败都会记录，
 * 便于诊断实际使用中的问题。日志不含 PDF 内容，仅含路径、状态、错误信息。
 */
export async function appendOperationLog(entry: Record<string, unknown>): Promise<void> {
  try {
    const profile = Zotero.getProfileDirectory() as any;
    const dir = typeof profile?.path === 'string' ? profile.path : String(profile);
    const logPath = PathUtils.join(dir, 'zpac-operations.log');
    const lines: string[] = [];
    if (await IOUtils.exists(logPath)) {
      const text = new TextDecoder().decode(await IOUtils.read(logPath));
      lines.push(...text.split('\n').filter((l) => l.trim()));
    }
    lines.push(JSON.stringify({ time: new Date().toISOString(), ...entry }));
    await IOUtils.write(logPath, new TextEncoder().encode(lines.slice(-500).join('\n') + '\n'));
  } catch {
    // 日志失败不影响主流程
  }
}
