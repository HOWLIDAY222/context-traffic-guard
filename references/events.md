# 通用事件契约 v1

其他 CLI、Agent 框架或自建 API 程序可直接接入，不依赖 Codex。调用方只传必要标识和数值；不要把提示、回复、工具正文或认证信息放进事件。

## 命令与来源隔离

每次向 stdin 写一个 JSON 对象：

```text
node scripts/guard.mjs record --client generic --source my-agent --state-dir "<STATE_DIR>"
```

基本字段：version 必须为 1；session_id 是调用方稳定的会话 ID；event 是下表之一。可选 agent_id 区分子代理，model、reasoning_effort 用于可比样本分组。source 是 1–64 位字母、数字、点、下划线或连字符，首字符须为字母或数字。不同客户端和不同自定义 source 的同名 session_id 不混合。

| event | 字段 / 含义 |
| --- | --- |
| session.started | 建立观察范围 |
| compaction.started | 开始压缩 |
| compaction.completed | 确认完成；必须有稳定且唯一的 event_id，重放不重复计数 |
| compression.triggered | 只能确认触发，不能冒充完成 |
| request.started | 必须有稳定 request_id；同一请求的开始事件重放不重复 |
| request.finished | 同一 request_id；status 为 completed、failed 或 cancelled；usage 可缺失 |
| context.snapshot | context.used_percentage、context.window_tokens 为可选数值 |
| checkpoint | 返回新的简短提醒（若有），供调用方展示或传给 Agent |

request.finished 示例：

```json
{
  "version": 1,
  "session_id": "my-session",
  "event": "request.finished",
  "request_id": "request-001",
  "model": "my-model",
  "status": "completed",
  "elapsed_ms": 1250,
  "usage": {
    "input_tokens": 1000,
    "cached_input_tokens": 800,
    "output_tokens": 200,
    "reasoning_output_tokens": 50,
    "total_tokens": 1200
  }
}
```

elapsed_ms 可选。没有它时，只在开始/结束事件可无歧义配对时计算本机观察耗时；有它时标为 caller_reported，不伪装成采集器独立实测。同一客户端的不同计时口径不混为速度基线。不要把包含工具执行的整轮耗时传为模型请求耗时。

usage 中缓存是输入的子集，推理是输出的子集，不重复相加；输入/输出都明确时可求总数，否则保留明确提供的 total_tokens，其余未知。不把未知字段补为零，不从字节数换算 Token。completed 请求的数值总计只覆盖记录到的请求，不等于账号账单或剩余额度。

checkpoint 的可选 reminder 只是建议。调用方自行选择合适的提示出口；本工具不返回阻止执行、要求无限续跑或自动切换对话的决策。坏事件会以非零退出码拒绝，宿主应按自己的观测失败策略继续业务；各专用 hook 命令始终 fail-open。

查看自定义来源：

```text
node scripts/guard.mjs report --client generic --source my-agent --session my-session --state-dir "<STATE_DIR>"
```

## 嵌入已有 Node.js Agent

需要避免频繁启动子进程时，可以在既有进程中导入纯适配层与采集核心：

```js
import { normalizeEvent, sessionKey } from './scripts/adapters.mjs';
import { openStore, ingest, summarize } from './scripts/guard.mjs';

const db = openStore('/explicit/local/state');
try {
  const event = normalizeEvent('generic', payload, { source: 'my-agent' });
  ingest(db, event);
  const report = summarize(db, sessionKey('generic', payload.session_id, 'my-agent'));
  // Let the host display report.alerts at its own safe checkpoint.
} finally {
  db.close();
}
```

这是进程内模块接口，不是自动开启的监听服务器，不需要 API Key，也不会连接模型服务。没有本地执行能力或生命周期数据的纯聊天产品只能复用手工交接流程，不能声明已自动采集。
