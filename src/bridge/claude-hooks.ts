import fs from "node:fs";
import path from "node:path";

import type { ApprovalRequest } from "./bridge-types.ts";
import { normalizeOutput, truncatePreview } from "./bridge-utils.ts";

export type ClaudeHookEventName =
  | "SessionStart"
  | "UserPromptSubmit"
  | "PermissionRequest"
  | "Notification"
  | "Stop"
  | "StopFailure";

export type ClaudeHookPayload = {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: ClaudeHookEventName | string;
  source?: string;
  prompt?: string;
  permission_mode?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  permission_suggestions?: unknown[];
  notification_type?: string;
  message?: string;
  title?: string;
  last_assistant_message?: string;
  error?: string;
  error_details?: string;
  stop_hook_active?: boolean;
};

export type PendingInjectedClaudePrompt = {
  normalizedText: string;
  createdAtMs: number;
};

export type ClaudePermissionDecisionAction = "confirm" | "deny";

type ClaudeTranscriptAssistantEntry = {
  type?: string;
  message?: {
    role?: string;
    content?: unknown;
    stop_reason?: string | null;
  };
};

type ClaudeHookScriptParams = {
  platform?: NodeJS.Platform;
  runtimeExecPath: string;
  hookEntryPath: string;
  hookPort: number;
  hookToken: string;
};

function quoteWindowsCommandArg(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function quotePosixCommandArg(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function parseClaudeHookPayload(raw: string): ClaudeHookPayload | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed) as ClaudeHookPayload;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export function extractClaudeResumeConversationId(
  transcriptPath: string | undefined,
): string | null {
  if (typeof transcriptPath !== "string") {
    return null;
  }

  const trimmed = transcriptPath.trim();
  if (!trimmed) {
    return null;
  }

  const segments = trimmed.split(/[\\/]+/);
  const fileName = segments[segments.length - 1] ?? "";
  if (!fileName.toLowerCase().endsWith(".jsonl")) {
    return null;
  }

  const conversationId = fileName.slice(0, -".jsonl".length).trim();
  return conversationId || null;
}

export function buildClaudeHookSettings(
  command: string,
  cwd?: string,
): Record<string, unknown> {
  const hook = {
    hooks: [
      {
        type: "command",
        command,
      },
    ],
  };

  // Merge user's per-project settings (.claude/settings.json) so that
  // model / env / permissions / other fields aren't lost when we pass
  // --settings <runtime>. Hooks are owned by the bridge, so they win.
  let userSettings: Record<string, unknown> = {};
  if (cwd) {
    try {
      const projectSettingsPath = path.join(cwd, ".claude", "settings.json");
      if (fs.existsSync(projectSettingsPath)) {
        const raw = fs.readFileSync(projectSettingsPath, "utf8");
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          userSettings = parsed as Record<string, unknown>;
        }
      }
    } catch {
      // best-effort — if user's settings file is malformed, we just skip the merge.
    }
  }

  return {
    ...userSettings,
    hooks: {
      SessionStart: [hook],
      UserPromptSubmit: [hook],
      PermissionRequest: [hook],
      Notification: [
        {
          matcher: "permission_prompt",
          hooks: hook.hooks,
        },
      ],
      Stop: [hook],
      StopFailure: [hook],
    },
  };
}

export function buildClaudeHookScript(params: ClaudeHookScriptParams): string {
  if (params.platform === "win32") {
    return [
      "@echo off",
      "setlocal",
      `set "CLAUDE_WECHAT_HOOK_PORT=${params.hookPort}"`,
      `set "CLAUDE_WECHAT_HOOK_TOKEN=${params.hookToken}"`,
      // Claude reads hook decisions from stdout, so only stderr can be discarded here.
      `${quoteWindowsCommandArg(params.runtimeExecPath)} --no-warnings --experimental-strip-types ${quoteWindowsCommandArg(params.hookEntryPath)} 2>nul`,
      "exit /b 0",
    ].join("\r\n");
  }

  return [
    "#!/bin/sh",
    `export CLAUDE_WECHAT_HOOK_PORT=${quotePosixCommandArg(String(params.hookPort))}`,
    `export CLAUDE_WECHAT_HOOK_TOKEN=${quotePosixCommandArg(params.hookToken)}`,
    // Claude reads hook decisions from stdout, so only stderr can be discarded here.
    `${quotePosixCommandArg(params.runtimeExecPath)} --no-warnings --experimental-strip-types ${quotePosixCommandArg(params.hookEntryPath)} 2>/dev/null || true`,
    "exit 0",
  ].join("\n");
}

