# 接入与指标说明

本文件描述共用的数值与网络采样。客户端安装、能力差异与配置生成见 [clients.md](clients.md)；自建 Agent 通过 [events.md](events.md) 接入。下表中的 PreModelRequest 等名称是内部/Codex 兼容事件，不表示其他宿主提供同名接口。

## 实现分工

- scripts/adapters.mjs：将 Codex、Claude Code、Gemini CLI、Grok 或通用 v1 事件转换为内部数值事件，过滤任务正文，并按客户端真实支持的渠道格式化提醒。
- scripts/guard.mjs hook：接收生命周期事件，使用本地 SQLite 按客户端、会话和可取得的代理标识分别记账。来源没有提供代理标识时，不能保证区分子代理，报告会标明覆盖。失败返回空 JSON，不阻止请求或工具。
- scripts/configure.mjs：只打印各客户端的 Hook/可选状态栏配置草案，不写入活动配置。
- 核心 Hook 不依赖代理或特定操作系统。可选代理模式在 Hook 事件中短时读取明确指定的本机 Mihomo 接口，仅请求 /connections；支持 Windows 命名管道、macOS/Linux Unix socket、回环 HTTP，不会启动常驻进程。scripts/traffic.mjs 同样支持这些来源，保留为有限时长采样工具。
- scripts/system-traffic.mjs：无需代理的系统网卡计数适配。Windows 使用 Get-NetAdapterStatistics；macOS 使用 netstat -ibn 的链路层字节行；Linux 使用 /proc/net/dev。明确选择一张接口，不合计物理和虚拟网卡。原生命令可能较慢，在独立的限时采样命令中执行，不接入每次模型请求的 Hook。
- scripts/audit-rollout.mjs：对明确指定的本地会话文件做一次历史引导，只数顶层压缩记录，不把嵌套的继承历史重复计入；历史速度无可靠时间戳时不生成估计。
- integration/hooks.preview.json：通用路径占位模板，默认只记录压缩与请求指标；必须替换绝对路径后才可合并到活动配置。可选流量采样需另加 --sample-traffic --pipe 参数。普通 Skill 安装并不等于持续采集已接通。

## 官方事件与指标

| 事件 | 用途 |
| --- | --- |
| PreCompact、PostCompact | 配对后累计已完成压缩。缺少前置事件只记为未配对事件，不编造完成次数。 |
| PreModelRequest、PostModelRequest | 配对每次模型尝试的耗时、状态、Token；失败与重试分别记录。 |
| SessionStart、UserPromptSubmit | 建立或恢复当前会话，并按已审核配置读取一次累计流量。 |
| PostToolUse、UserPromptSubmit | 只在有新告警且通过冷却时间时，加入很短的监测提示。 |
| PostCompact、Stop | 可在界面显示提醒，不使用阻断决策，也不让 Stop 自动创建续跑循环。 |

模型请求耗时从前置回调到后置回调，包含排队、网络、推理和生成，不包括两次请求之间的工具耗时。有效速率是输出 Token/该耗时，不是纯解码 tok/s，也不是首字速度。当前 Hook 没有可靠的首 Token 时间；TTFT 保持空值。

缓存 Token 是输入 Token 的子集，不重复相加。缺失 Token 是未知，不是零。这里只记录采集到的消耗，无法推算 ChatGPT 账号剩余额度；需查看剩余额度时，按需使用可用的官方账号用量工具，不读取凭证。

同一会话并发且没有请求 ID，无法无歧义配对时，不计算该次速度。模型、输入/输出规模与缓存比例不同会改变速度，比较只能提示关联，不能证明压缩造成限速或能力下降。

## 本地状态与采样开销

状态目录由配置指定；新接入建议共用 ~/.context-traffic-guard，旧 Codex 的 ~/.codex/context-traffic-guard-state 保持兼容。测试用独立目录。上下文按客户端、自定义 source、会话及可取得的代理标识分组。流量属于所选机器接口而非某个客户端，按来源、接口和计数段分别记录；报告采用最新来源，不跨来源求和。数据库保留旧版数值记录并增量增加所需字段，不清空历史。

可选代理自动模式使用 --sample-traffic，配合 --pipe、--socket 或 --endpoint 之一，在生命周期事件处读取累计流量，最多约每 500 毫秒更新一次；一次本地读取最多等待约 150 毫秒，不可达时留空，任务继续。HTTP 仅接受无认证信息的回环地址，不跟随重定向。没有自动常驻进程，不在空闲时持续轮询，也不因后台子进程拖住命令行退出。请求之间的总字节增量仍可测量，但进程细分采样下界可能较低。

