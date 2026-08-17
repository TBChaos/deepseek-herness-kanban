# 配置说明

插件配置通过 bundle patch（`cordis.patch.yml`）注入；profile 里后写的行会
整体覆盖先写的行（last write per row wins）。

## 配置项

| 键 | 类型 | 默认 | 说明 |
|----|------|------|------|
| `maxConcurrent` | number | `5` | 同时执行的任务上限（NF-06：≥5） |
| `heartbeatTimeoutMs` | number | `1800000`（30 分钟） | 心跳超时：日志 + 进度文件双信号都超时则终止（NF-10） |
| `worktreeBaseDir` | string \| null | `null` | worktree 父目录；`null` 表示 `<repoPath>-<taskId>` |
| `dispatchProvider` | string \| null | `null` | 派发 Session 的 provider；`null` = 用户默认 |
| `dispatchModel` | string \| null | `null` | 派发 Session 的 model；`null` = 用户默认 |
| `dispatchMaxTokens` | number \| null | `null` | 派发 Session 的 maxTokens；`null` = 默认 |
| `dispatchAgentPreset` | string \| null | `null` | 派发 Session 默认加载的 Agent 预设/模式；`null` = 不强制指定 |
| `dispatchReasoningEffort` | string \| null | `null` | 派发 Session 默认的思考强度；`null` = 跟随模型/用户默认 |

## 在 profile 中覆盖

编辑 profile 目录下的 `cordis.patch.yml`：

```yaml
- id: herness-kanban
  name: 'deepseek-herness-kanban'
  config:
    maxConcurrent: 8
    heartbeatTimeoutMs: 3600000
    dispatchModel: deepseek-v4-pro
```

## 依赖的服务

插件声明 `inject: ['tools', 'storageDomain', 'skills', 'agents', 'llm', 'sessions', 'agentDefaultModel', 'agentPresets']`，并要求 profile 提供：

- `@deepseek-ai/dsh-storage` + `dsh-storage-json` + `dsh-storage-domain`
  （默认 `web` profile 已包含；领域名为 `herness_kanban`，JSON 落在
  `$DSH_HOME/storages/herness_kanban.json`）
- `@deepseek-ai/dsh-host-webserver`（RPC/SSE，web profile 已包含）
- `@deepseek-ai/dsh-agent-loop` + `dsh-llm`（派发执行与对话拆解）
- `@deepseek-ai/dsh-agent-default-model` + `@deepseek-ai/dsh-agent-presets`（派发默认模型/模式与预设目录；web profile 已包含）
- `@deepseek-ai/dsh-tools` / `dsh-skill`（工具与 skill 注册）

在缺少 storage 或 web server 的 profile（如纯 headless）中，插件会等待服务
直到超时；建议始终安装在 web profile。

## 版本检查

启动时插件检查 `git --version`，低于 2.25 时在日志中告警（TC-07）。

