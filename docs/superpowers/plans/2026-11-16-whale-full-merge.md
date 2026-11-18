# 小鲸鱼完全整合进 dsh-unified-quota — 实施计划（方案 A）

> **Goal:** 把 dsh-whale-widget 的挂件展示（角色图/动画/音效/气泡/自定义提示）搬进 dsh-unified-quota，数据全部由本插件提供，最终可安全卸载小鲸鱼插件。
>
> **Architecture:** 分四阶段。阶段 0 建安全网（已做基线备份）。阶段 1 只搬"挂件显示层"——复制 assets、注册 `/dsh-whale/*` 兼容路由（返回小鲸鱼原数据）与注入行，做到"我的插件自己能把挂件显示出来"。阶段 2 把路由数据源逐个切成我的账本/余额。阶段 3 端到端验证后才卸载小鲸鱼。全程小鲸鱼插件保持安装，任何阶段失败立即回滚。
>
> **Tech Stack:** DSH Cordis 插件（宿主 Node 半 + 客户端半）、`ctx.webServer.register`、`webserver/index-inject`（kind:script 内联注入）、`/plugins/<pkg>/assets/` 静态资源路由。
>
> **Spec:** 本文件即规格。相关事实记录于 `WEBDAV-PLAN.md`（无关）与安全基线目录 `_whale-merge-safety/`（备份）。

## Global Constraints（全局约束）

