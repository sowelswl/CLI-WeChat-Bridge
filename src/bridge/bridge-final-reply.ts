import type { BridgeAdapterKind } from "./bridge-types.ts";
import {
  formatFinalReplyMessage,
  parseWechatFinalReply,
  sanitizeWechatFinalReplyText,
} from "./bridge-utils.ts";

// Split text by sentence boundaries (Chinese + English punctuation, double-newline).
// Mirrors OutputBatcher's logic — keeps chunks at ≥ MIN_CHARS, falls back to
// hard slicing at MAX_CHARS for runs without punctuation (long bullet lists etc).
function splitIntoSentenceChunks(text: string): string[] {
  const MIN_CHARS = 4;
  const MAX_CHARS = 200;
  // Same boundary rules as OutputBatcher.findSentenceBreak — keeps URLs,
  // numbers ("1."), and abbreviations intact.
  const breakRegex = /[。！？；]|(?<!\d)[.!?](?=\s|$)|\n\n/g;
  const out: string[] = [];
  let buf = text;

  while (buf.length > 0) {
    if (buf.length < MIN_CHARS) {
      out.push(buf.trim());
      break;
    }
    breakRegex.lastIndex = 0;
    const m = breakRegex.exec(buf);
    if (m) {
      const cutAt = m.index + m[0].length;
      const chunk = buf.slice(0, cutAt).trim();
      if (chunk) out.push(chunk);
      buf = buf.slice(cutAt);
    } else if (buf.length >= MAX_CHARS) {
      out.push(buf.slice(0, MAX_CHARS).trim());
      buf = buf.slice(MAX_CHARS);
    } else {
      out.push(buf.trim());
      break;
    }
  }
  return out.filter((s) => s.length > 0);
}

export type WechatFinalReplySender = {
  sendText: (text: string) => Promise<void>;
  sendImage: (imagePath: string) => Promise<unknown>;
  sendFile: (filePath: string) => Promise<unknown>;
  sendVoice: (voicePath: string) => Promise<unknown>;
  sendVideo: (videoPath: string) => Promise<unknown>;
};

export async function forwardWechatFinalReply(params: {
  adapter: BridgeAdapterKind;
  rawText: string;
  sender: WechatFinalReplySender;
  // When true, skip sending the visible text — the caller has already
  // streamed it via stdout events. Attachments are still processed.
  skipTextSend?: boolean;
}): Promise<void> {
  const { adapter, rawText, sender, skipTextSend } = params;
  const parsed = parseWechatFinalReply(rawText);
  const visibleText = formatFinalReplyMessage(
    adapter,
    sanitizeWechatFinalReplyText(adapter, parsed.visibleText),
  ).trim();

  if (visibleText && !skipTextSend) {
    // Real-person feel: split final reply into sentences and send one-by-one
    // with a tiny pause, instead of one big paragraph.
    const chunks = splitIntoSentenceChunks(visibleText);
    for (let i = 0; i < chunks.length; i++) {
      await sender.sendText(chunks[i]);
      // Small inter-chunk delay so chunks arrive as distinct WeChat messages
      // and we stay under iLink rate limits.
      if (i < chunks.length - 1) {
        await new Promise((r) => setTimeout(r, 350));
      }
    }
  }

  for (const attachment of parsed.attachments) {
    try {
      switch (attachment.kind) {
        case "image":
          await sender.sendImage(attachment.path);
          break;
        case "file":
          await sender.sendFile(attachment.path);
          break;
        case "voice":
          await sender.sendVoice(attachment.path);
          break;
        case "video":
          await sender.sendVideo(attachment.path);
          break;
      }
    } catch (error) {
      const errorText =
        error instanceof Error ? error.message : String(error ?? "unknown error");
      await sender.sendText(
        `Failed to send ${attachment.kind} attachment: ${attachment.path}\n${errorText}`,
      );
    }
  }
}
