# 接入与指标说明

## 实现分工

- scripts/guard.mjs hook：接收官方生命周期事件，使用本地 SQLite 按会话和可取得的代理标识分别记账。来源没有提供代理标识时，不能保证区分子代理，报告会标明覆盖。失败返回空 JSON，不阻止请求或工具。
- 自动模式在 Hook 事件中短时读取明确指定的本机 Mihomo 命名管道，仅请求 /connections；不会启动常驻进程。scripts/traffic.mjs 保留为用户要求诊断时的有限时长采样工具，不访问外部站点、不读取代理配置或密钥。
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

状态目录由安装配置指定，建议 ~/.codex/context-traffic-guard-state；草案验证使用独立的 verification/。按会话及可取得的代理标识分组，所有后台采样器共用一份本机流量时间序列。

自动模式使用 --sample-traffic --pipe 本地管道，在请求与工具等生命周期事件处读取累计流量，最多约每 500 毫秒更新一次；一次本地读取最多等待约 150 毫秒，不可达时留空，任务继续。没有常驻进程，不在空闲时持续轮询，也不因后台子进程拖住命令行退出。请求之间的总字节增量仍可测量，但进程细分采样下界可能较低。

只保留最近约 2 小时的事件流量样本；会话计数、请求数值与趋势保留在本地。不会保存提示、正文、工具结果、原始错误内容、域名浏览记录或认证数据。删除状态前应另行确认，删除会导致计数覆盖丢失。

## 安装前与接入验证

需要 Node.js 24 或更新版本（内置 node:sqlite）与支持下列事件的 Codex Hooks。参考验证环境为 Windows、Node.js 24.22.1、Codex CLI 0.166.0-alpha.5.1；其他版本需核实事件支持。这不等于当前会话已收到回调。

1. 审核 Skill、采集脚本、提醒策略和 Hook 草案；备份将要更改的现有配置，仅合并本方案事件，避免在多个配置层重复注册。
2. 安装到已批准目录。首次旧会话引导应在启用 Hooks 之前执行，避免历史记录与新回调重叠计数；只读指定文件一次。无法确认完整历史时，明确标为“指定记录内”或“接入后”计数。
3. 按 Codex 的 /hooks 信任审核流程批准确切配置；不使用绕过信任的启动选项。
4. 实际验证一次普通模型请求，确认前后事件配对、Token 和耗时有值；在自然压缩后确认计数增长。不要仅为测试而反复强制压缩或调用模型。
5. 确认流量样本更新、告警不重复、提醒不会阻塞任务，并用一个阶段交付检查交接摘要。未完成这些验证不能称“持续监测已生效”。

当前命令示例（实际执行时替换为已批准路径）：

    node --no-warnings <skill>/scripts/guard.mjs report --session <会话ID> --state-dir <状态目录>
    node --no-warnings <skill>/scripts/audit-rollout.mjs --rollout <明确指定的会话文件>
    node --no-warnings <skill>/scripts/traffic.mjs --state-dir <状态目录> --pipe <本机命名管道> --seconds 10
    node --no-warnings --test <skill>/scripts/guard.test.mjs

integration/policy.json 中的次数、倍数和用量都是试行提醒值，可以调整；不能包装成官方技术临界值。配置只控制本工具的提醒，不修改模型或账号限额。

## 官方依据

- [Hooks](https://learn.chatgpt.com/docs/hooks)：压缩与请求事件、字段、输出和信任审核。
- [App Server](https://learn.chatgpt.com/docs/app-server)：压缩与 Token 更新事件；本文不伪装已附着到现有 App Server 事件流。
- [Compaction](https://developers.openai.com/api/docs/guides/compaction)：压缩用于减少上下文并保留状态，次数不代表体积单调增长。
