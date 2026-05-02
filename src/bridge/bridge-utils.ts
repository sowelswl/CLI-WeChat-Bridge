import os from "node:os";
import path from "node:path";

import type {
  ApprovalRequest,
  BridgeAdapterKind,
  BridgeAdapterState,
  BridgeResumeSessionCandidate,
  BridgeResumeThreadCandidate,
  BridgeSessionSwitchReason,
  BridgeSessionSwitchSource,
  BridgeState,
  BridgeThreadSwitchReason,
  BridgeThreadSwitchSource,
  PendingApproval,
} from "./bridge-types.ts";

const ANSI_ESCAPE_RE =
  // eslint-disable-next-line no-control-regex
  /\x1b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

export type SystemCommand =
  | { type: "status" }
  | { type: "resume"; target?: string }
  | { type: "stop" }
  | { type: "reset" }
  | { type: "confirm"; code?: string }
  | { type: "deny" };

export const MESSAGE_START_GRACE_MS = 5_000;
const WECHAT_ATTACHMENT_SEND_INTENT_RE =
  /\b(send|upload|attach|forward|share)\b/i;
const WECHAT_ATTACHMENT_SEND_INTENT_ZH_RE =
  /发送|发给我|发我|发到|上传|转发|分享/;
const WECHAT_ATTACHMENT_TARGET_RE = /\bwechat\b/i;
const WECHAT_ATTACHMENT_TARGET_ZH_RE = /微信/;
const WECHAT_ATTACHMENT_FILE_TERM_RE =
  /\b(file|attachment|pdf|document|docx?|xlsx?|pptx?|csv|txt|zip|rar|7z|image|photo|picture|screenshot|audio|voice|video|png|jpe?g|gif|webp|bmp|mp3|wav|m4a|ogg|aac|mov|mp4|mkv|avi)\b/i;
const WECHAT_ATTACHMENT_FILE_TERM_ZH_RE =
  /文件|附件|文档|压缩包|图片|照片|截图|音频|语音|视频|pdf|PDF/;
const LOCAL_ATTACHMENT_PATH_HINT_RE =
  /(?:[A-Za-z]:\\|(?:~[\\/])?(?:Desktop|Documents|Downloads|Pictures|Videos|Music)[\\/])/i;
const WECHAT_ATTACHMENT_PROMPT_PREFIX = [
  "[WeChat bridge note]",
  "Your final reply will be forwarded back to a WeChat chat.",
  "If the user asks you to send a local file or media to WeChat and you know the local path, do not say that you lack a WeChat sending tool.",
  "For a real send request, prefer locating and sending the file directly instead of opening or reading it unless the user explicitly asked for that.",
  "Put any brief visible reply text first, then end the message with exactly one trailing block like:",
  "```wechat-attachments",
  "file C:\\Users\\name\\Desktop\\document.pdf",
  "```",
  "Valid kinds: image, file, video, voice.",
  "Use `file` for PDFs and ordinary documents. Only include files you truly intend to upload.",
  "",
  "[User request]",
].join("\n");

const WECHAT_ATTACHMENT_BLOCK_RE =
  /\n```wechat-attachments[ \t]*\n([\s\S]*?)\n```[ \t]*$/;

// Strip ANY ```wechat-attachments ... ``` block (not just the trailing one)
// from streamed narration text. The agent occasionally embeds an attachment
// block in the middle of a longer reply; without a global match, the markup
// would leak into WeChat as raw markdown.
//
// NOTE: UNLINEARITY's parseWechatFinalReply only honors a TRAILING attachment
// block as a real attachment. Mid-text attachment blocks aren't currently
// rendered as images either way — but stripping at least removes the visible
// markup so the user sees clean text.
export const WECHAT_ATTACHMENT_BLOCK_STRIP_RE =
  /\n?```wechat-attachments[ \t]*\n[\s\S]*?\n```[ \t]*/g;

const WECHAT_ATTACHMENT_KINDS = ["image", "file", "video", "voice"] as const;
const INLINE_IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".bmp",
]);
const INLINE_VIDEO_EXTENSIONS = new Set([
  ".mp4",
  ".mov",
  ".mkv",
  ".avi",
  ".webm",
]);
const INLINE_VOICE_EXTENSIONS = new Set([
  ".mp3",
  ".wav",
  ".m4a",
  ".ogg",
  ".aac",
]);
const INLINE_REFERENCE_ONLY_FILE_EXTENSIONS = new Set([
  ".bat",
  ".c",
  ".cc",
  ".cjs",
  ".cmd",
  ".cpp",
  ".cs",
  ".cts",
  ".cxx",
  ".go",
  ".h",
  ".hh",
  ".hpp",
  ".java",
  ".js",
  ".jsx",
  ".kt",
  ".kts",
  ".lua",
  ".m",
  ".mjs",
  ".mm",
  ".mts",
  ".php",
  ".pl",
  ".ps1",
  ".psd1",
  ".psm1",
  ".py",
  ".rb",
  ".rs",
  ".scala",
  ".sh",
  ".swift",
  ".ts",
  ".tsx",
  ".vb",
  ".zsh",
]);
const INLINE_MAAS_URL_RE =
  /https?:\/\/[^\s]*?\/([A-Za-z]:\\.+?(?:\.\s*[A-Za-z0-9]{2,8})+)(?:\?[^\n]*)?/g;
