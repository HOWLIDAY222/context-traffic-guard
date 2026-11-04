# 一键接入

首次使用时，让支持本地操作的 Agent 执行接入；也可在完整 Skill 文件夹中启动对应入口。普通复制目录或纯网页聊天不会自行执行程序。

| 系统 | 启动入口 |
| --- | --- |
| Windows | 双击 Start-Context-Guard.cmd |
| macOS | 双击 Start-Context-Guard.command |
| Linux | 运行 start-context-guard.sh |

已有 Node.js 24 或更新版本时直接使用；否则启动入口从 nodejs.org 下载当前 Node 24 官方归档，核对官方 SHA256 后解压到 ~/.context-traffic-guard/runtime。之后复用这份私有运行时。不会改系统 PATH，也不要求管理员权限。首次准备运行时需要联网；网络或操作系统策略不允许时，Agent 可使用已有可用的 Node 24 执行 scripts/setup.mjs。Windows 入口使用系统 curl、certutil 和 tar，不修改 PowerShell 执行策略。

## 自动执行的步骤

1. 检测系统、可用运行时、客户端配置目录与命令入口；不执行扫描到的客户端，也不读取认证文件、.env 或聊天历史。
2. 检测 Codex、Claude Code、Gemini CLI、Grok。尊重 CODEX_HOME、CLAUDE_CONFIG_DIR，以及 GEMINI_CLI_HOME 下的 .gemini。仅接入实际检测到的客户端。
3. 保存备份，合并本工具缺失的事件。保留其他 Hook、原有设置、已有状态栏、禁用选择与历史数据目录。JSONC 的注释和无关字段保留；Codex 已使用 TOML Hook 时在原表示中补全，不另建重复 JSON 注册。
4. 在 ~/.context-traffic-guard/skill 放置可独立运行的监测程序。为缺少本 Skill 的客户端注册 Skill；向导安装的已有目录可按哈希更新，手工安装或有本地修改的目录会保留。
5. 创建空的监测数据库结构，不伪造会话、请求或压缩记录。多个已有数据目录分别保留，在面板中切换查看，不静默迁移或混合。
6. 启动本地面板并请求默认浏览器打开。默认端口被占用时自动尝试后续端口，不结束其他服务；再次启动复用可确认身份的本工具面板。
7. 没有已有代理采样时，识别唯一的系统默认出口并自动采样一张网卡；无法确认时才显示选择器。已有代理事件采样继续沿用。自动采样随向导服务运行，最长 24 小时；可在页面停止，不设置开机自启。

配置会写入各客户端原生位置：Codex 用户级 hooks.json 或已存在的 TOML Hook，Claude/Gemini 的 settings.json，以及 Grok 的 hooks/context-traffic-guard.json。不会降低客户端安全设置或自动批准信任。

## 三种状态

- **配置已就绪**：设置已写入并通过本地程序检查。它不代表客户端已经执行事件。
- **等待客户端确认**：按宿主正常流程完成审核或重启。Codex 可输入 /hooks，或进入设置中的 Hooks 页面审核。其他客户端出现确认时也按正常流程完成。
- **已收到事件**：接入后确实出现该客户端的数值记录。仍以每项实际字段判断覆盖，不能把一次事件当作所有指标都已验证。

客户端主动关闭全部 Hook、配置格式不正确、文件不是可安全修改的普通文件，或程序目录有本地修改时，向导会保留原内容并显示原因。不会为了完成自动化覆盖这些选择。

Claude 没有已有状态栏时接入本工具的快照状态栏；已有状态栏保持原样。Grok 的 Windows 命令状态栏仍缺真实宿主验证，向导使用基础事件和面板，不宣称该项已接通。Gemini 默认使用轻量事件；详细模型事件需明确选择，不默认在每个流式片段增加进程开销。

## Agent / 命令行入口

已有 Node 24 时，Agent 在用户要求安装、启用或一键接入后运行：

```text
node --no-warnings scripts/setup.mjs
```

不用手工填写状态目录、Hook JSON 或 Shell 类型。可先用 --plan 只读查看检测和计划；已授权后继续执行，不把每个实现步骤变成新的确认。纯解释或只读查看问题不触发安装。

常用高级选项：

```text
# 仅查看计划，不修改任何文件
node --no-warnings scripts/setup.mjs --plan

# 只接入指定客户端；默认接入已检测到的支持客户端
node --no-warnings scripts/setup.mjs --clients codex,claude

# 当前 Agent 有确切会话 ID 和任务草稿时，直接定位并载入交接
node --no-warnings scripts/setup.mjs --client claude --session "<RAW_SESSION_ID>" --handoff "<BRIEF_JSON>"

# 不启动系统网卡采样；已有代理事件配置保持原样
node --no-warnings scripts/setup.mjs --no-traffic

# Gemini 按需启用详细请求事件
node --no-warnings scripts/setup.mjs --clients gemini --gemini-detailed
```

运行结果给出实际面板 URL、备份位置、客户端状态。--no-open 不请求打开浏览器，--no-panel 只完成配置，适合测试或无桌面环境。--home 指定独立用户目录时仅检测其中的客户端，不读取真实用户路径覆盖，主要用于隔离验证。

## 备份与恢复

备份和清单保存在 ~/.context-traffic-guard/backups/<接入编号>，控制记录在 setup 子目录。清单只记录路径、哈希、状态和数值元数据；原配置副本保存在本机私有目录，不上传或显示到页面。原配置中的无关字段按原样保留，不提取、显示或修改模型 API 密钥。

页面的“恢复本次接入”核对本次写入后的文件哈希，再恢复配置。文件之后被用户或客户端修改时，停止整体恢复，避免留下指向已删除程序的 Hook。并发配置变化会暂停合并，已应用改动仅在可确认未被后续修改时恢复。已有监测数据保留；数据库快照供必要的人工恢复使用，不自动覆盖后续事件。

## 验证边界

通用测试覆盖四客户端检测、配置保留、重复接入、并发修改、恢复、真实生成命令的 UTF-8 输入输出、独立数据目录、面板进程启动与复用。Windows 浏览器在隔离目录验证完整向导、默认网卡采样、状态变化、恢复以及桌面/手机尺寸。

三平台 CI 另用没有可用 Node 的隔离 HOME 下载、校验并启动官方私有 Node 24，确认入口无需手填运行时路径。此项依赖官方站点网络可达；测试通过也不等于 Claude/Gemini/Grok 的真实模型集成已完成。普通网页或云编排不提供本地生命周期事件时，向导不能创造这些接口。

官方契约见 [客户端说明](clients.md#官方依据)；运行时来自 [Node.js 官方下载](https://nodejs.org/en/download)。
