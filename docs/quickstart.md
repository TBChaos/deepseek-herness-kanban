# 快速开始

## 环境要求

- Node.js ≥ 22.19
- Git ≥ 2.25
- pnpm
- 一个 DeepSeek Harness 的 web profile（`dsh-base` + `dsh-web-app`，DSH 默认 `web` profile 即可）

## 安装

```sh
# 从 npm（发布后）
dsh plugin --profile web add deepseek-herness-kanban

# 从本地仓库 / tarball
dsh plugin --profile web add link:/path/to/deepseek-herness-kanban
dsh plugin --profile web add ./deepseek-herness-kanban-0.1.0.tgz
```

安装完成后插件会自动加入 profile 的 `dsh.profile.bundles`，启动时作为一层
bundle patch 加载。启动 Web GUI：

```sh
dsh web
```

## 第一步：导入项目

1. 打开 DSH Web GUI，点击左侧底部的 **📋 看板**。
2. 点击 **＋ 添加项目**，填写名称与本地 Git 仓库绝对路径。
3. 路径不存在时自动 `git init`（并提交一个 `.gitkeep` 以创建主分支）；
   已存在时自动识别仓库与主分支。

## 第二步：创建任务

**手动创建**：在「待办」列点击「＋ 新建任务」。

**AI 自动拆解**（核心创新）：在 DSH 对话里讨论完需求后说：

> “把刚才讨论的这几点拆解成看板任务”

AI 调用 `herness_kanban_parse_conversation` 分析对话，批量创建任务卡片，
并把每张卡片绑定到当前 Session（卡片上的 💬 徽章）。重复的任务会被自动跳过。

## 第三步：派发执行

- 把卡片拖进「进行中」，或点开卡片点 **▶ 派发给 DSH Agent**。
- 系统自动：创建 worktree（`<repo>-<taskId>`）→ 从主分支切出
  `herness-task-<id>` → 启动 DSH Session 绑定 worktree 为工作目录。
- 卡片显示 🔴 与进度条，抽屉的「执行」页实时显示最近 50 行日志。
- 默认最多 5 个任务并行，超出排队。
- 成功 → 自动移入「审查中」；失败 → 回到「待办」并附带错误摘要。

## 第四步：代码审查

1. 打开「审查中」的卡片 → **📄 Diff 审查** 页签。
2. 左侧文件树 + 右侧逐行高亮 Diff。
3. **✅ 审查通过并合并** → `git merge --no-ff` 合并回主分支，销毁 worktree，
   卡片移入「已完成」。
4. **❌ 驳回并回滚** → `git revert` 回滚，审查意见记录在卡片评论里，
   卡片回到「待办」。

## 心跳与超时

派发的 Agent 被要求把进度写入 worktree 内的 `.herness/heartbeat.json`：

```json
{ "progress": 40, "note": "implemented parser; now writing tests" }
```
日志信号（Session 事件）+ 进度文件双重信号共同构成心跳；默认 30 分钟无
信号自动终止（可配置，见 [配置说明](./configuration.md)）。