系统网卡使用独立采样命令：默认 30 秒、每次读取后间隔约 5 秒；macOS 原生读取上限约 10 秒，Windows 约 30 秒以容纳繁忙机器上的 CIM 冷启动，停止时最长可能多等待一次读取。Windows 本机查询约 2.4 秒，但托管测试机器曾超过 10 秒，因此不放入请求 Hook。用户明确要求长时间观测时可设置有限时长（最多 24 小时），需保持该命令运行；不会因安装而自动启动。它只是系统网卡观测，不能提供跨平台的单进程精确流量。

写入流量样本时清理约 2 小时前的旧流量记录；停采后没有后台定时清理。会话计数、请求数值与趋势保留在本地。只额外保存区分来源所需的网卡名称、平台与数值游标，不保存提示、正文、工具结果、原始错误内容、域名浏览记录或认证数据。删除状态前应另行确认，删除会导致计数覆盖丢失。

## 安装前与接入验证

需要 Node.js 24 或更新版本（内置 node:sqlite）及所用客户端对应的事件或状态接口；通用 API 程序可自行发送 v1 事件。参考实时接入环境为 Windows、Node.js 24.22.1、Codex CLI 0.166.0-alpha.5.1。其他客户端的已实现适配契约、未提供指标与验证范围见 clients.md；不能把测试回放当作真实客户端已接入。

Windows、macOS、Linux 都提供原生网卡适配；测试在 GitHub Actions 的三个操作系统上运行。测试覆盖数值解析、来源隔离、计数回退和执行环境中的真实网卡枚举；它不等于每个平台的 Codex 桌面应用都完成接入验证。实际 Codex Hooks + 代理自动采样目前仅在 Windows 验证；其他平台仍应按步骤验证事件可达。没有 Hooks 的纯聊天环境不能声明已持续采集。

1. 审核 Skill、采集脚本、提醒策略和 Hook 草案；备份将要更改的现有配置，仅合并本方案事件，避免在多个配置层重复注册。
2. 安装到已批准目录。首次旧会话引导应在启用 Hooks 之前执行，避免历史记录与新回调重叠计数；只读指定文件一次。无法确认完整历史时，明确标为“指定记录内”或“接入后”计数。
3. 按 Codex 的 /hooks 信任审核流程批准确切配置；不使用绕过信任的启动选项。
4. 实际验证一次普通模型请求，确认前后事件配对、Token 和耗时有值；在自然压缩后确认计数增长。不要仅为测试而反复强制压缩或调用模型。
5. 确认流量样本更新、告警不重复、提醒不会阻塞任务，并用一个阶段交付检查交接摘要。未完成这些验证不能称“持续监测已生效”。

当前命令示例（实际执行时替换为已批准路径）：

    node --no-warnings <skill>/scripts/guard.mjs report --client <客户端> --session <原始会话ID> --state-dir <状态目录>
    node --no-warnings <skill>/scripts/audit-rollout.mjs --rollout <明确指定的会话文件>
    node --no-warnings <skill>/scripts/traffic.mjs --state-dir <状态目录> --pipe <本机命名管道> --seconds 10
    node --no-warnings <skill>/scripts/system-traffic.mjs list
    node --no-warnings <skill>/scripts/system-traffic.mjs sample --interface <单个网卡名> --state-dir <状态目录> --seconds 30
    node --no-warnings --test <skill>/scripts/guard.test.mjs <skill>/scripts/system-traffic.test.mjs <skill>/scripts/adapters.test.mjs

回环 HTTP 示例：给可选代理 Hook 命令追加 `--sample-traffic --endpoint http://127.0.0.1:9090`；macOS/Linux Unix socket 示例为 `--sample-traffic --socket /absolute/path/controller.sock`。实际地址须由用户明确提供或确认，示例不代表本机已配置。如果 HTTP 要求认证而本工具无认证参数，报告不可用，不修改控制器的安全设置。

integration/policy.json 中的次数、倍数和用量都是试行提醒值，可以调整；不能包装成官方技术临界值。配置只控制本工具的提醒，不修改模型或账号限额。

## 官方依据

- [Hooks](https://learn.chatgpt.com/docs/hooks)：压缩与请求事件、字段、输出和信任审核。
- [App Server](https://learn.chatgpt.com/docs/app-server)：压缩与 Token 更新事件；本文不伪装已附着到现有 App Server 事件流。
- [Compaction](https://developers.openai.com/api/docs/guides/compaction)：压缩用于减少上下文并保留状态，次数不代表体积单调增长。
- [Windows Get-NetAdapterStatistics](https://learn.microsoft.com/en-us/powershell/module/netadapter/get-netadapterstatistics)：系统网卡统计。
- [Apple netstat 实现](https://github.com/apple-oss-distributions/network_cmds/blob/main/netstat.tproj/if.c)：链路层与地址行、Ibytes/Obytes 字段。
- [Linux /proc/net/dev](https://man7.org/linux/man-pages/man5/proc_pid_net.5.html)：网卡计数和网络命名空间范围。