const INLINE_WINDOWS_PATH_RE =
  /(^|[^\w])`?([A-Za-z]:\\(?:[^\\/:*?"<>|\r\n`]+\\)*[^\\/:*?"<>|\r\n`]+?(?:\.\s*[A-Za-z0-9]{2,8})+)`?(?=$|[^\w])/gm;
const INLINE_HOME_RELATIVE_PATH_RE =
  /(^|[^\w])`?((?:~[\\/])?(?:Desktop|Documents|Downloads|Pictures|Videos|Music)[\\/](?:[^\\/:*?"<>|\r\n`]+[\\/])*[^\\/:*?"<>|\r\n`]+?(?:\.\s*[A-Za-z0-9]{2,8})+)`?(?=$|[^\w])/gim;

export type WechatAttachmentKind = (typeof WECHAT_ATTACHMENT_KINDS)[number];

export type WechatReplyAttachment = {
  kind: WechatAttachmentKind;
  path: string;
};

export type ParsedWechatFinalReply = {
  visibleText: string;
  attachments: WechatReplyAttachment[];
};

type CodexSessionJsonLine = {
  timestamp?: string;
  type?: string;
  payload?: {
    type?: string;
    phase?: string;
    message?: string;
  };
};

export type CodexSessionAgentMessage = {
  timestamp?: string;
  phase?: string;
  message: string;
};

export function nowIso(): string {
  return new Date().toISOString();
}

export function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE_RE, "");
}

export function normalizeOutput(text: string): string {
  return stripAnsi(text)
    .replace(/\u0000/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
}

export function truncatePreview(text: string, maxLength = 140): string {
  const normalized = normalizeOutput(text).trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "(empty)";
  }
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 3))}...`;
}

export function buildOneTimeCode(length = 6): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  while (code.length < length) {
    code += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return code;
}

export function buildInstanceId(): string {
  return `bridge-${Date.now().toString(36)}-${buildOneTimeCode(6).toLowerCase()}`;
}

export function parseSystemCommand(text: string): SystemCommand | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) {
    return null;
  }

  const [rawCommand, ...rest] = trimmed.split(/\s+/);
  const command = rawCommand.toLowerCase();
  const argument = rest.join(" ").trim();

  switch (command) {
    case "/status":
      return { type: "status" };
    case "/resume":
      return argument ? { type: "resume", target: argument } : { type: "resume" };
    case "/stop":
      return { type: "stop" };
    case "/reset":
      return { type: "reset" };
    case "/confirm":
      return argument ? { type: "confirm", code: argument } : null;
    case "/deny":
      return { type: "deny" };
    default:
      return null;
  }
}

export function parseWechatControlCommand(
  text: string,
  options: {
    adapter: BridgeAdapterKind;
    hasPendingConfirmation: boolean;
  },
): SystemCommand | null {
  const systemCommand = parseSystemCommand(text);
  if (systemCommand) {
    return systemCommand;
  }

  if (options.adapter !== "claude") {
    return null;
  }

  const normalized = text.trim().toLowerCase();
  if (!normalized) {
    return null;
  }

  if (normalized === "/confirm") {
    return { type: "confirm" };
  }

  if (!options.hasPendingConfirmation) {
    return null;
  }

  switch (normalized) {
    case "confirm":
    case "yes":
      return { type: "confirm" };
    case "deny":
    case "no":
      return { type: "deny" };
    default:
      return null;
  }
}

export function shouldInjectWechatAttachmentPrompt(text: string): boolean {
  const normalized = normalizeOutput(text).trim();
  if (!normalized || normalized.includes("```wechat-attachments")) {
    return false;
  }

  const mentionsSendIntent =
    WECHAT_ATTACHMENT_SEND_INTENT_RE.test(normalized) ||
    WECHAT_ATTACHMENT_SEND_INTENT_ZH_RE.test(normalized);
  if (!mentionsSendIntent) {
    return false;
  }

  const mentionsWechatTarget =
    WECHAT_ATTACHMENT_TARGET_RE.test(normalized) ||
    WECHAT_ATTACHMENT_TARGET_ZH_RE.test(normalized);
  const mentionsFileOrMedia =
    WECHAT_ATTACHMENT_FILE_TERM_RE.test(normalized) ||
    WECHAT_ATTACHMENT_FILE_TERM_ZH_RE.test(normalized);
  const mentionsLocalPath = LOCAL_ATTACHMENT_PATH_HINT_RE.test(normalized);
  const looksLikeShortSendCommand = normalized.length <= 32;

  return (
    mentionsWechatTarget ||
    mentionsFileOrMedia ||
    mentionsLocalPath ||
    looksLikeShortSendCommand
  );
}

export function buildWechatInboundPrompt(text: string): string {
  if (!shouldInjectWechatAttachmentPrompt(text)) {
    return text;
  }

  const normalized = normalizeOutput(text).trim();
  if (!normalized) {
    return text;
  }

  return `${WECHAT_ATTACHMENT_PROMPT_PREFIX}\n${normalized}`;
}

