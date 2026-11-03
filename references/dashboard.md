# 本地监测面板与交接

面板是同一套通用监测核心的可视入口。运行时只需 Node.js 24，使用仓库内 dashboard/dist 的预构建 React 页面，不下载字体、脚本或图片，不调用模型。它不会代替客户端事件采集器。

## 启动与选择会话

在仓库或完整 Skill 目录运行：

```text
node --no-warnings scripts/dashboard.mjs --state-dir "<ABSOLUTE_STATE_DIR>"
```

打开 http://127.0.0.1:43871 。默认监听 127.0.0.1，不开放局域网；端口已占用时可指定 --port 43873。服务只读取明确状态目录中的 metrics.sqlite，不扫描文件或聊天历史；目录不存在时显示接入引导，不创建数据库。该目录需先由已接入的采集器产生记录。旧 Codex 安装可能使用 ~/.codex/context-traffic-guard-state，新通用安装建议使用 ~/.context-traffic-guard；以自己的配置为准。

默认由用户在左侧选择会话。明确知道当前原始 ID 时，可以绑定启动选择：

```text
node --no-warnings scripts/dashboard.mjs --state-dir "<STATE_DIR>" --client claude --session "<RAW_SESSION_ID>"
```

--client 支持 codex、claude、gemini、grok、generic。自建 Agent 增加 --source，与记录时的来源一致；子代理增加 --agent。不同客户端、来源和代理的同名 ID 不混合。不匹配时保持未选择，不按最近活动或工作目录猜窗口。

保持命令运行即可使用面板，Ctrl+C 结束服务。不会设置开机自启或安装常驻服务。现有 Hook 与采集状态不因关闭面板而停用。

## 页面操作与指标口径

- 会话总览展示真实计数，未提供的值为 — 或未知。输入与缓存读取的曲线分别展示，缓存仍是输入子集，不重复相加。当前上下文快照不会累计为请求。
- 请求图可选 30 分钟、2 小时或全部，最多显示该范围最近 500 条，截断时明确提示。请求耗时包括排队、网络、推理和生成，不包括两次请求间的工具执行。
- 速率曲线只展示最近一次有效请求所属的可比组：同模型、推理强度（取得时）、计时口径、规模和缓存/推理比例桶。不把不同模型连成一个性能下降结论。速度比较需要早期与近期各 5 个可比样本；否则保持未知。
- 网络图独立使用策略中的流量采样窗，默认最多 30 分钟；不随请求图的“全部”扩展。只取最新来源及计数段，计数回退后重新开始。系统网卡覆盖其他程序，代理计数也跨窗口；不同来源不相加。
- 读取面板的更新时间与流量样本的新鲜度不同。流量最后采样超过 10 秒就标为历史数据。没有接入流量源时不会把空值显示成 0。
- 诊断页面区分已观察到的提醒、数据缺口、建议检查项及范围。原因不能确定时明确保留未知；策略阈值不是模型能力临界值。

默认每 5 秒读取一次，可用右上角按钮暂停或手动刷新。读取失败会保留上次数据并给出提示，恢复后再更新。切换会话时不会继续显示上一会话的指标或任务草稿。

## Agent 提供任务草稿

监测数据库不保存任务正文，不能自行还原“做到了哪一步”。当前 Agent 根据真实任务状态，向明确的任务目录写一份小 JSON 文件；也可手动填写表单。不要把草稿、状态库或本机路径文件提交到公开仓库。

```json
{
  "version": 1,
  "client": "claude",
  "session_id": "RAW_SESSION_ID",
  "agent_id": "root",
  "fields": {
    "goal": "当前目标、范围与验收条件",
    "completed": "已经完成的工作及验证结果，明确尚未验证的部分",
    "next": "下一项具体动作、剩余问题和阻碍",
    "files": "关键文件路径、产物、分支、未提交修改及运行任务",
    "constraints": "授权范围、要保留的成果、关键约束与已失败的路径"
  }
}
```

generic 客户端还需 source 字段，与接入来源一致。文件最多 64 KiB，各字段最多 8000 字符；绑定不匹配时不载入。

```text
node --no-warnings scripts/dashboard.mjs --state-dir "<STATE_DIR>" --client claude --session "<RAW_SESSION_ID>" --handoff "<ABSOLUTE_TASK_BRIEF_JSON>"
```

初次进入匹配的会话时载入草稿。Agent 后续更新文件，不覆盖用户正在编辑的内容；需要时点“载入 Agent 草稿”重新读取已取得的版本。编辑内容按会话保留在当前页面内存中，关闭或刷新页面会丢失；先复制或下载。不会自动发送给其他对话。

交接摘要预览会自动带入客户端、来源、会话、记录覆盖、数值和未知项。用户核对任务正文后可复制或下载 .md。浏览器拒绝剪贴板权限时显示失败说明，可选中预览自行复制或下载，不会假报成功。

## 流量接入

面板不会自动开启网卡采样。需要时用明确的一张接口启动有限时长采样，状态目录与面板一致：

```text
node --no-warnings scripts/system-traffic.mjs list
node --no-warnings scripts/system-traffic.mjs sample --interface "<INTERFACE_NAME>" --state-dir "<STATE_DIR>" --seconds 300
```

Windows/macOS/Linux 均有原生适配。已有 Mihomo 事件采样也可展示，面板本身不读取代理配置或凭证。详细计数口径见 [measurement.md](measurement.md)。

## 开发与验证范围

普通用户直接使用已分发的 dashboard/dist，不需安装依赖。修改前端的开发者使用 package.json 与 pnpm-lock.yaml 中的固定版本：

```text
pnpm install --frozen-lockfile --ignore-scripts
pnpm build
pnpm test
```

本地服务与读取逻辑使用 Node 内置 HTTP/SQLite。三平台 CI 运行核心、适配器、面板 HTTP/隔离/交接测试；Ubuntu 另重建前端并检查预构建文件一致。Windows 通过隔离的无头 Edge + Playwright 验证真实记录展示、趋势切换、暂停刷新、客户端会话隔离、草稿编辑、剪贴板和 Markdown 下载，并检查桌面与手机尺寸。macOS/Linux 的浏览器 UI、Safari 及各客户端真实模型集成仍需各自环境验证。
