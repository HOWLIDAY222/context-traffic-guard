# Context Traffic Guard

**会话负担监测与交接**：为 Codex 长会话记录压缩次数、Token、请求耗时和可选的本地代理流量，根据实测趋势提醒用户在合适阶段切换对话，并准备交接摘要。

This Codex skill observes compactions, token usage, request performance, and optional local Mihomo traffic. It gives advisory reminders and helps prepare a concise handoff to a new conversation.

## 能做什么

- 配对 `PreCompact` / `PostCompact`，分别记录接入后次数与显式导入的历史次数。
- 配对模型请求事件，记录输入、缓存输入、输出、推理 Token 及请求耗时；缺失数据保持未知。
- 对可比请求的早期与近期样本做趋势比较，提醒输入增长或持续变慢。
- 可选读取本机 Mihomo 命名管道的累计字节，采用事件采样，无常驻后台进程。
- 合并重复提醒，在任务可恢复的阶段准备交接；采集失败不阻塞任务。

**压缩次数不是性能临界值。** 本工具不能测量“变笨程度”、服务端压力或订阅剩余额度，也不能证明压缩导致限速。换对话不保证改善速度。

## 运行要求

- Node.js 24 或更新版本，使用内置 `node:sqlite`，无第三方运行依赖。
- 支持模板所列生命周期事件的 Codex Hooks。
- 流量功能额外需要本机 Mihomo 命名管道；不使用该代理也可监测压缩和请求指标。

参考验证环境：Windows、Node.js 24.22.1、Codex CLI 0.166.0-alpha.5.1。已验证真实请求的 Token、耗时和本地代理事件采样；自然压缩事件仍需在日常使用中确认。其他平台和版本未完成实际集成验证。

## 安装

1. 克隆仓库，将其内容复制到你的 `~/.codex/skills/context-traffic-guard/`。若该目录已有内容，先备份并比较。
2. 先运行测试：

   ```sh
   node --no-warnings --test scripts/guard.test.mjs
   ```

3. 审核 `integration/hooks.preview.json`。将所有 `<ABSOLUTE_SKILL_DIR>`、`<ABSOLUTE_STATE_DIR>` 替换为实际绝对路径。确保 Hook 进程能找到 `node`；必要时将它换成 Node 可执行文件的绝对路径并正确加引号。
4. 备份现有 Hooks 配置，再合并这 8 个事件。不要覆盖其他 Hook，也不要在多个配置层重复注册。仅复制 Skill 不会自动启用持续监测。
5. 按 Codex 的 `/hooks` 或应用设置中的 Hooks 流程，审核并信任准确的命令。不要绕过信任检查。在新会话中验证实际回调。

通用模板默认不采集流量。在 Windows + Clash Verge/Mihomo 环境中，确认实际管道后，可给每个 Hook 命令追加：

```text
--sample-traffic --pipe "\\.\pipe\verge-mihomo"
```

这只是常见管道示例，不会读取代理配置、密钥或访问外部监控服务。

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
| 代理上传 | 最多 30 分钟可用采样窗内累计 1 GiB |

有效请求速率包含排队、网络、推理和生成耗时，不是首字延迟或纯解码速度。代理总量覆盖本机多个程序；Codex/ChatGPT 进程采样覆盖多个对话，且可能漏记短连接，不能归为当前对话的精确流量。详细口径见 [measurement.md](references/measurement.md)。

## 本地数据与停用

仅在配置的本地状态目录保存会话标识、计数、数值指标、错误类别，以及流量增量所需的连接标识和数值游标。不保存提示、回复正文、工具结果、请求正文、域名历史或认证信息。仓库不包含真实会话、日志或监控数据库。

停用时，从活动配置中移除本工具的 Hook 条目，再通过正常信任审核流程检查配置。保留其他 Hook；本地状态可保留，删除会失去计数覆盖。无需结束常驻进程。

## 文件

- [SKILL.md](SKILL.md)：模型使用入口与交接流程。
- `scripts/guard.mjs`：Hook 采集、SQLite 状态与报告。
- `scripts/traffic.mjs`：本地流量读取及可选的有限时长诊断采样。
- `scripts/audit-rollout.mjs`：显式指定历史文件的一次导入。
- `scripts/guard.test.mjs`：14 项功能测试，使用合成数据与本地测试管道，无模型调用。

Hook 的事件与可用字段以 [Codex 官方 Hooks 文档](https://learn.chatgpt.com/docs/hooks) 为准。
