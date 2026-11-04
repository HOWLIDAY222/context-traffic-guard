# Context Traffic Guard

**会话负担监测与交接**：面向本地 AI Agent 的通用监控核心，提供 **Codex、Claude Code、Gemini CLI、Grok** 接入，以及供其他 Agent / API 程序使用的 **v1 事件接口**。根据各客户端实际提供的压缩、上下文、Token、请求耗时和可选网络指标，提醒阶段交接并准备摘要。无需 Clash，不连接模型服务。

Client-independent context monitoring and handoff assistance, with Codex, Claude Code, Gemini CLI and Grok adapters plus a versioned event API for custom agents. Optional traffic adapters cover Windows, macOS and Linux. Missing metrics stay unknown; no model calls or credentials are required by the collector.

## 能做什么

- 规范化不同客户端的事件，分别记录完成的压缩、仅观察到的触发和可用的上下文占比。
- 在客户端提供对应数据时，记录请求 Token 与计时；状态快照、流式片段与真实请求分别处理，缺失值保持未知。
- 对可比请求的早期与近期样本做趋势比较，提醒输入增长或持续变慢。
- 可选读取 Windows、macOS、Linux 的系统网卡计数，明确选择一张接口；无需 Clash 或其他代理软件。
- 使用兼容代理的用户还可选择本机 Mihomo 接口，支持命名管道、Unix socket 和回环 HTTP，采用事件采样，无自动常驻后台进程。
- 合并重复提醒，在任务可恢复的阶段准备交接；采集失败不阻塞任务。
- 本地监测面板提供会话选择、四类真实趋势、提醒依据与数据缺口，以及可编辑、复制和下载的交接摘要。读取记录不调用模型。
- 一键入口自动检测系统与客户端、备份合并配置、准备必要的私有运行时、启动面板并请求浏览器打开；保留客户端自身的审核。

## 客户端支持

| 客户端 | 已实现的接入 | 指标边界 |
| --- | --- | --- |
| Codex | 请求/压缩 Hook 与提醒 | 与旧安装、历史数据保持兼容 |
| Claude Code | 生命周期 Hook + 可选状态栏 | 当前上下文/缓存快照不当作累计消耗；无每请求计时 |
| Gemini CLI | 轻量生命周期 Hook；可选详细模型 Hook | PreCompress 只有触发次数；详细模式需可靠结束标记与分项 Token 才能计算速率 |
| Grok 本地 Agent | camelCase 生命周期 Hook + 可选状态栏 | 被动 Hook 输出被忽略；用状态栏/显式报告提醒，未公开的 Token 和每请求耗时保持未知 |
| 其他本地 Agent / API 程序 | 规范化 v1 事件或 Node.js 模块接口 | 调用方报告数据、消费提醒；无需依赖上述任一客户端 |

详细配置、安装目录和官方契约见 [clients.md](references/clients.md)；自建 Agent 示例见 [events.md](references/events.md)。**能加载 SKILL.md 不等于接通自动监控。** 普通网页或手机聊天若没有本地执行与事件数据，只能复用人工交接流程。

**压缩次数不是性能临界值。** 本工具不能测量“变笨程度”、服务端压力或订阅剩余额度，也不能证明压缩导致限速。换对话不保证改善速度。

## 运行要求

- Node.js 24 或更新版本，使用内置 `node:sqlite`，无第三方运行依赖。
- 所用客户端支持对应的生命周期/状态接口，或调用方能发送通用事件。
- 核心功能无需代理。流量可选用系统网卡或兼容代理接口；未接入时显示未知，不影响压缩、Token 和请求指标。

参考完整接入环境：Windows、Node.js 24.22.1、Codex CLI 0.166.0-alpha.5.1。已验证真实请求的 Token、耗时和本地代理事件采样；自然压缩事件仍需在日常使用中确认。

| 能力 | Windows | macOS | Linux |
| --- | --- | --- | --- |
| 通用核心与各客户端适配代码 | Node.js + 宿主事件 | 同左 | 同左 |
| 无代理的网卡采样 | Get-NetAdapterStatistics | netstat -ibn | /proc/net/dev |
| 可选兼容代理接口 | 命名管道或回环 HTTP | Unix socket 或回环 HTTP | Unix socket 或回环 HTTP |

