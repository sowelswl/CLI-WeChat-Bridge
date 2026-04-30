# scripts/

通用部署脚本，目前覆盖一种场景：**多账号同机部署 + tmux 守护**。

适用平台：macOS（已实测）/ Linux（结构兼容，未广泛测）。

## 文件

- `wechat-bridges-up.sh` —— 把一个或多个 channel 拉起来跑在 detached tmux session 里，崩了 5s 自动重启
- `wechat-bridges-down.sh` —— 停掉指定 session
- `wechat-inject.sh` —— 给运行中的 bridge 注入一条"伪装成微信消息"的提示，常配合 cron 用作定时任务（详见下方"定时任务"段）

## 前置

- `tmux` 在 PATH 上（`brew install tmux` / `apt install tmux`）
- 已经从仓库根 `npm install -g .`（这样 `wechat-claude-start` 在 PATH 上）
- 已经给目标 channel 用 `bun run setup` 扫码登录，凭据落在 `~/.claude/channels/wechat-<letter>/account.json`

## 默认行为

不带参数运行 `wechat-bridges-up.sh` 会拉起 channel `A` 和 `B`：

- channel data dir：`~/.claude/channels/wechat-A` 和 `~/.claude/channels/wechat-B`
- 工作目录：`~/wechat-channels/A` 和 `~/wechat-channels/B`（自己提前 `mkdir`）
- tmux session 名：`wechat-A`、`wechat-B`

## 自定义工作目录

每个 channel 的工作目录可以由环境变量覆盖：

```bash
export WECHAT_CHANNEL_A_WORKSPACE=/Users/alice/projects/work
export WECHAT_CHANNEL_B_WORKSPACE=/Users/alice/projects/personal
./scripts/wechat-bridges-up.sh A B
```

变量名规则：`WECHAT_CHANNEL_<大写字母>_WORKSPACE`。脚本支持任何字母/单词作为 channel 名（不只是 A/B），只要环境变量同步声明就行：

```bash
export WECHAT_CHANNEL_HOME_WORKSPACE=/Users/alice/projects/home
./scripts/wechat-bridges-up.sh HOME
# tmux session: wechat-HOME
# channel data: ~/.claude/channels/wechat-HOME
```

## 用法

```bash
# 拉起默认 A、B
./scripts/wechat-bridges-up.sh

# 只拉 A
./scripts/wechat-bridges-up.sh A

# 拉自定义 channel
./scripts/wechat-bridges-up.sh HOME WORK

# 停掉 A、B
./scripts/wechat-bridges-down.sh

# 停掉指定 channel
./scripts/wechat-bridges-down.sh HOME

# 看里面在跑啥（attach 进 TUI；Ctrl+B 后 D 退出，进程不停）
tmux attach -t wechat-A

# 列出当前所有 wechat session
tmux ls | grep '^wechat-'
```

## 开机自启（macOS）

最稳的姿势：把 `wechat-bridges-up.sh` 放到 `~/.zshrc` / `~/.zprofile` 里，依赖 Terminal.app 启动时的 TCC 权限：

```bash
# ~/.zshrc 末尾加上
if [[ -o interactive ]] && command -v tmux >/dev/null 2>&1; then
  if ! tmux has-session -t wechat-A 2>/dev/null || ! tmux has-session -t wechat-B 2>/dev/null; then
    /path/to/repo/scripts/wechat-bridges-up.sh >/dev/null 2>&1
  fi
fi
```

再到 **系统设置 → 通用 → 登录项** 把 `Terminal.app` 加进去（可以选择隐藏，但新版 macOS 不一定生效，可能开机会冒一个 Terminal 窗口出来，关掉就行）。

## 定时任务（cron + inject）

> **macOS TCC 坑提醒（重要）**：macOS 的 cron 由 launchd 拉起，没权限**执行**位于 `~/Desktop/` 下的脚本——cron 邮箱里会看到 `Operation not permitted`，cron 任务跑了等于没跑。但 cron **能 *写入* `~/Desktop/`**，所以脚本只要不在 Desktop 里就能正常工作。
>
> **简单解法**：把 `wechat-inject.sh` 复制（不是 symlink，symlink 解析后还是 EPERM）到 `~/.local/bin/`，crontab 里用复制后的路径调用：
>
> ```bash
> mkdir -p ~/.local/bin
> cp <repo>/scripts/wechat-inject.sh ~/.local/bin/
> chmod +x ~/.local/bin/wechat-inject.sh
> # crontab 里写 /Users/<you>/.local/bin/wechat-inject.sh ... 而不是 <repo>/scripts/...
> ```
>
> 同样原因，**不要用"跑完 crontab 自删自己"的复合命令**（`... && crontab -l | grep -v X | crontab -`）——cron 启的 shell 跑 `crontab` 写临时文件也受 TCC 限制。老实写循环 cron 表达式即可（`0 9 * * *`）。


Claude Code 自带的 `CronCreate` 只在 REPL 空闲时触发，agent 在跑时事件就会被错过。Bridge 这层提供了一个更可靠的替代：**在 agent 的工作目录下放一个 `.inject/` 文件夹，bridge 监听这个目录，任何写入的文件会被当作"伪装成微信消息"送进去**。这条路享受 bridge 全套的 busy-defer / typing / 输出回显逻辑——agent 在跑也不会丢消息，会排队到下一个 idle 周期。

最简用法：

```bash
# 用 wechat-inject.sh 包好（推荐，自动原子重命名）
./scripts/wechat-inject.sh ~/wechat-channels/A "提醒我拍照吃药"

# 或手动写文件（注意必须用 .tmp 中转，否则 bridge 可能读到半写状态）
F=~/wechat-channels/A/.inject/$(date +%s)
echo "提醒我拍照吃药" > $F.tmp && mv $F.tmp $F
```

cron 的典型用法：

```cron
# crontab -e
# 早 9 点提醒拍照吃药
0 9 * * * /path/to/repo/scripts/wechat-inject.sh /Users/me/wechat-channels/A "提醒我拍照吃药"

# 工作日盘前 8:55 跑一次 /aniu
55 8 * * 1-5 /path/to/repo/scripts/wechat-inject.sh /Users/me/wechat-channels/A "跑 /aniu 盘前分析"
```

注意点：

- inject 文件最大 64KB（防止 OOM）
- 文件名不限，但 `.tmp` 后缀会被 bridge 跳过（用作原子重命名的中转）
- bridge 处理完会立即 unlink；处理失败也会 unlink（避免死循环），但错误会写到 `bridge.log`
- 同一个 inject 在 agent 视角看就是"用户主动发了一条微信消息"，agent 的回复也会走正常的 WeChat 输出通道——你的微信会收到 agent 的回复

## 为啥不直接走 launchd？

试过，会被 macOS TCC 卡住：launchd 启动的 node 进程默认无权限读 `~/Desktop/`，工作目录在 Desktop 下的话会一启动就 EPERM 崩。要走 launchd 有两条路：

1. 把工作目录挪出 `~/Desktop/`（比如 `~/Documents/` 或 `~/Library/Application Support/...`）
2. 在 **系统设置 → 隐私与安全 → 完全磁盘访问权限** 给 `/opt/homebrew/bin/node` 开权限

如果不在 Desktop 下，也可以用 LaunchAgent，参考网上 `~/Library/LaunchAgents/<label>.plist` 模板写一份就行，本文档不展开。
