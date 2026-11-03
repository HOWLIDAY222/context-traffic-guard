# Context Traffic Guard

**会话负担监测与交接**：为 Codex 长会话记录压缩次数、Token、请求耗时和可选的网络流量，根据实测趋势提醒用户在合适阶段切换对话，并准备交接摘要。核心功能不要求使用代理软件。

This Codex skill observes compactions, token usage, request performance, and optional network traffic. Core monitoring is proxy-independent. Native interface adapters cover Windows, macOS and Linux; a separate optional Mihomo adapter supports local IPC and loopback HTTP.

## 能做什么

- 配对 `PreCompact` / `PostCompact`，分别记录接入后次数与显式导入的历史次数。
- 配对模型请求事件，记录输入、缓存输入、输出、推理 Token 及请求耗时；缺失数据保持未知。
- 对可比请求的早期与近期样本做趋势比较，提醒输入增长或持续变慢。
- 可选读取 Windows、macOS、Linux 的系统网卡计数，明确选择一张接口；无需 Clash 或其他代理软件。
- 使用兼容代理的用户还可选择本机 Mihomo 接口，支持命名管道、Unix socket 和回环 HTTP，采用事件采样，无自动常驻后台进程。
- 合并重复提醒，在任务可恢复的阶段准备交接；采集失败不阻塞任务。

**压缩次数不是性能临界值。** 本工具不能测量“变笨程度”、服务端压力或订阅剩余额度，也不能证明压缩导致限速。换对话不保证改善速度。

## 运行要求

- Node.js 24 或更新版本，使用内置 `node:sqlite`，无第三方运行依赖。
- 支持模板所列生命周期事件的 Codex Hooks。
- 核心功能无需代理。流量可选用系统网卡或兼容代理接口；未接入时显示未知，不影响压缩、Token 和请求指标。

参考完整接入环境：Windows、Node.js 24.22.1、Codex CLI 0.166.0-alpha.5.1。已验证真实请求的 Token、耗时和本地代理事件采样；自然压缩事件仍需在日常使用中确认。

| 能力 | Windows | macOS | Linux |
| --- | --- | --- | --- |
| 压缩、Token、请求耗时与交接 | Node.js + Codex Hooks | 同左 | 同左 |
| 无代理的网卡采样 | Get-NetAdapterStatistics | netstat -ibn | /proc/net/dev |
| 可选兼容代理接口 | 命名管道或回环 HTTP | Unix socket 或回环 HTTP | Unix socket 或回环 HTTP |

[三平台测试](https://github.com/HOWLIDAY222/context-traffic-guard/actions/workflows/test.yml)检查核心逻辑、计数解析和运行环境中的真实网卡枚举。CI 通过不代表所有平台的 Codex 应用接入都已验证；目前完整 Codex 接入仅在 Windows 验证。其他代理客户端只有提供兼容计数接口时才能使用代理适配器，不保证任意软件都能提供单进程流量。

## 安装

1. 克隆仓库，将其内容复制到你的 `~/.codex/skills/context-traffic-guard/`。若该目录已有内容，先备份并比较。
2. 先运行测试：

   ```sh
   node --no-warnings --test scripts/guard.test.mjs scripts/system-traffic.test.mjs
   ```

3. 审核 `integration/hooks.preview.json`。将所有 `<ABSOLUTE_SKILL_DIR>`、`<ABSOLUTE_STATE_DIR>` 替换为实际绝对路径。确保 Hook 进程能找到 `node`；必要时将它换成 Node 可执行文件的绝对路径并正确加引号。
4. 备份现有 Hooks 配置，再合并这 8 个事件。不要覆盖其他 Hook，也不要在多个配置层重复注册。仅复制 Skill 不会自动启用持续监测。
5. 按 Codex 的 `/hooks` 或应用设置中的 Hooks 流程，审核并信任准确的命令。不要绕过信任检查。在新会话中验证实际回调。

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

在 Codex 中输入：

```text
$context-traffic-guard 检查当前会话，判断是否需要换窗，并准备交接摘要。
```

也可直接查看报告：

```sh
node --no-warnings scripts/guard.mjs report --session <SESSION_ID> --state-dir <STATE_DIR>
```

已有历史只在明确指定文件后导入。请在启用 Hooks 前完成导入，避免重叠计数；不要扫描全部历史。命令与检查方法见 [monitoring.md](references/monitoring.md)。

## 提醒策略

策略位于 [integration/policy.json](integration/policy.json)，均为可调整的试行值：

| 信号 | 默认提醒条件 |
| --- | --- |
| 压缩次数 | 2、5 次检查，10、20 次加强交接建议 |
| 输入增长 | 同模型最近 5 次输入中位数约为早期 5 次的 2 倍 |
| 持续变慢 | 至少 5 + 5 个可比样本；有效输出速率降至约 60%，请求耗时升至约 1.5 倍 |
| 所选来源上传 | 最多 30 分钟可用采样窗内累计 1 GiB |

有效请求速率包含排队、网络、推理和生成耗时，不是首字延迟或纯解码速度。系统网卡包含其他程序，兼容代理的进程采样也可能跨多个对话或漏记短连接，均不能归为当前对话的精确流量。报告标明来源、接口和覆盖；不同来源不混加，最新来源不足两个样本时不显示差值。详细口径见 [measurement.md](references/measurement.md)。

## 本地数据与停用

仅在配置的本地状态目录保存会话标识、计数、数值指标、错误类别，以及流量增量所需的接口名称、连接标识和数值游标。不保存提示、回复正文、工具结果、请求正文、域名历史或认证信息。仓库不包含真实会话、日志或监控数据库。

停用时，从活动配置中移除本工具的 Hook 条目，再通过正常信任审核流程检查配置。保留其他 Hook；本地状态可保留，删除会失去计数覆盖。若手动启动了限时采样命令，可等待结束或结束该命令；本工具不会自动启动常驻服务。

## 文件

- [SKILL.md](SKILL.md)：模型使用入口与交接流程。
- `scripts/guard.mjs`：Hook 采集、SQLite 状态与报告。
- `scripts/traffic.mjs`：本地流量读取及可选的有限时长诊断采样。
- `scripts/system-traffic.mjs`：无需代理的三平台系统网卡采样。
- `scripts/audit-rollout.mjs`：显式指定历史文件的一次导入。
- `scripts/guard.test.mjs`、`scripts/system-traffic.test.mjs`：23 项测试，覆盖合成数据、本地测试接口与运行平台的实际网卡枚举，无模型调用。

Hook 的事件与可用字段以 [Codex 官方 Hooks 文档](https://learn.chatgpt.com/docs/hooks) 为准。
