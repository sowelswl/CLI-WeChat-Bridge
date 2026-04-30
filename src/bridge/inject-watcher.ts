// Inject-dir watcher: tails a per-channel "inject" directory under the
// bridge's cwd. Any plain file dropped in there is read once, deleted, and
// its contents fed into the bridge's existing inbound-message dispatcher
// (so deferred-when-busy and WeChat mirroring both work for free).
//
// Use case: Claude Code's built-in CronCreate / scheduled tasks only fire
// while the REPL is idle. Real cron jobs (or any external scheduler) can
// instead drop a file here and trust that it'll be delivered to the agent
// even if it's mid-turn — same behaviour as a WeChat message arriving at
// the wrong moment.
//
// Design:
//   - directory: <cwd>/.inject  (per-agent, survives reboots, no /tmp)
//   - fs.watch + 1.5s polling fallback (macOS fs.watch is unreliable)
//   - startup readdir drains anything that piled up while bridge was down
//   - files ending in `.tmp` are skipped, so writers can do the
//     atomic-rename dance: `echo ... > foo.tmp && mv foo.tmp foo`
//   - 64KB cap per file (large drops are rejected with a warning)
//   - file is unlinked AFTER successful read; if onInject throws the file
//     is still removed (we don't want a poison message stuck in a retry
//     loop) but the error is reported via onError

import fs from "node:fs";
import path from "node:path";

const POLL_INTERVAL_MS = 1_500;
const DEBOUNCE_MS = 80;
const MAX_BYTES = 64 * 1024;

type InjectHandler = (params: {
  text: string;
  source: string;
  filename: string;
}) => void | Promise<void>;

export class InjectDirWatcher {
  private dir: string | null = null;
  private fsWatcher: fs.FSWatcher | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private draining = false;
  private readonly onInject: InjectHandler;
  private readonly onError: ((err: Error) => void) | undefined;
  private readonly source: string;

  constructor(params: {
    /** Free-form label for the source — written into the synthetic message. */
    source?: string;
    onInject: InjectHandler;
    onError?: (err: Error) => void;
  }) {
    this.source = params.source ?? "scheduled";
    this.onInject = params.onInject;
    this.onError = params.onError;
  }

  start(injectDir: string): void {
    this.stop();
    this.dir = injectDir;

    try {
      fs.mkdirSync(injectDir, { recursive: true, mode: 0o700 });
    } catch (err) {
      this.onError?.(err as Error);
      return;
    }

    // Drain anything that arrived while the bridge was offline.
    void this.scheduleDrain();

    try {
      this.fsWatcher = fs.watch(injectDir, { persistent: false }, () => {
        this.scheduleDrain();
      });
      this.fsWatcher.on("error", (err) => this.onError?.(err as Error));
    } catch (err) {
      // fs.watch can fail (e.g. on some filesystems); polling will cover.
      this.onError?.(err as Error);
    }

    // Poll fallback — fs.watch is flaky on macOS, particularly for moves
    // landing in the watched dir. Cheap (one readdir per tick).
    this.pollTimer = setInterval(() => this.scheduleDrain(), POLL_INTERVAL_MS);
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
    this.dir = null;
  }

  private scheduleDrain(): void {
    if (this.debounceTimer) return;
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.drain();
    }, DEBOUNCE_MS);
    if (typeof this.debounceTimer.unref === "function") this.debounceTimer.unref();
  }

  private async drain(): Promise<void> {
    if (!this.dir || this.draining) return;
    this.draining = true;
    try {
      let entries: string[];
      try {
        entries = fs.readdirSync(this.dir);
      } catch (err) {
        this.onError?.(err as Error);
        return;
      }

      // Stable order: oldest-mtime first, so cron jobs queued in burst land
      // in chronological order in the agent's view.
      const ranked = entries
        .filter((name) => !name.startsWith(".") && !name.endsWith(".tmp"))
        .map((name) => {
          const full = path.join(this.dir!, name);
          let mtimeMs = 0;
          try {
            mtimeMs = fs.statSync(full).mtimeMs;
          } catch {
            return null;
          }
          return { name, full, mtimeMs };
        })
        .filter((r): r is { name: string; full: string; mtimeMs: number } => Boolean(r))
        .sort((a, b) => a.mtimeMs - b.mtimeMs);

      for (const entry of ranked) {
        await this.processOne(entry.full, entry.name);
      }
    } finally {
      this.draining = false;
    }
  }

  private async processOne(filepath: string, filename: string): Promise<void> {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(filepath);
    } catch {
      return;
    }
    if (!stat.isFile()) return;
    if (stat.size === 0) {
      try { fs.unlinkSync(filepath); } catch { /* noop */ }
      return;
    }
    if (stat.size > MAX_BYTES) {
      this.onError?.(
        new Error(
          `inject file ${filename} exceeds ${MAX_BYTES} bytes (got ${stat.size}); discarding`,
        ),
      );
      try { fs.unlinkSync(filepath); } catch { /* noop */ }
      return;
    }

    let raw: string;
    try {
      raw = fs.readFileSync(filepath, "utf8");
    } catch (err) {
      this.onError?.(err as Error);
      return;
    }

    // Always remove the file before invoking the handler — a faulty handler
    // shouldn't trap us in a retry loop. The risk in the other direction is
    // smaller (one missed message vs. infinite re-fires).
    try { fs.unlinkSync(filepath); } catch { /* noop */ }

    const text = raw.trim();
    if (!text) return;

    try {
      await this.onInject({ text, source: this.source, filename });
    } catch (err) {
      this.onError?.(err as Error);
    }
  }
}
