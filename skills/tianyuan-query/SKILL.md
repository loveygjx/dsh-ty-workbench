---
name: tianyuan-query
description: |
  查询天源评估系统数据：项目列表、评估结论、公司评估方法汇总表、导出明细表/申报表。
  触发条件：用户说"查评估结论 / 查天源项目 / 查某公司（如子公司A、子公司B、示例大酒店A等被评估单位）评估值 / 导明细表 / 导申报表"。
  优先用本 skill 的标准操作顺序，3 次工具调用内完成查询，不要去 OneDrive 目录翻文件、不要手写 MCP 握手脚本。
---

# 天源评估系统查询

## 标准操作顺序（3 步内出结论）

1. **拿 tyId**：调 `workbench_ty_projects`，可传 `keyword`（项目名/编号模糊匹配）。
   - 返回 `[{tyId, projectCode, projectName, department, status, baseDate}]`。
   - 用户给的公司简称（如"子公司A"）通常出现在 projectName 里，用 keyword 过滤即可。
2. **拿评估结论**：调 `workbench_ty_project_summary`，传 `tyId`。
   - 返回每家公司 `companyName / valuationValue / valueAdded / finalMethod / refreshed`。
   - 数值单位是**元**，逐字引用原始值，禁止四舍五入或换算成万元。
3. **需要科目级明细时**：调 `workbench_ty_company_summary`，传 `tyId`（可选 `companyId`、`method`：asset/income/market，默认 asset）。

## 降级路径（工作台工具不可用时）

用以下 Python 脚本直连 valuation-mcp。token 从 `~/.dsh/workbench-tianyuan.json` 的 `token` 字段读取，**任何输出严禁包含 token 与 mcp-session-id**。

> 优先级说明：装了本插件（dsh-workbench）时，工作台工具 `workbench_ty_projects / workbench_ty_project_summary / workbench_ty_company_summary` 已经完成 MCP 握手与 session 管理，**直接用它们，不要跑下面的脚本**。脚本只在这些工具不可用（插件未装、MCP 探活失败）时作为降级路径。

```python
import json, re, pathlib

TOKEN = json.loads(pathlib.Path.home().joinpath(".dsh/workbench-tianyuan.json").read_text())["token"]
URL = "https://mcp.zhrdc.net/valuation-mcp"

import urllib.request

def post(payload, session_id=None):
    headers = {
        "Authorization": f"Bearer {TOKEN}",
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
    }
    if session_id:
        headers["Mcp-Session-Id"] = session_id
    req = urllib.request.Request(URL, data=json.dumps(payload).encode(), headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=30) as resp:
        sid = resp.headers.get("mcp-session-id")
        text = resp.read().decode()
    # SSE 响应：取 data: 开头行的 JSON
    m = re.search(r"data: (.*)", text)
    return (json.loads(m.group(1)) if m else json.loads(text)), sid

# 1) initialize 握手，取 mcp-session-id
_, sid = post({"jsonrpc": "2.0", "id": 1, "method": "initialize",
               "params": {"protocolVersion": "2025-03-26", "capabilities": {},
                          "clientInfo": {"name": "tianyuan-query", "version": "1.0"}}})
# 2) notifications/initialized
post({"jsonrpc": "2.0", "method": "notifications/initialized"}, sid)
# 3) tools/call（示例：get_my_projects）
result, _ = post({"jsonrpc": "2.0", "id": 2, "method": "tools/call",
                  "params": {"name": "get_my_projects", "arguments": {}}}, sid)
print(json.dumps(result["result"]["content"][0]["text"], ensure_ascii=False))
```

常用远端工具（tools/list 共 30+ 个，入参均为 `projectId` 数字型）：
- `get_my_projects`：全部项目（id/projectCode/projectName/…）
- `get_project_summary`：项目汇总表（rows + summary.rootValuationValue）
- `get_project_companies`：项目公司清单（拿 companyId）
- `get_company_asset_based_approach_summary` / `get_company_income_approach_summary` / `get_company_market_approach_summary`：各方法公司汇总表
- `get_asset_based_approach_draft_data`：资产基础法底稿明细（需 companyId + 科目名称）
- `get_project_file_list`：项目文件列表

session 失效（code -32001 / "no valid session"）时重新 initialize 即可。

## tycpv 导出命令（明细表/申报表落 Excel）

```bash
tycpv export-asset-detail-table  -p <projectId> [-c <companyIds逗号分隔>] -o <outDir>   # 明细表（恢复公式+打印格式）
tycpv export-asset-declare-table -p <projectId> [-c <companyIds>] -o <outDir>          # 申报表
tycpv export-asset-summary-table -p <projectId> [-c <companyIds>] -o <outDir>          # 公司汇总表
tycpv export-income-summary-table -p <projectId> [-c <companyIds>] -o <outDir>         # 收益法汇总表
```

- `tycpv` 命令行已登录时直接用；返回 `Unauthorized: invalid token` 时先运行 `tycpv login` 刷新授权。
- 不确定公司范围时不要传 `-c`，会导出该项目全部公司。
- 不确定公司编号与简称的对应关系时，先核对 `get_project_companies`，再导出。
- 成功后回读文件：确认存在、大小非零、工作表数量合理。

## 数据纪律（硬约束）

1. 聚合值（评估价值/增减值/持股比例等）**逐字引用**，禁止 AI 自行重算、四舍五入或换算单位。
2. `refreshed=false` 时必须注明"系统汇总未刷新，非最新底稿口径"。
3. 数值单位是**元**，不是万元。
4. 工具返回 0 条表述"未发现公开记录"，不得断言"一定没有"；调用失败必须说明失败原因，不得用推测数据补全。
5. 任何输出不含 token、mcp-session-id、Authorization 头内容。

## 验收基准（历史实测对照）

- 项目"示例子公司股权转让-子公司A"（20261110001）→ `workbench_ty_project_summary` 的 evaluationValue 应为 **42471550.45** 元。
- "示例子公司股权转让-示例大酒店A"（20261104002）→ **-16512535.92**。
- "示例子公司股权转让-子公司B"（20261104001）→ **-30607563.81**。
- 三家均为 100% 股权、资产基础法、市场价值、"拟收购股权"经济行为；签字评估师张三、刘青莹。
