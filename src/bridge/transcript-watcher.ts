// Transcript watcher: tails a Claude Code session jsonl and emits each new
// assistant text block as it lands. Used by the wechat-bridge claude adapter
// to forward intermediate narration to WeChat (instead of only firing once at
// the Stop hook).
//
// Design:
//   - fs.watch on the jsonl path
//   - on change → read from lastByteOffset to file end → split lines
//   - parse each line as JSON; if role=assistant and uuid is new, walk
//     content[] for type=text blocks and emit them
//   - dedupe by message uuid so re-reads of the file don't double-emit

import fs from "node:fs";

type AssistantTextHandler = (text: string) => void;

export class ClaudeTranscriptWatcher {
  private path: string | null = null;
  private fsWatcher: fs.FSWatcher | null = null;
  private lastByteOffset = 0;
  private readonly seenUuids = new Set<string>();
  private readonly onText: AssistantTextHandler;
  private readonly onError: ((err: Error) => void) | undefined;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private partialLineBuffer = "";
  // Polling fallback: macOS fs.watch is flaky on append-only writes (and on
  // files that don't exist yet at start time). Run a low-frequency timer
  // alongside fs.watch so we never miss assistant text even if the kernel
  // event was dropped.
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(params: {
    onText: AssistantTextHandler;
    onError?: (err: Error) => void;
  }) {
    this.onText = params.onText;
    this.onError = params.onError;
  }

  /**
   * Start watching a transcript jsonl. Replaces any prior watcher. The watcher
   * starts at end-of-file by default, so existing history isn't replayed.
   *
   * Pass `replayFromStart: true` to also emit historical assistant text
   * (mainly useful for tests).
   */
  start(transcriptPath: string, opts: { replayFromStart?: boolean } = {}): void {
    this.stop();
    this.path = transcriptPath;
    this.partialLineBuffer = "";
    this.seenUuids.clear();

    try {
      const stat = fs.statSync(transcriptPath);
      this.lastByteOffset = opts.replayFromStart ? 0 : stat.size;
    } catch {
      // File doesn't exist yet — start at 0 and we'll pick up everything
      // once it's created.
      this.lastByteOffset = 0;
    }

    if (opts.replayFromStart) {
      this.drain();
    }

    try {
      this.fsWatcher = fs.watch(transcriptPath, { persistent: false }, () => {
        this.scheduleDrain();
      });
      this.fsWatcher.on("error", (err) => {
        this.onError?.(err as Error);
      });
    } catch (err) {
      this.onError?.(err as Error);
    }

    // Always run a polling fallback (every 1.5s). fs.watch is best-effort on
    // macOS — kernel events for append/rename can drop, especially at session
    // creation. The poll cost is trivial (one fstat per tick).
    this.pollTimer = setInterval(() => {
      this.drain();
    }, 1500);
    if (typeof this.pollTimer.unref === "function") this.pollTimer.unref();
  }

  stop(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.fsWatcher) {
      try {
        this.fsWatcher.close();
      } catch {
        /* noop */
      }
      this.fsWatcher = null;
    }
    this.path = null;
  }

  /** Returns the set of assistant uuids the watcher has already emitted text for. */
  getSeenUuids(): ReadonlySet<string> {
    return this.seenUuids;
  }

  /**
   * Force-process any new transcript bytes synchronously. Useful right before
   * emitting a final_reply event so the watcher has caught up with the jsonl's
   * latest assistant text — without this, the Stop hook can race ahead of fs
   * writes and we'd send the same text twice (once via final_reply, once via
   * the deferred watcher fire).
   */
  drainNow(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.drain();
  }

  private scheduleDrain(): void {
    if (this.debounceTimer) return;
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.drain();
    }, 80);
    if (typeof this.debounceTimer.unref === "function") this.debounceTimer.unref();
  }

  private drain(): void {
    if (!this.path) return;
    let stat: fs.Stats;
    try {
      stat = fs.statSync(this.path);
    } catch {
      return;
    }

    // Handle file rotation / shrink: if file is smaller than our offset, reset.
    if (stat.size < this.lastByteOffset) {
      this.lastByteOffset = 0;
      this.partialLineBuffer = "";
    }
    if (stat.size === this.lastByteOffset) return;

    let chunk: Buffer;
    try {
      const fd = fs.openSync(this.path, "r");
      try {
        const len = stat.size - this.lastByteOffset;
        chunk = Buffer.alloc(len);
        fs.readSync(fd, chunk, 0, len, this.lastByteOffset);
      } finally {
        fs.closeSync(fd);
      }
    } catch (err) {
      this.onError?.(err as Error);
      return;
    }

    this.lastByteOffset = stat.size;
    const text = this.partialLineBuffer + chunk.toString("utf8");
    const lines = text.split("\n");
    // Last element is either "" (clean newline) or partial line — keep it.
    this.partialLineBuffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line) continue;
      this.processLine(line);
    }
  }

  private processLine(line: string): void {
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      return;
    }
    if (!obj || typeof obj !== "object") return;
    const record = obj as {
      uuid?: unknown;
      message?: { role?: unknown; content?: unknown };
    };
    const uuid = typeof record.uuid === "string" ? record.uuid : "";
    if (!uuid || this.seenUuids.has(uuid)) return;
    const message = record.message;
    if (!message || typeof message !== "object") return;
    if (message.role !== "assistant") return;
    const content = message.content;
    if (!Array.isArray(content)) {
      this.seenUuids.add(uuid);
      return;
    }

    const textPieces: string[] = [];
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const b = block as { type?: unknown; text?: unknown };
      if (b.type === "text" && typeof b.text === "string" && b.text) {
        textPieces.push(b.text);
      }
    }

    this.seenUuids.add(uuid);
    if (textPieces.length === 0) return;

    const combined = textPieces.join("\n").trim();
    if (combined) {
      try {
        this.onText(combined);
      } catch (err) {
        this.onError?.(err as Error);
      }
    }
  }
}
