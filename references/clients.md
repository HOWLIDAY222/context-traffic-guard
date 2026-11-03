# 客户端接入

同一套监控核心接收各客户端适配后的事件。模型品牌不等于客户端接口；网页/手机普通聊天若没有本地执行和生命周期数据，不能靠加载 Skill 获得后台监测能力。

## 能力与验证范围

| 客户端 | 压缩 | Token / 上下文 | 请求速率 | 提醒 |
| --- | --- | --- | --- | --- |
| Codex | 前后事件配对的完成次数 | 模型请求 Hook | 请求 Hook 配对 | Hook 提示与 Skill |
| Claude Code | 前后事件配对的完成次数 | 可选状态栏的当前上下文快照，含缓存读写 | 当前适配器不提供 | 提交提示/工具后 Hook、可选状态栏 |
| Gemini CLI | PreCompress 触发次数；完成次数未知 | 详细模式下的模型事件，字段可能不完整 | 详细模式中可识别的生成结束标记窗口；含流式 Hook 开销 | BeforeAgent / AfterTool 上下文或终端提示 |
| Grok 本地 Agent | camelCase Hook 的前后配对 | 可选状态栏中的上下文百分比；未公开的 Token 字段不猜测 | 当前适配器不提供 | 状态栏或显式读取报告；普通 Hook 的 stdout 被宿主忽略 |
| 其他 Agent / API 程序 | 通用 v1 事件 | 调用方提供规范化数值 | 配对事件或明确报告的耗时 | 调用方消费提醒 JSON |

各适配器按官方公开契约实现并做事件回放测试。三平台 CI 验证核心、适配代码和系统网卡枚举；不代表四个客户端都已用真实模型完成集成测试。完整实时接入目前只有此前的 Windows Codex 验证；不要将协议回放说成真实模型实测。

## 安装 Skill

将仓库作为一个完整目录放到相应客户端的 Skill 位置，保留 scripts、references 和 integration：

| 客户端 | 常用用户级目录 |
| --- | --- |
| Codex | ~/.codex/skills/context-traffic-guard |
| Claude Code | ~/.claude/skills/context-traffic-guard |
| Gemini CLI | ~/.gemini/skills/context-traffic-guard |
| Grok | ~/.grok/skills/context-traffic-guard |

部分客户端也支持共享的 ~/.agents/skills；以各客户端当前发现规则为准，不假设路径相同。安装 Skill 与启用 Hooks 是两步；已有目录先备份比较。

## 生成接入配置

配置生成器只打印草案，不写入任何活动设置：

```text
node scripts/configure.mjs hooks --client claude --skill-dir "<ABSOLUTE_SKILL_DIR>" --state-dir "<ABSOLUTE_STATE_DIR>"
```

client 可选 codex、claude、gemini、grok。Node 默认使用生成命令当前正在运行的可执行文件，也可用 --node 指定绝对路径。默认状态目录为 ~/.context-traffic-guard；多个客户端可以共享，但会话数据按客户端/来源隔离。兼容旧版 Codex 的显式状态目录和原有未带 --client 的命令。

没有空格和 Shell 元字符的 Node 路径可生成跨 Shell 的裸命令前缀。Node 路径含空格时，须按宿主实际使用的 Shell 追加 --shell powershell、posix 或 cmd：PowerShell 需要 & 调用运算符，而 Bash 不使用该前缀。不要仅按操作系统猜宿主 Shell（例如 Windows 上的 Claude Code 可能使用 Git Bash）。生成器遇到无法安全引用的路径会停止，不自行改设置。脚本参数路径使用引号保护。

审核生成的 JSON，仅合并本工具的 Hook，保留现有设置并避免重复注册。配置位置通常为：

- Codex：~/.codex/hooks.json，并完成正常 Hook 信任审核。
- Claude Code：~/.claude/settings.json 中的 hooks。
- Gemini CLI：~/.gemini/settings.json 中的 hooks。timeout 单位是毫秒，不能复制 Codex 的秒数。
- Grok：~/.grok/hooks/context-traffic-guard.json；项目级 Hook 需完成正常信任流程。不要绕过宿主审核。

