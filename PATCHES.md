# 本仓库相对上游 UNLINEARITY/CLI-WeChat-Bridge 的本地补丁与待办

> 本文档列出 fork 中已经合入的修改与遗留问题，方便后续追溯。技术细节为主，不做风格化叙述。

## 已合入的补丁（启动新 bridge 即生效）

| Patch | 文件 | 解决的问题 |
|---|---|---|
| inbound 图片解密下载 | `src/wechat/wechat-transport.ts` | 用户发图能被 agent 看到 |
| typing 指示器 + 4s 心跳 | `src/wechat/wechat-transport.ts` | "对方正在输入"不会中途消失 |
| busy 时 defer 而非 reject | `src/bridge/wechat-bridge.ts` | 紧跟着发的消息不丢 |
| drain 队列允许 claude | `src/bridge/wechat-bridge.ts` | defer 的消息会被处理 |
| QR 输出 URL | `src/wechat/setup.ts` | Claude Code 终端能扫到二维码 |
| OutputBatcher 按句切 | `src/bridge/bridge-utils.ts` | 流式输出按句切段 |
| forwardWechatFinalReply 按句切 | `src/bridge/bridge-final-reply.ts` | 最终回复也按句切，不再一坨 |
| sentence regex 加 lookbehind | `bridge-utils.ts` + `bridge-final-reply.ts` | URL 里的 `.com` / 数字编号 `1.` 不再被误切 |
| **exit-code-0 当正常退出** | `src/bridge/bridge-adapters.core.ts` | claude 自然结束 turn 时 bridge 不再误判 fatal、不丢 in-flight 消息 |
| **still-working 延迟 12s → 60s** | `src/bridge/bridge-adapters.shared.ts` | "Claude is still working..." 提示频率降低 |
| **runtime settings 合并 cwd settings** | `src/bridge/claude-hooks.ts` + `bridge-adapters.claude.ts` | `--settings <runtime>` 注入 cwd 的字段（含 `model`、`permissions`）；hooks 由 bridge owner。**实测对 model 字段无效** —— Claude Code 内部对 model 的解析优先级高于 `--settings` 来源，已放弃，留代码备查 |
| **peer-reap 按 --cwd 范围过滤** | `src/bridge/bridge-process-reaper.ts` + `wechat-bridge.ts` | 多 channel 部署（不同 `CLAUDE_WECHAT_CHANNEL_DATA_DIR`）启动时不再互砍；只清理同 cwd 的残留 bridge |
| **sendMessage 校验 errcode** | `src/wechat/wechat-transport.ts` | iLink 限流时返 HTTP 200 + errcode!=0，原版只看 res.ok 直接当成功；现在会 throw，bridge.log 会记下 "Failed to send WeChat message" |
| **outbound text 加 800ms 最小间隔** | `src/bridge/wechat-bridge.ts` (`queueWechatTextAction`) | 长 narration 拆成 18 句快连发会被 iLink 限流丢尾；自我节流到 800ms/句、18 句约 15s 走完（400ms 实测仍触发 ret=-2） |
| **sendMessage 遇 ret=-2 自动重试一次** | `src/wechat/wechat-transport.ts` | iLink 偶发性 ret=-2 软拒绝；sleep 1.5s 后重试，避免单句卡掉破坏后续节奏 |
| **关键消息走 critical-retry**（approval/fatal/task_failed/inbound_error） | `src/bridge/wechat-bridge.ts` (`queueWechatMessage`) | 审批弹框被 iLink 限流吞掉会让 agent 卡 10 分钟；critical context 内嵌 5 次指数退避（2/4/8/16/32 秒）直到送达 |
| **bridge 端预审批安全 Bash**（`mkdir/cat/git/cp/mv/echo` 等复合命令） | `src/bridge/claude-hooks.ts` + `bridge-adapters.claude.ts` | claude 内置匹配器对 `mkdir && cat <<EOF` 这类复合命令不认 `Bash(*)`；bridge 在转发审批前用白名单 + 危险词黑名单（sudo/rm -rf/dd/curl\|sh 等）+ heredoc 剥离做预批，纯 WeChat 用户看不到 TUI 也不会被这种事卡死 |