- **小鲸鱼插件在阶段 3 之前绝对不卸载、不禁用、不修改其任何文件。**
- **注入行必须用 `kind:"script"` + 内联建 `<script src>` + 吞掉 onerror。** 严禁用 `kind:"script-src"`——desktop 前端会 await 加载，失败会 reject `__DSH_BOOT_READY__`，导致整个 DSH 起不来（小鲸鱼 issue #154 的教训）。
- **注入行注册必须同步发生在 apply() 第一行**：桌面端注入表在宿主启动时只收集一次，晚注册就永远进不了表。
- **必须去重**：注册前扫描 table，若已有指向本插件 widget.js 的 script-src/script 行则跳过，防止两个挂件同时出现。
- **全局标志**：widget.js 自带 `window.__dshWhaleWidget` 单例保护；复用原文件即可，不要改这个逻辑。
- **widget.js 内部 23 处 `/dsh-whale/*` 路径是硬编码绝对路径**：因此最省事、最安全的做法是**原样复用 whale-widget.js 文件**，并在我的插件里注册同名 `/dsh-whale/*` 路由来服务它——而不是改 widget.js（改 23 处路径风险高）。
- **资源交付**：assets 目录通过 `files` 字段打包，运行时可从 `/plugins/dsh-unified-quota/assets/<name>` 访问；但 widget.js 内部用 `/dsh-whale/widget.js`，所以必须注册该路径的路由返回文件字节。
- **数据源切换原则**：先让路由返回小鲸鱼原数据（阶段 1，保证挂件能显示），再逐个切成我的数据（阶段 2，逐个验证），禁止一次性全切。
- **每一步改动后立即 `node --check`；每个阶段结束必须打包安装 + 完整重启 + 人工确认 DSH 能正常启动。**
- **安全基线**：`E:\完全体工作区\_whale-merge-safety\` 已含全部相关文件备份，回滚 = 复制回原路径 + 重启。

## Review Focus（最可能咬人的 5 个未测边界）

1. **注入行 sink**：`script-src` 失败会拖垮整个 DSH → 阶段 1 的测试必须断言生成的是 `kind:"script"` 且脚本文本包含 `onerror`（吞错）。
2. **注入表收集竞态**：注册晚于启动时收集 → 挂件永不出现 → 测试必须断言注册发生在 apply() 同步阶段（不依赖任何 await/inject）。
3. **两个挂件重复**：我和小鲸鱼都注入同名脚本 → 页面出现两个挂件/全局标志冲突 → 测试必须断言 table 里只有一行、且 window.__dshWhaleWidget 保护生效。
4. **路由前缀冲突**：两个插件都注册 `/dsh-whale/*` → 谁先注册谁生效不确定 → 阶段 3 卸载前必须做"只有一个提供者"的验证；阶段 1/2 允许并存但要能区分当前命中哪个。
5. **数据格式错位**：我的账本字段与小鲸鱼 balance.json/usage-records.json 字段不同 → 挂件显示 NaN/空白 → 每个路由切换都要用真实小鲸鱼文件的字段结构做对照断言。

## File Structure（文件结构）

- `lib/index.js`（修改）— 宿主：注册 `/dsh-whale/*` 兼容路由 + index-inject 注入行 + 数据源适配层。
- `lib/whale-compat.js`（新建）— 兼容路由处理器：把我的账本/余额映射成小鲸鱼的数据格式。单一职责，便于独立测试。
- `assets/`（新建目录，复制自小鲸鱼）— whale-widget.js + 角色图/GIF/音效（16 个文件）。
- `package.json`（修改）— `files` 增加 `"assets"`。
- `cordis.patch.yml`（不改）— 本插件已通过 patch 挂载，无需新增 bundle patch（注入靠运行时 index-inject）。
- `_whale-merge-safety/`（已建）— 备份与回滚说明，不属于交付物。

---

### Task 0: 安全基线与回滚脚本（已完成，记录于此）

**Files:** `_whale-merge-safety/`

- [x] 备份 profile-package.json / unified-index.js / unified-client.js / unified-package.json / whale-index.js
- [x] 记录主进程 PID=16024、进程数=9
- [x] 写 STATE.md（回滚方法）

### Task 1: 复制资产 + 静态资源路由（阶段 1a）

**Files:**
- Create: `assets/`（16 个文件，从 dsh-whale-widget/assets 复制）
- Modify: `package.json` → files 增加 `"assets"`
- Modify: `lib/index.js` → 注册 `GET /dsh-whale/widget.js` 返回 assets/whale-widget.js 字节，Content-Type: application/javascript

**Interfaces:**
- Produces: `GET /dsh-whale/widget.js` 返回 967KB 脚本字节；`loadWidgetJs()` 按 mtime 缓存。

- [ ] **Step 1: 复制 assets 目录**
  从 `C:\Users\15003\.dsh\profiles\desktop\node_modules\dsh-whale-widget\assets\` 复制全部 16 个文件到 `E:\完全体工作区\dsh-unified-quota\assets\`。
  验证：`assets/whale-widget.js` 存在且字节数 = 967723。
- [ ] **Step 2: package.json 加 files**
  `files` 数组增加 `"assets"`。验证：`JSON.parse(package.json).files` 含 assets。
- [ ] **Step 3: 注册 widget.js 路由**
  在 apply() 的路由注册区加 `{ kind:"prefix"|"exact", path:"/dsh-whale/widget.js", handler }`，返回 loadWidgetJs() 字节。
  验证：`node --check lib/index.js` 通过。
- [ ] **Step 4: 隔离测试路由**
  用 stub ctx 启动插件，请求 `/dsh-whale/widget.js`，断言 HTTP 200、Content-Type 含 javascript、body 长度=967723。
- [ ] **Step 5: 打包 + 安装 + 重启 + 人工确认 DSH 正常启动**
  这是强制闸门：若 DSH 起不来，立即回滚（复制基线备份 + 重启）。

### Task 2: 注入行（阶段 1b，最高危）

**Files:** Modify `lib/index.js` — apply() 开头同步注册 `webserver/index-inject`。

**Interfaces:**
- Consumes: Task 1 的 `/dsh-whale/widget.js` 路由。
- Produces: 注入行 `{kind:"script", placement:"body", text: "<建 script src=/dsh-whale/widget.js 且吞 onerror 的 IIFE>"}`。

- [ ] **Step 1: 写失败测试** — 用 fake ctx（带 on 方法）触发 apply，捕获 `webserver/index-inject` 回调，传入空 table 数组，断言：
  - table.length === 1
  - table[0].kind === "script"
  - table[0].text 含 `/dsh-whale/widget.js` 且含 `onerror`。
  运行确认 FAIL（回调未注册）。
- [ ] **Step 2: 实现同步注入注册** — apply() 第一行（任何 await/inject 之前）`ctx.on("webserver/index-inject", (table)=>{ ...去重...; table.push(...) })`；用 `ctx.effect` 注册 disposer 清理。照抄小鲸鱼的去重逻辑（扫 table 里 kind=script/script-src 且含目标路径则跳过）。
- [ ] **Step 3: 去重测试** — 传 table 含一行旧 script-src 指向 /dsh-whale/widget.js，断言回调不再追加（table.length 仍为 1）。
- [ ] **Step 4: 运行测试全部 PASS** + `node --check`。
- [ ] **Step 5: 打包 + 安装 + 重启 + 人工闸门**：确认 DSH 能启动、挂件出现（此时数据是小鲸鱼的，因为路由还没切；可能两个挂件重叠——正常，全局标志会去重）。若 DSH 起不来 → 立即回滚。

### Task 3: 数据适配层 whale-compat.js（阶段 2 准备）

**Files:** Create `lib/whale-compat.js`。

**Interfaces:**
- Consumes: 我的 `ledger.json` / `balance-log.json` / `caps.json` 的读取函数（从 lib/index.js 导出或复制只读逻辑）。
- Produces:
  - `balancePayload(ctx) -> {ok:true, totalBalance:number, currency:string, ...}` 对齐 `/dsh-whale/balance.json` 格式
  - `lastTurnPayload(ctx) -> {turn:number, amount:number, tokens:number, ts:number}` 对齐 `/dsh-whale/last-turn.json`
  - `usageRecordsPayload(ctx) -> {events:[{ts,day,model,cost,tokens}], todayUsage, lastBalance, history, accounting, dayStart}` 对齐 `.dshw-usage.json` 结构
  - `usageSettingsPayload(ctx) -> 小鲸鱼 usage-settings.json 同构对象`
  - `apiModelsPayload(ctx) -> {models:[{id,name}]}` 对齐 `/dsh-whale/api-models.json`（用于倍率显示）

- [ ] **Step 1: 写字段结构夹具** — 从真实 `.dshw-usage.json` / balance.json 抓一份响应样本存为 `tests/fixtures/whale-*.json`，作为格式契约。
- [ ] **Step 2: 写失败测试** — 对每个 payload 函数断言：返回对象含夹具的全部顶层键、数值字段有限、date/day 为 `YYYY-MM-DD`。
- [ ] **Step 3: 实现 5 个 payload 函数**（只读我的账本/余额，纯函数式，无副作用）。
- [ ] **Step 4: 测试 PASS** + `node --check lib/whale-compat.js`。

### Task 4: 逐个切换数据源（阶段 2，每个路由独立闸门）

**Files:** Modify `lib/index.js` — 把 Task 3 的 payload 接到对应路由。

**顺序与验证（一次只切一个）：**
- [ ] **Step 1: `/dsh-whale/balance.json`** → 返回我的 `balancePayload()`。安装重启后看挂件余额数字变为我的。
- [ ] **Step 2: `/dsh-whale/last-turn.json`** → 我的 `lastTurnPayload()`（可从我的会话账本取最后一轮）。验证挂件"最近一轮"提示。
- [ ] **Step 3: `/dsh-whale/usage-records.json` + `/dsh-whale/usage-settings.json`** → 我的 usage 数据。验证"今日已用/峰谷"提示显示我的数字。
- [ ] **Step 4: `/dsh-whale/api-models.json`** → 我的模型列表（含倍率），保证挂件倍率显示一致。
- [ ] **Step 5: 图片/音频/角色/气泡类静态路由**（image.png/rua.gif/role-image.png/audio*/bubble*）：这些不涉及数据，直接服务 assets 文件 + 用户数据目录（~/.dsh/whale-roles 等）。逐个验证角色图、音效、自定义气泡能显示。
  每个 Step 后：`node --check` + 打包安装 + 重启 + 人工确认该提示正常。任一步失败 → 回滚该路由到小鲸鱼原实现（保留 Task1/2 成果）。