function summarizeClaudePlan(plan: string): string {
  const lines = normalizeOutput(plan)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    return "(empty plan)";
  }

  const heading = lines
    .find((line) => /^#+\s+/.test(line))
    ?.replace(/^#+\s+/, "")
    .trim();
  const description = lines.find(
    (line) =>
      !/^#+\s+/.test(line) &&
      !/^[-*]\s+/.test(line) &&
      !/^\d+\.\s+/.test(line),
  );

  return truncatePreview([heading, description].filter(Boolean).join(" - ") || lines[0], 180);
}

function summarizeClaudeToolInput(
  toolName: string,
  toolInput: Record<string, unknown> | undefined,
): {
  detailLabel: string;
  detailPreview: string;
} {
  if (!toolInput) {
    return {
      detailLabel: "details",
      detailPreview: "(no input)",
    };
  }

  if (toolName === "ExitPlanMode" && typeof toolInput.plan === "string") {
    return {
      detailLabel: "plan",
      detailPreview: summarizeClaudePlan(toolInput.plan),
    };
  }

  if (typeof toolInput.command === "string" && toolInput.command.trim()) {
    return {
      detailLabel: "command",
      detailPreview: toolInput.command.trim(),
    };
  }

  if (typeof toolInput.file_path === "string" && toolInput.file_path.trim()) {
    return {
      detailLabel: "path",
      detailPreview: toolInput.file_path.trim(),
    };
  }

  if (typeof toolInput.pattern === "string" && toolInput.pattern.trim()) {
    return {
      detailLabel: "pattern",
      detailPreview: toolInput.pattern.trim(),
    };
  }

  if (typeof toolInput.url === "string" && toolInput.url.trim()) {
    return {
      detailLabel: "url",
      detailPreview: toolInput.url.trim(),
    };
  }

  return {
    detailLabel: "details",
    detailPreview: truncatePreview(JSON.stringify(toolInput), 180),
  };
}

export function buildClaudePermissionApprovalRequest(
  payload: ClaudeHookPayload,
): ApprovalRequest {
  const toolName =
    typeof payload.tool_name === "string" && payload.tool_name.trim()
      ? payload.tool_name.trim()
      : "Tool";
  const { detailLabel, detailPreview } = summarizeClaudeToolInput(toolName, payload.tool_input);

  return {
    source: "cli",
    summary: `Claude permission is required for ${toolName}.`,
    commandPreview: `${toolName}: ${detailPreview}`,
    toolName,
    detailLabel,
    detailPreview,
  };
}

/**
 * Decide whether a PermissionRequest is safe to auto-approve at the bridge
 * level — the WeChat-only user can't see the local Claude TUI and getting
 * stranded on a prompt for a routine `mkdir && cat <<EOF` is a UX dead-end
 * (compounded by iLink rate-limiting the approval-prompt message itself).
 *
 * Conservative policy: Bash only, every piece of a compound command must
 * start with a whitelisted command, and the full text must not match any of
 * the always-deny patterns (sudo, destructive rm, dd, /dev/ writes, curl|sh).
 * Heredoc bodies are stripped before splitting so log contents inside
 * `cat <<EOF ... EOF` can't fool the parser with `&&` or `;` inside data.
 */
export function shouldAutoApprovePermissionRequest(payload: ClaudeHookPayload): boolean {
  const toolName = typeof payload.tool_name === "string" ? payload.tool_name.trim() : "";
  if (toolName !== "Bash") return false;

  const command = typeof payload.tool_input?.command === "string"
    ? (payload.tool_input.command as string).trim()
    : "";
  if (!command) return false;

  const DENY_PATTERNS: RegExp[] = [
    /\bsudo\b/,
    /\brm\s+-[rRf]+\s+(\/[^\/\s]|~|\$HOME|\.\s*$)/,
    /\brm\s+-[rRf]+\s+\*/,
    /\bdd\s+if=/,
    /\bmkfs\b/,
    /\bshutdown\b/,
    /\breboot\b/,
    />\s*\/dev\//,
    /\b(curl|wget)\b[^|]*\|\s*(sh|bash|zsh)\b/,
    /\bchmod\s+(0?7|7)77\b/,
    /\bgit\s+push\s+.*--force\b/,
    /\bgit\s+reset\s+--hard\b/,
  ];
  for (const pat of DENY_PATTERNS) {
    if (pat.test(command)) return false;
  }

  // Strip heredoc bodies so connectors inside data don't get split.
  const stripped = command.replace(
    /<<-?\s*'?"?(\w+)'?"?[\s\S]*?\n\s*\1\s*$/gm,
    "<<HEREDOC",
  );

  const SAFE_FIRST_TOKENS = new Set([
    // Filesystem reads
    "ls", "cat", "head", "tail", "wc", "stat", "file", "du", "df", "tree",
    "find", "fd", "fdfind", "grep", "rg", "egrep", "fgrep",
    "awk", "sed", "sort", "uniq", "cut", "paste", "tr", "column",
    "diff", "cmp", "md5sum", "sha256sum",
    // Filesystem writes (safe-ish under deny rules above)
    "mkdir", "touch", "cp", "mv", "ln", "tee",
    "tar", "unzip", "zip", "gzip", "gunzip", "zcat",
    // Echoes / utilities
    "echo", "printf", "date", "seq", "true", "false", "exit", "test", "[",
    "env", "printenv", "which", "type", "whoami", "hostname", "uname", "uptime",
    "pwd", "cd", "pushd", "popd",
    // Process / network read
    "ps", "pgrep", "lsof", "netstat",
    // Data parsers
    "jq", "yq", "xxd", "hexdump", "base64",
    // Git read-only / safe writes
    "git", "gh",
    // Package read
    "brew", "npm", "yarn", "pnpm", "bun", "pip", "uv", "cargo",
    // Mac niceties
    "open", "say", "pbcopy", "pbpaste",
    // Network read
    "curl", "wget", "aria2c",
  ]);

  const SHELL_BUILTINS_TO_SKIP = new Set([
    "if", "then", "else", "elif", "fi", "for", "do", "done", "while", "case",
    "esac", "function", "return", "local", "export", "set", "unset",
  ]);

  const pieces = stripped.split(/\s*(?:&&|\|\||;|\|)\s*/);
  for (const piece of pieces) {
    const trimmed = piece.trim();
    if (!trimmed) continue;
    // Skip leading env-var assignments (FOO=bar BAR=baz cmd ...).
    let rest = trimmed;
    while (/^[A-Z_][A-Z0-9_]*=/.test(rest)) {
      rest = rest.replace(/^\S+\s*/, "");
    }
    if (!rest) continue;
    const firstToken = rest.split(/\s+/)[0] ?? "";
    if (!firstToken) return false;
    if (SHELL_BUILTINS_TO_SKIP.has(firstToken)) continue;
    if (!SAFE_FIRST_TOKENS.has(firstToken)) return false;
  }

  return true;
}

export function buildClaudePermissionDecisionHookOutput(
  action: ClaudePermissionDecisionAction,
): string {
  const decision =
    action === "confirm"
      ? {
          behavior: "allow",
        }
      : {
          behavior: "deny",
          message: "Permission denied from WeChat bridge.",
          interrupt: false,
        };

  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision,
    },
  });
}