外加：node-pty 需从源码重新编译以解决 Node 25 不兼容的 `posix_spawnp failed` 报错。

---

## 待办

### 1. "Claude is still working on:" 提示不优雅

**现象**：每次发消息触发 still-working notice 时，bridge 会把用户原话作为 prefix 重复一遍：

```
Claude is still working on:
第一，你在骗人，你已经结束了对话。第二，你那个脚本好像停了
```

**建议**：把"原话回显"删掉，只保留"⌛ 还在跑"四个字 + 一个简短当前任务标签；或者干脆只发首次提示，后续静默（用 typing 心跳替代）。

**位置**：`src/bridge/wechat-bridge.ts` line 1267 附近的 `is still working` 字符串拼装；以及 `src/bridge/bridge-adapters.claude.ts` line 558 的 `emitClaudeNotice` 调用。

暂存档。

### 2. ~~claude worker exit code 0 被误判成 fatal_error~~ **已修**

### 3. ~~中间 narration 不发到微信~~ **已修**

实现：新建 `transcript-watcher.ts` 监听 jsonl 文件 → 提取 assistant text block → emit `stdout` event 走 OutputBatcher 流式发到微信。`final_reply` event 加 `attachmentsOnly` 标记。

**最终契约**（修了 race 后定的）：

- claude adapter 的 `final_reply` 永远 `attachmentsOnly: true` —— text 发送 100% 由 watcher 负责（按 uuid 去重，exactly once）
- final_reply 只发 attachments（image/file/voice/video）
- 边缘情况：如果 watcher 完全失灵（fs.watch 在某些 FS 不触发等），用户会收到 attachments 但收不到 text —— 比"每条发两遍"体验好很多，且明显可见
- watcher emit 前会 strip 掉 `\`\`\`wechat-attachments ... \`\`\`` 协议块（避免用户看到 markdown 协议字符串）

### 4. ~~`<task-notification>` 等系统注入消息被当作 user input forward 到微信~~ **已修**

`shouldForwardBridgeEventToWechat` 检测 `^<task-notification|command-name|system-reminder|user-prompt-submit-hook|local-command-stdout|stderr|caveat>` 形式的字符串，跳过 forward。子 agent 完成的 task-notification、`!` 命令的 stdout、slash 命令镜像等内部协议字符串不再泄露到用户微信。

### 5. claude TUI input handler 在 background agent 期间偶发卡顿

**现象**：sub-agent 后台跑、主对话从 busy 切到 idle 的瞬间，bridge 经 PTY 写入的 inbound 字符流被 claude TUI buffer 但不 commit 成新 turn。jsonl 没新 user message，CPU 低，但表面 typing 心跳照转。在终端键盘按一下 Enter 后能恢复。

**疑似根因**：claude TUI 的 input event loop 在某些状态过渡时没及时读取 PTY。

**待办的 workaround**：sendInput 后延迟 N ms 额外 poke 一次 PTY（fake SIGWINCH / 多发一个 `\r`）强制刷新。风险：可能误 submit 空 turn 或与 claude TUI 内部状态冲突，需谨慎。

**优先级**：低，遇到时键盘按 Enter 即可恢复。

### 6. 流式 narration 在 pre-tool 阶段不 forward

**现象**：agent 在终端里写"你说得对，刚那句是空话——..."，但因为它接着调 Bash 工具，这段叙述会被识别为 pre-tool narration 而不 forward 到微信。

**修复路径（如有需要）**：让 bridge 的 stream text block 也通过 outputBatcher → 微信，而不仅在 `final_reply` event 时才 forward。

**风险**：可能刷屏。但 OutputBatcher 已按句切 + 4s 心跳节流，体验大概率 OK。

暂存档。
