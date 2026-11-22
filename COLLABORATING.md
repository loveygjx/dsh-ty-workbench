# 协作指南 · dsh-ty-workbench 开发流程

> 仓库：https://github.com/zer0-lyz/dsh-ty-workbench
> 发给你的人：仓库所有者 zer0-lyz。本指南覆盖「克隆 → 开发 → 自测 → 提交 PR → 合并」完整流程。

## 1. 你需要的账号与权限

- 一个 GitHub 账号。
- 仓库所有者会把你的 GitHub 用户名加为 **Collaborator**（收到邀请邮件后点 Accept）。加过之后你可以直接向仓库 push 分支；没加之前 clone 可以、push 会 403（那就走 fork 流程，见第 7 节）。

## 2. 克隆仓库

```bash
git clone https://github.com/zer0-lyz/dsh-ty-workbench.git
cd dsh-ty-workbench
git config user.name  "你的名字"
git config user.email "你的邮箱"
```

## 3. 每次开发都从 main 拉新分支

```bash
git checkout main
git pull origin main
git checkout -b fix/改动简述     # 例：fix/report-export-duplicate、feat/assistant-model-select
```

**不要**直接在 main 上改、不要把 main 当分支名提交——所有改动一律走 PR，方便审查与回滚。

## 4. 项目结构（改前先看这里）

| 文件 | 职责 | 生效方式 |
|---|---|---|
| `index.js` | 宿主半侧：全部 API 路由、天源导出/导入编排 | 需重启 DeepSeek Harness |
| `client.js` | 网页半侧：全部界面（React，无构建步骤） | 刷新页面即生效 |
| `tianyuan.js` | 天源 MCP 授权与 JSON-RPC 客户端 | 重启 |
| `cli-auth.js` | tycpv CLI 授权与本地凭据状态 | 重启 |
| `export-workflow.js` | 手动整理工作流（独立批次、不覆盖源文件） | 重启 |
| `store.js` / `library.js` / `archive.js` | 数据落盘 / 归档库 / 知识库 | 重启 |

技术形态：**纯 JS + Python，无构建步骤**；Node ≥ 20；Python 3.10+ 仅股票/文档解析需要（可选）。天源功能可选，没有 tycpv CLI 其余模块照常工作。

## 5. 修改与自测要求

```bash
# 语法检查（改完必须过）
node --check index.js
node --check client.js
```

- **隔离测试**：涉及导出/整理/文件操作的改动，在临时目录 + 模拟数据下自测，**不要用真实项目数据**，不要覆盖已有项目文件或导出结果。
- **隐私红线（最重要）**：提交前逐条检查你的 diff，**绝不**包含：
  - token、cookie、密码、授权链接（天源 token 形如 `zhmcp_...`）
  - 真实项目名、客户名、公司名、人名
  - 本机绝对路径（如 `/Users/你的名字/...`）
  - 凭据文件内容（`~/.dsh/workbench-tianyuan.json`、`token.secret.json` 等，`.gitignore` 已排除，不要 force add）
- 遵循现有代码风格，不做无关的大规模重排。
- 如果用 AI 助手协助开发：把本指南全文发给它，并让它先读现有代码再动手。

## 6. 提交与 PR

```bash
git add -A
git status                      # 最后确认没有不该提交的文件
git commit -m "一句话说清改了什么、为什么"
git push origin fix/你的分支名
```

然后打开 https://github.com/zer0-lyz/dsh-ty-workbench → 会看到黄色提示条 **Compare & pull request** → 点它：

- **标题**：一句话概括改动
- **正文**必须包含四项：
  1. **改了什么**（文件 + 关键点）
  2. **为什么**（问题/需求背景）
  3. **怎么验证的**（跑了哪些测试、结果）
  4. **已知未验证边界**（哪些情况没测到，诚实写）

提完 PR 告诉所有者一声。审查意见会留在 PR 里，按要求补改后 `git push` 到同一分支即可自动更新 PR。

## 7. 没有 Collaborator 权限时（fork 流程）

1. 打开仓库页面 → 右上角 **Fork**；
2. clone 你自己的 fork：`git clone https://github.com/你的用户名/dsh-ty-workbench.git`；
3. 同样从 main 拉分支开发；
4. push 到你的 fork 后，GitHub 页面会出现 **Compare & pull request**，目标仓库会自动是原仓库。

## 8. 合并之后

- 所有者审查合并后，你本地同步：
  ```bash
  git checkout main
  git pull origin main
  git branch -d fix/你的分支名      # 清掉已合并的本地分支
  ```
- 如果你的改动涉及 `index.js`（宿主半侧），用户需要在 DSH 插件页确认重启后才能看到效果；只改 `client.js` 的话刷新页面即可。

## 9. 只提意见不改代码

在 https://github.com/zer0-lyz/dsh-ty-workbench/issues 开 Issue，写清楚：环境（macOS/Windows）、DSH 版本、复现步骤、期望行为、截图（**截图里别带真实项目数据**）。大改动建议先开 Issue 讨论再动手。

---

**一句话流程**：拉分支 → 改代码 → `node --check` + 隔离自测 → 查隐私 → push → PR（四要素正文）→ 审查合并。