export function parseWechatFinalReply(text: string): ParsedWechatFinalReply {
  const normalized = normalizeOutput(text);

  // Match every ```wechat-attachments ... ``` block, regardless of whether
  // the agent placed it at the very end or sandwiched it in the middle of
  // its narration.
  const blockRe = /\n?```wechat-attachments[ \t]*\n([\s\S]*?)\n```[ \t]*/g;
  const attachments: WechatReplyAttachment[] = [];
  let invalidBlockSeen = false;
  let m: RegExpExecArray | null;

  while ((m = blockRe.exec(normalized)) !== null) {
    const lines = m[1]
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    if (!lines.length) {
      invalidBlockSeen = true;
      continue;
    }

    let allParsed = true;
    for (const line of lines) {
      const parsed = /^(image|file|video|voice)\s+(.+)$/.exec(line);
      if (!parsed) {
        invalidBlockSeen = true;
        allParsed = false;
        break;
      }
      const kind = parsed[1] as WechatAttachmentKind;
      const attachmentPath = resolveWechatAttachmentPath(parsed[2]);
      if (!attachmentPath) {
        invalidBlockSeen = true;
        allParsed = false;
        break;
      }
      attachments.push({ kind, path: attachmentPath });
    }
    if (!allParsed) continue;
  }

  if (attachments.length === 0) {
    if (invalidBlockSeen) {
      return extractInlineWechatAttachments(normalized);
    }
    return extractInlineWechatAttachments(normalized);
  }

  // Strip every attachment block from visible text so the user only sees
  // narration + the actual attachments, not the protocol markup.
  const visibleText = normalized.replace(blockRe, "").trim();
  return { visibleText, attachments };
}

export function parseCodexSessionAgentMessage(
  line: string,
): CodexSessionAgentMessage | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }

  let parsed: CodexSessionJsonLine;
  try {
    parsed = JSON.parse(trimmed) as CodexSessionJsonLine;
  } catch {
    return null;
  }

  if (parsed.type !== "event_msg" || parsed.payload?.type !== "agent_message") {
    return null;
  }

  const message =
    typeof parsed.payload.message === "string"
      ? normalizeOutput(parsed.payload.message).trim()
      : "";
  if (!message) {
    return null;
  }

  return {
    timestamp: parsed.timestamp,
    phase: typeof parsed.payload.phase === "string" ? parsed.payload.phase : undefined,
    message,
  };
}

const HIGH_RISK_PATTERNS = [
  /\bremove-item\b/i,
  /\brd\b/i,
  /\brmdir\b/i,
  /\bdel\b/i,
  /\berase\b/i,
  /\bformat\b/i,
  /\bshutdown\b/i,
  /\bstop-computer\b/i,
  /\brestart-computer\b/i,
  /\bstop-process\b/i,
  /\btaskkill\b/i,
  /\breg\s+delete\b/i,
  /\bsc\s+delete\b/i,
  /\bdiskpart\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\s+-f/i,
  /\bset-executionpolicy\b/i,
  /\bstart-process\b.*\b-verb\s+runas\b/i,
  /\b(?:invoke-expression|iex)\b/i,
  /\bcurl\b.*\|\s*(?:iex|powershell)\b/i,
  /\binvoke-webrequest\b.*\|\s*(?:iex|powershell)\b/i,
  /\brm\b\s+-[A-Za-z-]*r[A-Za-z-]*/i,
  /\bsudo\b/i,
  /\bmkfs(?:\.\w+)?\b/i,
  /\bdd\b/i,
  /\breboot\b/i,
  /\bsystemctl\b/i,
  /\blaunchctl\b/i,
  /\bcurl\b.*\|\s*(?:sh|bash|zsh)\b/i,
  /\bwget\b.*\|\s*(?:sh|bash|zsh)\b/i,
];

export function isHighRiskShellCommand(command: string): boolean {
  const normalized = command.trim();
  if (!normalized) {
    return false;
  }
  return HIGH_RISK_PATTERNS.some((pattern) => pattern.test(normalized));
}

const ALWAYS_INTERACTIVE_SHELL_COMMANDS = new Set([
  "ftp",
  "htop",
  "irb",
  "less",
  "more",
  "mongosh",
  "mysql",
  "nano",
  "nvim",
  "psql",
  "redis-cli",
  "screen",
  "sftp",
  "sqlite3",
  "ssh",
  "telnet",
  "tmux",
  "top",
  "vi",
  "vim",
  "watch",
]);

function tokenizeShellCommand(command: string, maxTokens = 16): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;

  for (const char of command.trim()) {
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (/\s/u.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
        if (tokens.length >= maxTokens) {
          return tokens;
        }
      }
      continue;
    }

    current += char;
  }

  if (current) {
    tokens.push(current);
  }
  return tokens;
}