### Task 5: 端到端验证 + 卸载小鲸鱼（阶段 3，最后才做）

**前置条件：** Task 1-4 全部完成，且连续 24 小时使用无异常（可选但强烈建议）。

- [ ] **Step 1: 全功能冒烟** — 挂件显示、点击气泡切换文本/余额/今日/峰谷、角色图/音效/自定义图片上传、明暗主题、窗口缩放跟随。逐项打勾。
- [ ] **Step 2: 确认唯一提供者** — grep 确认我的插件是唯一注册 `/dsh-whale/*` 与注入行的插件（小鲸鱼即将卸载）。
- [ ] **Step 3: 卸载小鲸鱼** — `pnpm remove dsh-whale-widget` from profile，并移除 `dsh.profile.bundles` 中对应项。
- [ ] **Step 4: 重启 + 回归** — 完整重启，确认：DSH 正常启动、挂件仍显示、数据是我的、没有 `failed to load /dsh-whale/widget.js` 报错。
- [ ] **Step 5: 回滚预案** — 若出现任何致命错误：从 `_whale-merge-safety/` 恢复 profile-package.json，重新 `pnpm add` 小鲸鱼，重启。

## 时间与风险

- Task 1: ~0.5 天 | Task 2: ~1 天（高危）| Task 3: ~1 天 | Task 4: ~2 天 | Task 5: ~0.5 天
- 最大风险 = Task 2 注入机制（脚本-src 会拖垮 DSH）。已用 kind:script + onerror 吞错 + 强制重启闸门缓解。
- 第二风险 = 阶段 3 卸载后路由缺失。已用"确认唯一提供者 + 回滚预案"缓解。