export function extractClaudeAssistantMessageText(payload: ClaudeHookPayload): string {
  return typeof payload.last_assistant_message === "string"
    ? normalizeOutput(payload.last_assistant_message).trim()
    : "";
}

function extractClaudeAssistantContentText(content: unknown): string {
  if (!Array.isArray(content)) {
    return "";
  }

  const parts = content
    .flatMap((item) => {
      if (!item || typeof item !== "object") {
        return [];
      }

      const candidate = item as {
        type?: string;
        text?: string;
      };
      if (candidate.type !== "text" || typeof candidate.text !== "string") {
        return [];
      }

      const text = normalizeOutput(candidate.text).trim();
      return text ? [text] : [];
    });

  return parts.join("\n\n").trim();
}

export function extractClaudeTranscriptFinalReply(rawTranscript: string): string | null {
  const lines = rawTranscript.split(/\r?\n/);
  let fallbackText: string | null = null;

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim();
    if (!line) {
      continue;
    }

    let parsed: ClaudeTranscriptAssistantEntry | null = null;
    try {
      parsed = JSON.parse(line) as ClaudeTranscriptAssistantEntry;
    } catch {
      continue;
    }

    if (!parsed || typeof parsed !== "object") {
      continue;
    }

    if (parsed.type !== "assistant" || !parsed.message || parsed.message.role !== "assistant") {
      continue;
    }

    const text = extractClaudeAssistantContentText(parsed.message.content);
    if (!text) {
      continue;
    }

    if (parsed.message.stop_reason === "end_turn") {
      return text;
    }

    fallbackText ??= text;
  }

  return fallbackText;
}

export function normalizeClaudeAssistantMessage(payload: ClaudeHookPayload): string {
  return extractClaudeAssistantMessageText(payload) || "(no final reply)";
}

export function buildClaudeFailureMessage(payload: ClaudeHookPayload): string {
  const details = [
    typeof payload.last_assistant_message === "string"
      ? normalizeOutput(payload.last_assistant_message).trim()
      : "",
    typeof payload.error_details === "string"
      ? normalizeOutput(payload.error_details).trim()
      : "",
    typeof payload.error === "string" ? payload.error.trim() : "",
  ].filter(Boolean);

  return truncatePreview(details.join(" | ") || "Claude reported an unknown error.", 500);
}

export function findInjectedClaudePromptIndex(
  prompt: string,
  pendingInputs: PendingInjectedClaudePrompt[],
  nowMs = Date.now(),
  maxAgeMs = 15_000,
): number {
  const normalizedPrompt = normalizeOutput(prompt).trim();
  if (!normalizedPrompt) {
    return -1;
  }

  return pendingInputs.findIndex((candidate) => {
    if (nowMs - candidate.createdAtMs > maxAgeMs) {
      return false;
    }
    return candidate.normalizedText === normalizedPrompt;
  });
}