function normalizeShellExecutableToken(token: string): string {
  const trimmed = token.trim().replace(/^["']|["']$/g, "");
  if (!trimmed) {
    return "";
  }
  return path.parse(trimmed).name.toLowerCase();
}

function findCommandFlagIndex(args: string[], supportedFlags: string[]): number {
  return args.findIndex((arg) => supportedFlags.includes(arg.toLowerCase()));
}

function hasScriptLikeArg(args: string[]): boolean {
  return args.some((arg) => Boolean(arg) && !arg.startsWith("-") && !arg.startsWith("/"));
}

function hasAnyCommandFlag(args: string[], supportedFlags: string[]): boolean {
  return findCommandFlagIndex(args, supportedFlags) >= 0;
}

function buildInteractiveShellCommandMessage(executable: string, suggestion: string): string {
  return `Interactive command "${executable}" is not supported in shell mode yet. This shell bridge currently only supports non-interactive commands and scripts. ${suggestion}`;
}

export function getInteractiveShellCommandRejectionMessage(command: string): string | null {
  const tokens = tokenizeShellCommand(command);
  if (!tokens.length) {
    return null;
  }

  const executable = normalizeShellExecutableToken(tokens[0]);
  const args = tokens.slice(1);
  const lowerArgs = args.map((arg) => arg.toLowerCase());

  if (!executable) {
    return null;
  }

  if (ALWAYS_INTERACTIVE_SHELL_COMMANDS.has(executable)) {
    return buildInteractiveShellCommandMessage(
      executable,
      "Run a non-interactive command or script instead.",
    );
  }

  switch (executable) {
    case "python":
    case "python3":
    case "py":
      if (!args.length) {
        return buildInteractiveShellCommandMessage(
          executable,
          'Try "python script.py" or "python -c \\"...\\"" instead.',
        );
      }
      if (lowerArgs.includes("-i") || lowerArgs.includes("--interactive")) {
        return buildInteractiveShellCommandMessage(
          executable,
          'Try "python script.py" or "python -c \\"...\\"" instead.',
        );
      }
      if (hasAnyCommandFlag(lowerArgs, ["-c", "-h", "--help", "-v", "--version"])) {
        return null;
      }
      const moduleFlagIndex = findCommandFlagIndex(lowerArgs, ["-m"]);
      if (moduleFlagIndex >= 0) {
        return moduleFlagIndex < args.length - 1
          ? null
          : buildInteractiveShellCommandMessage(
              executable,
              'Try "python script.py" or "python -m module_name" instead.',
            );
      }
      return hasScriptLikeArg(args)
        ? null
        : buildInteractiveShellCommandMessage(
            executable,
            'Try "python script.py" or "python -c \\"...\\"" instead.',
          );

    case "node":
      if (!args.length || lowerArgs.includes("-i") || lowerArgs.includes("--interactive")) {
        return buildInteractiveShellCommandMessage(
          executable,
          'Try "node script.js" or "node -e \\"...\\"" instead.',
        );
      }
      if (hasAnyCommandFlag(lowerArgs, ["-e", "--eval", "-p", "--print", "-h", "--help", "-v", "--version"])) {
        return null;
      }
      return hasScriptLikeArg(args)
        ? null
        : buildInteractiveShellCommandMessage(
            executable,
            'Try "node script.js" or "node -e \\"...\\"" instead.',
          );

    case "cmd":
      if (lowerArgs.includes("/?")) {
        return null;
      }
      if (lowerArgs.includes("/k") || !lowerArgs.includes("/c")) {
        return buildInteractiveShellCommandMessage(
          executable,
          'Try "cmd /c <command>" or run the command directly instead.',
        );
      }
      return null;

    case "powershell":
    case "pwsh":
      if (
        !args.length ||
        lowerArgs.includes("-noexit") ||
        lowerArgs.includes("-nologo") && args.length === 1
      ) {
        return buildInteractiveShellCommandMessage(
          executable,
          `Try "${executable} -Command \\"...\\"" or "${executable} -File script.ps1" instead.`,
        );
      }
      if (
        hasAnyCommandFlag(
          lowerArgs,
          ["-c", "-command", "-enc", "-encodedcommand", "-f", "-file", "-h", "-help", "-v", "-version", "-?"],
        )
      ) {
        return null;
      }
      return hasScriptLikeArg(args)
        ? null
        : buildInteractiveShellCommandMessage(
            executable,
            `Try "${executable} -Command \\"...\\"" or "${executable} -File script.ps1" instead.`,
          );

    case "bash":
    case "dash":
    case "ksh":
    case "sh":
    case "zsh":
      if (!args.length || lowerArgs.includes("-i")) {
        return buildInteractiveShellCommandMessage(
          executable,
          `Try "${executable} -c '...'" or "${executable} script.sh" instead.`,
        );
      }
      if (findCommandFlagIndex(lowerArgs, ["-c", "-lc"]) >= 0) {
        return null;
      }
      if (hasAnyCommandFlag(lowerArgs, ["-h", "--help", "--version"])) {
        return null;
      }
      return hasScriptLikeArg(args)
        ? null
        : buildInteractiveShellCommandMessage(
            executable,
            `Try "${executable} -c '...'" or "${executable} script.sh" instead.`,
          );

    default:
      return null;
  }
}

export function detectCliApproval(text: string): ApprovalRequest | null {
  const normalized = normalizeOutput(text);
  const compact = normalized.replace(/\s+/g, " ").trim();
  if (!compact) {
    return null;
  }

  const approvalPatterns: Array<{
    pattern: RegExp;
    confirmInput?: string;
    denyInput?: string;
  }> = [
    { pattern: /\bdo you want to allow\b/i, confirmInput: "y\r", denyInput: "n\r" },
    { pattern: /\bapprove\b/i, confirmInput: "y\r", denyInput: "n\r" },
    { pattern: /\ballow this\b/i, confirmInput: "y\r", denyInput: "n\r" },
    { pattern: /\b\(y\/n\)\b/i, confirmInput: "y\r", denyInput: "n\r" },
    { pattern: /\byes\/no\b/i, confirmInput: "yes\r", denyInput: "no\r" },
    { pattern: /\bpress enter to continue\b/i, confirmInput: "\r" },
    { pattern: /\bconfirm to continue\b/i, confirmInput: "y\r", denyInput: "n\r" },
  ];

  const matched = approvalPatterns.find(({ pattern }) => pattern.test(compact));
  if (!matched) {
    return null;
  }

  const preview = truncatePreview(compact, 160);
  return {
    source: "cli",
    summary: "CLI approval is required before the session can continue.",
    commandPreview: preview,
    confirmInput: matched.confirmInput,
    denyInput: matched.denyInput,
  };
}

export function formatDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    return "0s";
  }

  const totalSeconds = Math.floor(durationMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (!minutes) {
    return `${seconds}s`;
  }

  return `${minutes}m ${seconds}s`;
}

export function summarizeOutput(text: string, maxLength = 280): string {
  const normalized = normalizeOutput(text)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  if (!normalized.length) {
    return "(no output)";
  }

  const summary = normalized.slice(-6).join("\n");
  if (summary.length <= maxLength) {
    return summary;
  }

  return summary.slice(summary.length - maxLength);
}

export function formatStatusReport(
  bridgeState: BridgeState,
  adapterState: BridgeAdapterState,
): string {
  const pending = bridgeState.pendingConfirmation;
  const persistedSharedSessionId =
    bridgeState.sharedSessionId ?? bridgeState.sharedThreadId;
  const sharedSessionId =
    adapterState.sharedSessionId ?? adapterState.sharedThreadId;
  const lastSessionSwitchAt =
    adapterState.lastSessionSwitchAt ?? adapterState.lastThreadSwitchAt;
  const lastSessionSwitchSource =
    adapterState.lastSessionSwitchSource ?? adapterState.lastThreadSwitchSource;
  const lastSessionSwitchReason =
    adapterState.lastSessionSwitchReason ?? adapterState.lastThreadSwitchReason;
  const formatEpochMs = (value?: number) =>
    typeof value === "number" && Number.isFinite(value)
      ? new Date(value).toISOString()
      : "(none)";

  return [
    `instance_id: ${bridgeState.instanceId}`,
    `adapter: ${bridgeState.adapter}`,
    `command: ${bridgeState.command}`,
    `cwd: ${bridgeState.cwd}`,
    `profile: ${bridgeState.profile ?? "(none)"}`,
    `bridge_started_at: ${formatEpochMs(bridgeState.bridgeStartedAtMs)}`,
    `authorized_user: ${bridgeState.authorizedUserId}`,
    `ignored_backlog_count: ${bridgeState.ignoredBacklogCount}`,
    `persisted_shared_session_id: ${persistedSharedSessionId ?? "(none)"}`,
    `worker_status: ${adapterState.status}`,
    `worker_pid: ${adapterState.pid ?? "(unknown)"}`,
    `shared_session_id: ${sharedSessionId ?? "(none)"}`,
    `last_session_switch_at: ${lastSessionSwitchAt ?? "(none)"}`,
    `last_session_switch_source: ${lastSessionSwitchSource ?? "(none)"}`,
    `last_session_switch_reason: ${lastSessionSwitchReason ?? "(none)"}`,
    `active_turn_id: ${adapterState.activeTurnId ?? "(none)"}`,
    `active_turn_origin: ${adapterState.activeTurnOrigin ?? "(none)"}`,
    `pending_approval_origin: ${adapterState.pendingApprovalOrigin ?? "(none)"}`,
    `last_activity_at: ${bridgeState.lastActivityAt ?? "(none)"}`,
    `last_input_at: ${adapterState.lastInputAt ?? "(none)"}`,
    `last_output_at: ${adapterState.lastOutputAt ?? "(none)"}`,
    `pending_confirmation: ${pending ? `${pending.source}:${pending.code}` : "(none)"}`,
  ].join("\n");
}

export function formatSessionSwitchMessage(params: {
  adapter: BridgeAdapterKind;
  sessionId: string;
  source: BridgeSessionSwitchSource;
  reason: BridgeSessionSwitchReason;
}): string {
  const shortSessionId = params.sessionId.slice(0, 12);

  if (params.adapter === "claude") {
    switch (params.reason) {
      case "local_follow":
      case "local_session_fallback":
      case "local_turn":
        return `Claude session switched to ${shortSessionId} from the local terminal.`;
      case "wechat_resume":
        return `Claude session switched to ${shortSessionId} from WeChat.`;
      case "startup_restore":
        return `Claude restored shared session ${shortSessionId} on startup.`;
      default:
        return `Claude session switched to ${shortSessionId}.`;
    }
  }

  if (params.adapter === "opencode") {
    switch (params.reason) {
      case "local_follow":
      case "local_session_fallback":
      case "local_turn":
        return `OpenCode session switched to ${shortSessionId} from the local terminal.`;
      case "wechat_resume":
        return `OpenCode session switched to ${shortSessionId} from WeChat.`;
      case "startup_restore":
        return `OpenCode restored shared session ${shortSessionId} on startup.`;
      default:
        return `OpenCode session switched to ${shortSessionId}.`;
    }
  }

  switch (params.reason) {
    case "local_follow":
    case "local_session_fallback":
    case "local_turn":
      return `Codex thread switched to ${shortSessionId} from the local terminal.`;
    case "wechat_resume":
      return `Codex thread switched to ${shortSessionId} from WeChat.`;
    case "startup_restore":
      return `Codex restored shared thread ${shortSessionId} on startup.`;
    default:
      return `Codex thread switched to ${shortSessionId}.`;
  }
}

export function formatThreadSwitchMessage(params: {
  threadId: string;
  source: BridgeThreadSwitchSource;
  reason: BridgeThreadSwitchReason;
}): string {
  return formatSessionSwitchMessage({
    adapter: "codex",
    sessionId: params.threadId,
    source: params.source,
    reason: params.reason,
  });
}

export function formatResumeSessionList(params: {
  adapter: BridgeAdapterKind;
  candidates: BridgeResumeSessionCandidate[];
  currentSessionId?: string;
}): string {
  const { adapter, candidates, currentSessionId } = params;
  if (candidates.length === 0) {
    return adapter === "codex"
      ? "No saved Codex threads were found for this working directory."
      : adapter === "opencode"
        ? "No saved OpenCode sessions were found for this working directory."
        : "No saved sessions were found for this working directory.";
  }

  const title = adapter === "codex" ? "Recent Codex threads:" : adapter === "opencode" ? "Recent OpenCode sessions:" : "Recent sessions:";
  const resumeTargetLabel = adapter === "codex" ? "threadId" : "sessionId";
  return [
    title,
    ...candidates.map((candidate, index) => {
      const marker =
        currentSessionId && candidate.sessionId === currentSessionId ? " [current]" : "";
      return `${index + 1}. ${candidate.title} (${candidate.lastUpdatedAt}, ${candidate.sessionId.slice(0, 12)})${marker}`;
    }),
    `Reply with /resume <number> or /resume <${resumeTargetLabel}>.`,
  ].join("\n");
}

export function formatResumeThreadList(
  candidates: BridgeResumeThreadCandidate[],
  currentThreadId?: string,
): string {
  return formatResumeSessionList({
    adapter: "codex",
    candidates: candidates.map((candidate) => ({
      ...candidate,
      sessionId: candidate.sessionId ?? candidate.threadId ?? "",
      threadId: candidate.threadId ?? candidate.sessionId,
    })),
    currentSessionId: currentThreadId,
  });
}

export function formatMirroredUserInputMessage(
  adapter: BridgeAdapterKind,
  text: string,
): string {
  const label =
    adapter === "codex"
      ? "Local Codex input"
      : adapter === "claude"
        ? "Local Claude input"
        : adapter === "opencode"
          ? "Local OpenCode input"
          : "Local input";
  return `${label}:\n${truncatePreview(text, 500)}`;
}

export function formatFinalReplyMessage(
  adapter: BridgeAdapterKind,
  text: string,
): string {
  if (adapter === "claude" || adapter === "codex" || adapter === "opencode") {
    return text;
  }
  // After the early return above, only "shell" remains.
  const label = (adapter as string) === "codex" ? "Codex" : (adapter as string) === "claude" ? "Claude" : (adapter as string) === "opencode" ? "OpenCode" : adapter;
  return `${label} final reply:\n${text}`;
}

const OPENCODE_WORKING_NOTICE_RE = /^OpenCode is still working on:\s*$/i;
const OPENCODE_TRANSIENT_NOTICE_RES = [
  /^Bridge error: opencode companion is not connected\./i,
  /^OpenCode companion is not connected(?: for bridge workspace)?:?$/i,
  /^Run "wechat-(?:bridge-opencode|opencode(?:-start)?)".*$/i,
  /^OpenCode session switched to \S+ from the local terminal\.$/i,
  /^Local OpenCode input:\s*$/i,
];
const OPENCODE_REASONING_LINE_RES = [
  /\bCLAUDE\.md\b/i,
  /\bNo tool needed\.?$/i,
  /\bThe user said\b/i,
  /\bI need to (?:respond|reply|answer|tell the user)\b/i,
  /\bWe need to (?:respond|reply|answer)\b/i,
  /\bI should\b/i,
  /\bI'll provide\b/i,
  /^Let me (?:directly )?(?:answer|respond)\b/i,
  /根据系统提示/i,
  /系统提示中说/i,
  /我需要(?:告诉用户|回答|回复)/,
  /我们需要(?:回答|回复)/,
  /^让我直接(?:回答|回复)/,
  /^我要直接(?:回答|回复)/,
  /^用户(?:说|问)了/,
];

export function sanitizeWechatFinalReplyText(
  adapter: BridgeAdapterKind,
  text: string,
): string {
  const normalized = cleanupVisibleWechatReplyText(text);
  if (!normalized || adapter !== "opencode") {
    return normalized;
  }

  const keptLines: string[] = [];
  let dropNextContextLine = false;
  let sawDroppedMeta = false;
  let tailStartIndex = 0;

  for (const rawLine of normalized.split("\n")) {
    const line = rawLine.trim();
    if (!line) {
      keptLines.push("");
      continue;
    }

    if (dropNextContextLine) {
      dropNextContextLine = false;
      if (line.length <= 200) {
        sawDroppedMeta = true;
        tailStartIndex = keptLines.length;
        continue;
      }
    }

    if (OPENCODE_WORKING_NOTICE_RE.test(line)) {
      sawDroppedMeta = true;
      tailStartIndex = keptLines.length;
      dropNextContextLine = true;
      continue;
    }

    if (
      OPENCODE_TRANSIENT_NOTICE_RES.some((pattern) => pattern.test(line)) ||
      OPENCODE_REASONING_LINE_RES.some((pattern) => pattern.test(line))
    ) {
      sawDroppedMeta = true;
      tailStartIndex = keptLines.length;
      continue;
    }

    const previousLine = keptLines.length > 0 ? keptLines[keptLines.length - 1] : undefined;
    if (
      previousLine &&
      previousLine.trim() &&
      previousLine.trim().replace(/\s+/g, " ") === line.replace(/\s+/g, " ")
    ) {
      continue;
    }

    keptLines.push(line);
  }

  const cleaned = cleanupVisibleWechatReplyText(keptLines.join("\n"));
  if (!sawDroppedMeta) {
    return cleaned;
  }

  const tail = cleanupVisibleWechatReplyText(keptLines.slice(tailStartIndex).join("\n"));
  return tail || cleaned;
}

function extractInlineWechatAttachments(text: string): ParsedWechatFinalReply {
  const sanitized = text
    .replace(/\\\n\s*/g, "\\")
    .replace(/\.\s*\n?\s*([A-Za-z0-9]{2,8})(?=\?)/g, ".$1")
    .replace(/\?\s+/g, "?");
  const attachments: WechatReplyAttachment[] = [];
  const seenPaths = new Set<string>();
  let visibleText = sanitized;
  const rememberAttachment = (candidatePath: string): boolean => {
    const attachmentPath = resolveWechatAttachmentPath(candidatePath);
    if (!attachmentPath) {
      return false;
    }

    const kind = inferInlineWechatAttachmentKind(attachmentPath);
    if (!kind) {
      return false;
    }

    if (!seenPaths.has(attachmentPath)) {
      attachments.push({
        kind,
        path: attachmentPath,
      });
      seenPaths.add(attachmentPath);
    }
    return true;
  };

  visibleText = visibleText.replace(INLINE_MAAS_URL_RE, (fullMatch, candidatePath) => {
    return rememberAttachment(candidatePath) ? "" : fullMatch;
  });

  visibleText = visibleText.replace(
    INLINE_WINDOWS_PATH_RE,
    (fullMatch, prefix, candidatePath) => {
      return rememberAttachment(candidatePath) ? prefix : fullMatch;
    },
  );

  visibleText = visibleText.replace(
    INLINE_HOME_RELATIVE_PATH_RE,
    (fullMatch, prefix, candidatePath) => {
      return rememberAttachment(candidatePath) ? prefix : fullMatch;
    },
  );

  return {
    visibleText: cleanupVisibleWechatReplyText(visibleText),
    attachments,
  };
}

function resolveWechatAttachmentPath(candidatePath: string): string | null {
  const normalizedCandidate = normalizeWechatAttachmentCandidate(candidatePath);
  if (!normalizedCandidate) {
    return null;
  }

  if (path.isAbsolute(normalizedCandidate)) {
    return path.normalize(normalizedCandidate);
  }

  const homeRelativeMatch =
    /^(?:~[\\/])?(Desktop|Documents|Downloads|Pictures|Videos|Music)([\\/].+)?$/i.exec(
      normalizedCandidate,
    );
  if (!homeRelativeMatch) {
    return null;
  }

  const relativeTail = `${homeRelativeMatch[1]}${homeRelativeMatch[2] ?? ""}`;
  const relativeSegments = relativeTail.split(/[\\/]+/).filter(Boolean);
  if (!relativeSegments.length) {
    return null;
  }

  return path.normalize(path.join(os.homedir(), ...relativeSegments));
}

function normalizeWechatAttachmentCandidate(candidatePath: string): string {
  return candidatePath
    .trim()
    .replace(/^`|`$/g, "")
    .replace(/\.\s+([A-Za-z0-9]{2,8})(?=$|[?/\s])/g, ".$1")
    .replace(/[\\/]+/g, path.sep);
}

function inferInlineWechatAttachmentKind(filePath: string): WechatAttachmentKind | null {
  const extension = path.extname(filePath).toLowerCase();
  if (INLINE_IMAGE_EXTENSIONS.has(extension)) {
    return "image";
  }
  if (INLINE_VIDEO_EXTENSIONS.has(extension)) {
    return "video";
  }
  if (INLINE_VOICE_EXTENSIONS.has(extension)) {
    return "voice";
  }

  // Keep ordinary local files auto-sendable, but avoid turning common
  // source/script references in prose into unintended WeChat uploads.
  if (!extension || INLINE_REFERENCE_ONLY_FILE_EXTENSIONS.has(extension)) {
    return null;
  }

  return "file";
}

function cleanupVisibleWechatReplyText(text: string): string {
  return text
    .replace(/```[^\n]*\n\s*```/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+\n/g, "\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function formatTaskFailedMessage(
  adapter: BridgeAdapterKind,
  text: string,
): string {
  const label = adapter === "codex" ? "Codex" : adapter === "claude" ? "Claude" : adapter === "opencode" ? "OpenCode" : adapter;
  return `${label} task failed:\n${text}`;
}

export function formatApprovalMessage(
  pending: PendingApproval,
  adapterState: BridgeAdapterState,
): string {
  const isClaude = adapterState.kind === "claude";
  if (isClaude) {
    return [
      "Claude permission request.",
      ...(pending.toolName ? [`tool: ${pending.toolName}`] : []),
      ...(pending.detailPreview
        ? [`${pending.detailLabel ?? "details"}: ${pending.detailPreview}`]
        : pending.commandPreview
          ? [`details: ${pending.commandPreview}`]
          : []),
      "Reply with /confirm, confirm, or yes to continue.",
      "Reply with /deny, deny, or no to reject.",
    ].join("\n");
  }

  return [
    `${pending.source === "shell" ? "Shell" : "CLI"} approval is required.`,
    `adapter: ${adapterState.kind}`,
    `code: ${pending.code}`,
    `summary: ${pending.summary}`,
    `target: ${pending.commandPreview}`,
    "Reply with /confirm <code> to continue or /deny to reject.",
  ].join("\n");
}

export function formatPendingApprovalReminder(
  pending: PendingApproval,
  adapterState: BridgeAdapterState,
): string {
  if (adapterState.kind === "claude") {
    const target = pending.toolName
      ? `${pending.toolName}${pending.detailPreview ? ` (${pending.detailPreview})` : ""}`
      : pending.commandPreview;
    return `Approval is pending for ${truncatePreview(target, 140)}. Reply with /confirm, confirm, or yes to continue, or /deny, deny, or no to reject.`;
  }

  return `Approval is pending for ${pending.commandPreview}. Reply with /confirm ${pending.code} or /deny.`;
}

export class OutputBatcher {
  private readonly onFlush: (text: string) => Promise<void> | void;
  private readonly flushIntervalMs: number;
  private readonly normalMaxChars: number;
  private readonly stressedMaxChars: number;
  private readonly isStressed: () => boolean;
  private buffer = "";
  private recentText = "";
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private drainTask: Promise<void> | null = null;
  private forceFlush = false;

  constructor(
    onFlush: (text: string) => Promise<void> | void,
    flushIntervalMs = 800,
    maxChars = 200,
    isStressed: () => boolean = () => false,
    stressedMaxChars = 1_500,
  ) {
    this.onFlush = onFlush;
    this.flushIntervalMs = flushIntervalMs;
    this.normalMaxChars = maxChars;
    this.stressedMaxChars = stressedMaxChars;
    this.isStressed = isStressed;
  }

  /**
   * Append text to the buffer and kick the drain loop. The drain decides
   * chunk boundaries each iteration based on the CURRENT stress flag, so
   * if iLink throttling activates mid-stream the remaining buffer is
   * automatically merged into a single big chunk instead of continuing to
   * fire sentence-sized retries.
   */
  push(text: string): void {
    const normalized = normalizeOutput(text);
    if (!normalized) {
      return;
    }

    this.buffer += normalized;
    this.recentText = (this.recentText + normalized).slice(-6_000);
    this.kickDrain();
    this.ensureFlushTimer();
  }

  /**
   * Force everything currently buffered out as a single chunk, bypassing
   * sentence-break logic. Called from the bridge's final_reply path.
   */
  async flushNow(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.forceFlush = true;
    this.kickDrain();
    if (this.drainTask) {
      await this.drainTask;
    }
  }

  clear(): void {
    this.buffer = "";
    this.recentText = "";
    this.forceFlush = false;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }

  getRecentSummary(maxLength = 280): string {
    return summarizeOutput(this.recentText, maxLength);
  }

  private kickDrain(): void {
    if (this.drainTask) {
      // A drain is already running; it'll see the new buffer / forceFlush
      // on its next loop iteration. No need to spawn another.
      return;
    }
    this.drainTask = this.runDrain().finally(() => {
      this.drainTask = null;
      // Race: a push() that arrived just after the loop's last buffer
      // check would see drainTask still set and skip kickDrain. Re-check
      // here and kick again if needed.
      if (this.buffer) {
        setTimeout(() => this.kickDrain(), 0);
      }
    });
  }

  private async runDrain(): Promise<void> {
    const MIN_SENTENCE_FLUSH = 4;
    while (this.buffer) {
      const stressed = this.isStressed();
      const drainAll = this.forceFlush || stressed;

      let chunk: string | null = null;
      if (drainAll) {
        // Take as much as the stressed ceiling allows — typically the
        // entire buffer, but capped so we never send a single multi-MB
        // message to iLink even if the turn is huge.
        const take = Math.min(this.buffer.length, this.stressedMaxChars);
        chunk = this.buffer.slice(0, take);
        this.buffer = this.buffer.slice(take);
      } else {
        const breakIdx = this.findSentenceBreak(this.buffer, MIN_SENTENCE_FLUSH);
        if (breakIdx >= 0) {
          chunk = this.buffer.slice(0, breakIdx + 1);
          this.buffer = this.buffer.slice(breakIdx + 1);
        } else if (this.buffer.length >= this.normalMaxChars) {
          chunk = this.buffer.slice(0, this.normalMaxChars);
          this.buffer = this.buffer.slice(this.normalMaxChars);
        } else {
          // Nothing safe to send yet; wait for more push() or flushNow().
          return;
        }
      }

      const payload = chunk ? chunk.trim() : "";
      if (!payload) continue;

      try {
        await Promise.resolve(this.onFlush(payload));
      } catch {
        // onFlush is expected to handle its own errors (the bridge's
        // queueWechatMessage already logs/swallows transport failures).
      }
      // Loop top re-evaluates isStressed() — if the send we just awaited
      // tripped the stress flag, the next chunk drains as a single block.
    }
    // Buffer fully drained — reset the force flag so the next turn starts
    // in normal mode again.
    this.forceFlush = false;
  }

  private findSentenceBreak(text: string, minLength: number): number {
    // Need at least minLength chars before we'll consider flushing,
    // so very short fragments ("好。") wait for more context.
    if (text.length < minLength) return -1;

    // Chinese punctuation: 。！？； — always a sentence end.
    // English . ! ? — only count when NOT inside URLs/numbers/abbreviations:
    //   - "." must follow a non-digit AND be followed by whitespace/EOL
    //     (so github.com is preserved, "1. " is preserved, "hi. " breaks).
    //   - "!" / "?" must follow a non-digit and be followed by whitespace/EOL.
    // Double newline is also a hard break.
    const re = /[。！？；]|(?<!\d)[.!?](?=\s|$)|\n\n/g;
    const m = re.exec(text);
    return m ? m.index + m[0].length - 1 : -1;
  }

  private ensureFlushTimer(): void {
    if (this.flushTimer || !this.buffer) {
      return;
    }

    // Idle backstop: if no further push() arrives, flush whatever's left.
    // Stressed mode is patient — gives the turn time to finish — but not
    // forever. Normal mode keeps the chatty real-person feel.
    const interval = this.isStressed() ? 30_000 : this.flushIntervalMs;

    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flushNow();
    }, interval);
  }
}

export function shouldDropStartupBacklogMessage(
  createdAtMs: number | undefined,
  bridgeStartedAtMs: number,
  graceMs = MESSAGE_START_GRACE_MS,
): boolean {
  if (!Number.isFinite(createdAtMs)) {
    return true;
  }

  return (createdAtMs as number) < bridgeStartedAtMs - graceMs;
}