[三平台测试](https://github.com/HOWLIDAY222/context-traffic-guard/actions/workflows/test.yml)检查核心逻辑、客户端契约回放、CLI 输入输出、计数解析和真实网卡枚举。**协议回放不等于真实模型集成测试**：实时接入目前只有此前 Windows Codex 验证；Claude/Gemini/Grok 需在实际宿主中核对回调与显示。其他代理软件只有提供兼容接口时才能使用代理适配器，不保证任意软件都提供单进程流量。

## 一键接入（推荐）

安装完整 Skill 后，让支持本地操作的 Agent 首次启用它；也可直接启动：

| 系统 | 启动入口 |
| --- | --- |
| Windows | 双击 Start-Context-Guard.cmd |
| macOS | 双击 Start-Context-Guard.command |
| Linux | 运行 start-context-guard.sh |

向导自动识别客户端和数据目录、保留原配置并补全监测、启动面板与有限网卡采样。缺少 Node 24 时会下载并校验官方私有运行时，之后复用，无需改系统 PATH、安装 React 或配置 Clash。已有代理采样和历史目录继续沿用，多个独立数据目录可在页面切换。

**安装目录本身不会自动执行代码。** 首次启用由 Agent 运行向导，或用户双击一次入口；客户端要求的 Hook 审核仍须正常完成。面板区分“配置已就绪”和“已收到事件”。详见 [一键接入与恢复](references/setup.md)。

已有 Node 24 的命令行等价入口：

```sh
node --no-warnings scripts/setup.mjs
```

## 本地监测面板（只读启动）

仓库附带预构建界面，只需 Node.js 24，无需安装 React、Clash 或前端开发工具。在仓库目录运行：

```sh
node --no-warnings scripts/dashboard.mjs --state-dir "<STATE_DIR>"
```

在浏览器打开 **http://127.0.0.1:43871**，选择明确的客户端与会话。已有 Codex 安装的状态目录通常为 ~/.codex/context-traffic-guard-state；新通用接入通常为 ~/.context-traffic-guard，以实际采集器配置为准。目录不存在时显示接入引导，不创建数据库、不生成演示数据。

- **会话总览**：压缩次数、输入与缓存、可比请求速率、采样窗上传；切换输入、耗时、速率、网络趋势，查看最近请求。
- **诊断与依据**：展示观测信号、数据缺口、覆盖范围与下一步；不能仅凭一次高用量确定原因。
- **交接工作台**：当前 Agent 可提供绑定会话的任务草稿，也可手动编辑；监测信息自动带入，复制或下载 Markdown 后交给新对话。

这个直接启动方式只读取记录，默认每 5 秒刷新，可暂停；不修改 Hooks、不启动流量采样。首次接入优先使用上方一键入口。面板仅监听本机回环，不自动切换对话。明确选择当前窗口、传入 Agent 草稿及开发构建方法见 [面板说明](references/dashboard.md)。

## 手工接入（高级）

1. 克隆仓库，按 [客户端目录表](references/clients.md#安装-skill) 放置完整 Skill。若目录已有内容，先备份并比较。
2. 先运行测试：

   ```sh
   node --no-warnings --test scripts/guard.test.mjs scripts/system-traffic.test.mjs scripts/adapters.test.mjs scripts/dashboard.test.mjs scripts/setup.test.mjs
   ```

3. 使用配置生成器选择客户端并打印草案。例如 Claude Code：

   ```text
   node scripts/configure.mjs hooks --client claude --skill-dir "<ABSOLUTE_SKILL_DIR>" --state-dir "<ABSOLUTE_STATE_DIR>"
   ```

   client 可为 codex、claude、gemini 或 grok。生成器不会写活动配置；其他 Agent 使用通用事件接口。原 integration/hooks.preview.json 仅保留作 Codex 兼容模板，不给其他客户端直接复制。
4. 备份现有配置，只合并相应 Hook。Claude/Grok 的状态栏是独立可选配置，不覆盖已有状态栏。Gemini 默认不启用逐片段模型 Hook；需要时用 --detailed 生成替代配置，详见 clients.md。
5. 完成对应宿主的正常审核与信任流程，在实际会话中确认事件可达、提醒可见。仅安装目录或生成配置不能称为已持续监测。

通用模板默认只启用核心指标。流量按需选择下面任一来源；两种来源不相加。

### 不使用代理：系统网卡

先列出接口名称：

```sh
node --no-warnings scripts/system-traffic.mjs list
```

选择实际使用的一张网卡，启动有限时长采样：

```sh
node --no-warnings scripts/system-traffic.mjs sample --interface "<INTERFACE_NAME>" --state-dir "<STATE_DIR>" --seconds 30
```

Windows 可能是 `Wi-Fi` 或 `WLAN`，macOS 可能是 `en0`，Linux 可能是 `eth0`；这些只是示例，以实际列表为准。系统数据包含该网卡上所有程序的流量。不要把物理、VPN/TUN 和回环接口相加。命令默认读取后间隔约 5 秒，结束即停止；长时间观测需保持明确指定时长的命令运行，最多 24 小时。原生查询不会插入模型请求 Hook。

### 使用兼容代理：可选 Mihomo

根据真实环境，为 Hook 命令追加以下一种参数：

```text
# Windows 命名管道示例
--sample-traffic --pipe "\\.\pipe\verge-mihomo"

# macOS / Linux 的本地 Unix socket 示例
--sample-traffic --socket "/absolute/path/controller.sock"

# 任意支持平台上的回环 HTTP 示例
--sample-traffic --endpoint "http://127.0.0.1:9090"
```

只使用明确配置的本地接口，不读取代理配置或密钥，不为采样关闭接口认证，不自动更换代理。带认证的 HTTP 接口暂不支持；未接入或不可访问时显示未知。

## 使用

在 Codex 中输入下列指令；Claude Code / Grok 使用 `/context-traffic-guard`，Gemini CLI 可直接要求使用这个 Skill。

```text
$context-traffic-guard 检查当前会话，判断是否需要换窗，并准备交接摘要。
```

也可直接查看报告：

```sh
node --no-warnings scripts/guard.mjs report --client claude --session <RAW_SESSION_ID> --state-dir <STATE_DIR>
```

替换 client 为实际客户端。自建 Agent 还需 --source；可用 `guard.mjs clients` 查看能力表、`list-sessions --client ...` 列出已采集会话。已有 Codex 历史只在明确指定文件后导入；旧解析器不适用于其他客户端。没有历史时只报告接入后的覆盖。命令与检查方法见 [monitoring.md](references/monitoring.md)。

## 提醒策略

策略位于 [integration/policy.json](integration/policy.json)，均为可调整的试行值：

| 信号 | 默认提醒条件 |
| --- | --- |
| 压缩次数 | 2、5 次检查，10、20 次加强交接建议 |
| 输入增长 | 同模型最近 5 次输入中位数约为早期 5 次的 2 倍 |
| 上下文占比 | 客户端明确报告约 80%，只作试行交接提醒 |
| 持续变慢 | 至少 5 + 5 个可比样本；有效输出速率降至约 60%，请求耗时升至约 1.5 倍 |
| 所选来源上传 | 最多 30 分钟可用采样窗内累计 1 GiB |

有效请求速率包含排队、网络、推理和生成耗时，不是首字延迟或纯解码速度。系统网卡包含其他程序，兼容代理的进程采样也可能跨多个对话或漏记短连接，均不能归为当前对话的精确流量。报告标明来源、接口和覆盖；不同来源不混加，最新来源不足两个样本时不显示差值。详细口径见 [measurement.md](references/measurement.md)。

## 本地数据与停用

仅在配置的本地状态目录保存客户端/来源/会话标识、计数、数值指标、错误类别，以及流量增量所需的接口名称、连接标识和数值游标。不保存提示、回复正文、压缩摘要、工具结果、请求正文、域名历史或认证信息，不扫描或自动读取客户端历史文件。交接摘要由当前 Agent 基于真实任务状态编写，监控数据库不替代任务记录。

停用时，从活动配置中移除本工具的 Hook 条目，再通过正常信任审核流程检查配置。保留其他 Hook；本地状态可保留，删除会失去计数覆盖。若手动启动了限时采样命令，可等待结束或结束该命令；本工具不会自动启动常驻服务。

## 文件

- [SKILL.md](SKILL.md)：模型使用入口与交接流程。
- `scripts/guard.mjs`：Hook 采集、SQLite 状态与报告。
- `scripts/adapters.mjs`：四种客户端和通用事件的输入适配、能力说明与提醒格式。
- `scripts/configure.mjs`：只打印配置草案的生成器。
- `scripts/traffic.mjs`：本地流量读取及可选的有限时长诊断采样。
- `scripts/system-traffic.mjs`：无需代理的三平台系统网卡采样。
- `scripts/audit-rollout.mjs`：显式指定历史文件的一次导入。
- `scripts/*.test.mjs`：覆盖合成事件回放、数据隔离、流式去重、未知值、CLI、状态迁移、本地接口与实际网卡枚举，无模型调用。

各客户端的事件和状态字段以 [接入说明列出的官方文档](references/clients.md#官方依据) 为准。