Gemini 的轻量默认配置不注册 BeforeModel / AfterModel。需要请求 Token 或速率时，用下列命令生成替代配置，择一合并：

```text
node scripts/configure.mjs hooks --client gemini --detailed --skill-dir "<ABSOLUTE_SKILL_DIR>" --state-dir "<ABSOLUTE_STATE_DIR>"
```

AfterModel 可能在每个流式片段触发；启动外部命令会有额外开销。详细模式仅在需要这些指标时启用，不为了监控默认增加每片段的进程开销。没有结束标记、请求重叠或信息不足时，不产生速度；只有 totalTokenCount 时不编造输入/输出分项。尾部无请求 ID 的 usage 只作为最新观察值，不追加到历史请求总量。

若宿主传递了额外 usageMetadata 字段，则按 Gemini 口径将明确提供的 toolUsePromptTokenCount 加到输入，将 thoughtsTokenCount 加到候选输出；缓存计数仍是输入子集。宿主只转发总数时，分项继续为未知。FINISH_REASON_UNSPECIFIED 和多候选边界不作为完整生成结束。未结束的请求在 AfterAgent 标记为 unresolved，不伪造失败或完成，也不污染下一轮配对。

## Claude / Grok 可选状态栏

生成单独的状态栏配置片段：

```text
node scripts/configure.mjs statusline --client claude --skill-dir "<ABSOLUTE_SKILL_DIR>" --state-dir "<ABSOLUTE_STATE_DIR>"
node scripts/configure.mjs statusline --client grok --skill-dir "<ABSOLUTE_SKILL_DIR>" --state-dir "<ABSOLUTE_STATE_DIR>"
```

Claude 输出 statusLine JSON 片段；Grok 输出 [ui.status_line] TOML 片段。先检查已有状态栏，需要时与原脚本整合，不直接覆盖用户已有内容。Grok 官方说明命令状态栏的 Windows 接入未验证，需在对应客户端实际确认；Node 的协议回放通过不改变这一边界。

Claude 的 context_window.total_input_tokens / total_output_tokens 是当前上下文数据，不是整个会话的累计消耗。缓存创建和缓存读取都包含在当前输入中；状态栏重复刷新不会生成多次模型请求记录。压缩后字段为空时清除旧快照，不补成零。

Grok 官方状态栏常用字段未保证包含会话 ID。输入缺少 ID 时，本脚本只显示上下文和 unbound，不把数据绑定到其他窗口。明确知道当前会话 ID 时可追加 --session；若宿主确实提供 GROK_SESSION_ID 环境变量，也可自动使用。不能用工作目录、进程 ID或“最近会话”猜身份。

## 查看与交接

```text
node scripts/guard.mjs clients
node scripts/guard.mjs list-sessions --client claude --state-dir "<STATE_DIR>"
node scripts/guard.mjs report --client claude --session "<RAW_SESSION_ID>" --state-dir "<STATE_DIR>"
```

对 Gemini、Grok 使用对应 client。自定义来源还须带 --source，见 [通用事件契约](events.md)。列表只读取已采集的本地数据库，不扫描历史会话。源码默认仍兼容旧 Codex 命令；新配置始终明确传递 --client。

缺少自动注入渠道的客户端，由状态栏提醒用户，并由 Agent 在被调用或阶段交付时读取报告。交接摘要由当前 Agent 根据任务实际状态编写；监控数据库不保存任务正文，不能代替任务交接材料。各 Agent 按同一套 SKILL.md 生成摘要，不创建或发送到另一个对话。

流量与客户端独立，可用同一套系统网卡或可选代理采样，见 [monitoring.md](monitoring.md)。它覆盖其他程序或多个对话，不能据此归因给当前 Agent。

## 官方依据

- [Codex Hooks](https://learn.chatgpt.com/docs/hooks)
- [Claude Code Hooks](https://code.claude.com/docs/en/hooks)、[Status line](https://code.claude.com/docs/en/statusline)
- [Gemini CLI Hooks](https://geminicli.com/docs/hooks/reference/)
- [Gemini API UsageMetadata 与 finishReason](https://aistudio.google.com/api-reference/generate-content)
- [Grok Hooks](https://docs.x.ai/build/features/hooks)、[Status line](https://docs.x.ai/build/features/status-line)
