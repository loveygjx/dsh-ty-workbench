# AGENTS.md · 开发协作规则

> 本文件约束所有在本仓库工作的 AI 助手与人类协作者。先读本文件，再动手改代码。
> 完整流程见 `COLLABORATING.md`（分支规范 / PR 四要素 / 隐私红线）。

## 通用要求

- 每次开发从 `main` 拉新分支，不直接在 main 上提交。
- 修改前先读现有文件；改完必须通过 `node --check index.js && node --check client.js`。
- 隔离测试：导出/整理/文件操作类改动在临时目录 + 模拟数据下自测，不用真实项目数据。
- 隐私红线：diff 不得包含 token / cookie / 授权链接（如 `zhmcp_...`）、真实项目与人名、本机绝对路径、凭据文件内容。

## 浏览器操作规则（重点）

**凡是需要操作浏览器的任务，优先使用 opencli（DSH 浏览器代理），其次才是其他自动化手段；禁止先用手工方式。本规则适用于本仓库所有模块的开发、测试与验收，不限单一模块。**

适用场景：打开网页、点击/填表、读取登录态页面数据、截图验证 UI、网站抓取、页面状态检查等。

优先级顺序：

1. **首选 `site` 工具**（opencli 站点适配器，结构化结果、复用用户登录态）：
   - 按用户原话路由：知乎热榜 → `site zhihu hot`；B 站搜索 → `site bilibili search`；GitHub 检索 → `site github search`；arxiv → `site arxiv search` 等。
   - 写命令（发帖/点赞等）会先弹审批，由用户确认后才执行。
2. **其次 `opencli_open` / `opencli_state` / `opencli_click` / `opencli_fill`**：没有适配器的网站，用这一组做通用页面操作；先 `opencli_state` 拿 `[N]` 索引再点/填。
3. **读取正文用 `opencli_extract`**（长页自动分段）；需要视觉信息才用 `opencli_screenshot`（优先 state/extract）。
4. **动手前先 `site_knowledge <站名>`**：读该站知识卡（命令目录 + 已知坑 + 失败恢复表），不要现场试错。
5. **多站同命令并行采集用 `site_batch`**（自带同域冲突串行化与静默失败标注）。
6. **模块验收/回归**：对插件各模块（工作/文件库/助手/报告/工具箱/土地等）做 UI 验收时，同样经 opencli 打开页面、state 检查组件、extract 抓正文、screenshot 留档，替代临时 Playwright/手工脚本；确需脚本化回归时，通过 opencli 驱动真实浏览器执行。

约束与降级：

- 写命令必须在用户登录态下执行；cookie/密码不得出现在工具参数里。
- daemon 未运行时 opencli 不可用：提示用户在 DSH 设置 → 浏览器代理一键启动，或 `opencli daemon restart`；不要降级用 curl 抓登录态页面。
- 扩展未安装时，纯 HTTP 只读命令可直接跑；需要真实浏览器或登录态的命令先告知用户装扩展（https://github.com/jackwener/OpenCLI/releases），不要假装成功。
- 没有适配器的站点用 `opencli_do(command=analyze/init/verify)` 现场创作适配器，按 SKILL.md 流程验证后再用。
- 验证类页面操作结果时用 `so_verify`（亚秒判定）；不确定选点时用 `so_pick`。
- 明确的失败处理：先 `trace_replay` 看最近 30 步命令时间线，按知识卡恢复表自救，不要盲目重试。

例外：纯 HTTP API 调用（无需登录态、无页面交互）不受本规则约束；本机 Python 脚本抓公开数据且 opencli 无法覆盖时，说明原因后可用 requests 类方案。

## 代码形态约束

- 纯 JS + Python，无构建步骤；Node ≥ 20；Python 3.10+ 仅可选模块需要。
- 宿主半侧（index.js 等）改动需重启 DSH；client.js 改动刷新页面即可。
- 大改动先开 Issue 讨论；PR 正文写清四要素（改了什么 / 为什么 / 怎么验证 / 未验证边界）。
