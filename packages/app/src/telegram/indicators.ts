export interface IndicatorTransport {
  send(text: string): Promise<{ readonly messageId: number }>;
  edit(messageId: number, text: string): Promise<void>;
  delete(messageId: number): Promise<void>;
}
export interface ProgressIndicator {
  readonly messageId: number;
  update(text: string): Promise<boolean>;
  close(finalText?: string): Promise<void>;
}

export async function createProgressIndicator(transport: IndicatorTransport, initialText: string): Promise<ProgressIndicator> {
  if (!initialText.trim()) throw new TypeError('Progress indicator text must be nonempty.');
  const sent = await transport.send(initialText); let current = initialText; let closed = false;
  if (!Number.isSafeInteger(sent.messageId) || sent.messageId < 1) throw new TypeError('Invalid progress indicator message ID.');
  return Object.freeze({
    messageId: sent.messageId,
    async update(text: string): Promise<boolean> {
      if (closed || !text.trim() || text === current) return false;
      try { await transport.edit(sent.messageId, text); current = text; return true; }
      catch { return false; }
    },
    async close(finalText?: string): Promise<void> {
      if (closed) return; closed = true;
      if (finalText?.trim() && finalText !== current) {
        try { await transport.edit(sent.messageId, finalText); return; } catch { /* best-effort deletion below */ }
      }
      await transport.delete(sent.messageId).catch(() => undefined);
    },
  });
}
