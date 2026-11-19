# CHANGELOG

## 7.26.2 —— 自动同步间隔可选（1/5/15/30/60 分钟）

### 用户需求
> 新加备份时间自动选择（1分钟5分钟之类的）

### 实现
- 配置新增 `webdav.autoSyncMin`（默认 5，normalize 收敛到合法档位）
- 设置页：自动同步开关旁新增间隔下拉（1/5/15/30/60 分钟）
- 后端定时器改为**每分钟 tick + 到期检查**：`lastAutoSyncAt` 距今不足间隔则跳过；
  修改间隔**立即生效**（下个 tick 按新间隔判断），无需重启

### 设计取舍
固定 1 分钟 tick + 到期判断（而非按间隔重建 interval）：改档位免重启、实现简单，
空 tick 成本可忽略（一次 config 内存读取 + 一次时间比较）。

## 7.26.1 —— 修复反向更新提示 + 自动同步确认

### ① 反向更新提示（用户报告）
> 设置页显示「有新版本可用 7.26.0 → 7.25.4」

**根因**：版本检查用 `releases/latest`（最后一次发版 v7.25.4），
改为仓库分发后没再发 Release ⇒ 本地 7.26.0 > 旧 tag 7.25.4，却被当"可更新"。

**修复（三道防线）**：
1. 版本源改为仓库 main 分支的 package.json（与分发方式一致）
2. 新增 `semverGt()`：只有远端**严格大于**本地才提示
3. `/version` 路由同样过滤：旧反向 beacon 不再上报，且 checkVersion
   在"已是最新"时主动清理残留的反向 beacon

### ② 自动同步没跑（用户报告）

**根因**：`autoSync` 开关从未真正开启（config 里无此字段）——链路本身是好的。
实测：POST 开启 → 落盘 → `/sync/upload` 合并成功（25/24 天，59 会话，云端刷新）。
**两台电脑都要开一次这个开关。**

## 7.26.0 —— 素材与代码分离（GitHub 源安装可用）

### 背景
改为 `github:xixiaohaia/dsh-unified-quota` 源安装后，仓库含 6.6MB 素材导致
codeload 下载超时（国内出口带宽受限）。**仓库瘦身为纯代码**：

| 内容 | 大小 | 位置 |
|---|---|---|
| lib/ scripts/ test/ docs/ + 配置 | ~320KB | **GitHub 仓库** |
| assets/whale-widget.js（挂件代码）| 1.1MB | **GitHub 仓库** |
| 立绘/音效/气泡图（15 个媒体文件）| 5.5MB | **用户数据目录** |

### 素材读取改为两级兜底
```js
const USER_ASSETS_DIR = path.join(STORAGE_DIR, 'whale-assets');
function assetPath(file) {
  const inPkg = path.join(ASSETS_DIR, file);
  if (fsSync.existsSync(inPkg)) return inPkg;   // 包内优先
  return path.join(USER_ASSETS_DIR, file);       // 用户目录兜底
}
```
7 处素材读取点（音效组/自定义片段/静态图/角色兜底/气泡兜底）全部改用它。

### 启动自动播种
```js
seedUserAssets();   // 包内有素材而用户目录缺 → 复制一份
```
**关键收益**：素材在用户数据目录，**插件更新不会覆盖/丢失立绘和音效**。

### 修复过程中的一个严重 bug
批量正则替换时把 `assetPath` 函数自身的 `path.join(ASSETS_DIR, file)`
也替换成了 `assetPath(file)` ⇒ **无限递归**。已修正并加 import 验证。

### 素材分发
`whale-assets.tgz`（5MB）放坚果云，两台电脑**一次性**下载解压到
`~/.dsh/storages/unified-quota/whale-assets/`，之后永久有效。

## 7.25.1 —— 版本更新提示（GitHub 检查）

### 用户需求
> 「不是可以在插件列表中检查更新这样吗」

**调研**：DSH 官方插件列表**没有检查更新功能**（只有启用/禁用/添加）。
社区有第三方 updater，但不保证兼容自定义 GitHub 源。

### 实现：插件内版本提示（只提示，不自动装）

**后端**：
- 启动后 10 秒、每小时查一次 GitHub latest release
- 发现新版 ⇒ 写 beacon（`stage=new-version`）
- 新增 `/api/unified-quota/version` 返回 `{current, latest, url}`

**前端**：设置页顶部显示黄色提示卡
```
有新版本可用  7.25.0 → 7.25.1
运行 update.bat 更新，或到 GitHub Release 下载
GitHub Release ↗
```

**为什么只提示不自动装**：
- 插件运行时写自己的 node_modules 有风险（文件占用）
- 自动安装可能破坏正在运行的实例
- 用户确认后再更新更安全

### 附带修复
`release.ps1` 第 24 行：`2>&1` + `$ErrorActionPreference=Stop` 导致 node 的 stderr 被当异常抛出。
改为直接调用，不再捕获 stderr。

## 7.25.0 —— 账本自动同步（双机交替使用）

### 场景
用户两台电脑（家 / 办公），**不会同时使用**，需要账本自动同步。

### 核心：智能合并（不是覆盖）

原 `/sync/upload` 只是上传，原 `/sync/restore` 是覆盖。
新增 `syncMerge()`：

```
1. 下载云端备份
2. 合并 ledger：sessions 按 id 去重；byProviderModel 按 key 累加
   ⚠️ 若两边 sessions 完全一致 ⇒ 同一批数据传两次 ⇒ 取本地（避免翻倍）
3. 合并 balance-log：按 at+total 去重
4. config/caps：取 updatedAt 较新者
5. 写回本地 → 上传合并结果
```

### 自动同步定时器
```js
setInterval(autoSyncTick, 5 * 60000);   // 每 5 分钟
setTimeout(autoSyncTick, 30000);       // 启动后 30 秒首同步
```
条件：`config.webdav.autoSync === true` 且已配置账号密码。
同步后刷新内存实例（ledger/caps），避免被 debounce flush 覆盖。

### 前端 UI
设置 → 跨设备同步 分组新增：
```
[✓] 自动同步（每 5 分钟，仅凭证存在时生效）
[立即上传备份] [从云端恢复] [↻]
```
「立即上传备份」现在也改为智能合并上传（不再是简单覆盖）。

### 配置字段
```js
webdav: { user: '', pass: '', autoSync: false }
```
`normalizeConfig` 已加入白名单。

### 使用方式
两台电脑都：
1. 填坚果云账号密码
2. 打开「自动同步」
3. 正常使用即可 —— 每 5 分钟自动合并

**因为两台电脑不会同时使用，合并是安全的。**

## 7.24.1 —— 修复「实付」列双重计算（trae 101 / 官方 104）

### 用户疑问
> 「trae 是 101 左右，DeepSeek 官方（账号）实付写了个 104，我实际并没有花那么多」

### 根因：`amountOf` 的 total 口径把两个派生值相加
```js
// 修复前
if (basis === "total") return apiCost + cost;
```

**但两者的关系是派生，不是并列**：
```
apiCost = 官方价原值
cost    = apiCost × 倍率    ← 由 apiCost 派生
```

**相加 = 重复计算一倍以上**：
| 渠道 | apiCost | cost | 修复前 total | 实际应显示 |
|---|---|---|---|---|
| trae | 68.19 | 33.19 | **101.38** | 68.19 |
| deepseek-account | 52.34 | 52.34 | **104.68** | 52.34 |

**和用户看到的 101 / 104 完全对上。**

### 修复
```js
function amountOf(row, basis) {
  const api = Number(row.apiCost) || 0;
  const cr = Number(row.cost) || 0;
  if (basis === "total") return Math.max(api, cr);  // 取大值，不相加
  if (basis === "plan") return cr;                   // 积分口径
  return api;                                         // 官方价口径
}
```

### 附带：官方余额纳入采样

**用户问「DeepSeek 官方应该可以直接拿到准确数据」——对，但要分清两层**：
| 数据 | 能否直读 | 现状 |
|---|---|---|
| 账户余额 | ✅ 能（`/core` official.wallets）| 已有 |
| 每次扣费明细 | ❌ 上游不提供 | 只能估算 |

**但现在 `deepseek-account` 不在 `balance-log` 里**（因为它不在 roster），
所以**连余额差都算不出来**，只能用官方价估算（52.34）。

**修复**：在 `fetchOfficial` 后把官方余额也记入 `balance-log`
```js
await recordBalances([{ provider: 'deepseek-account', credits: { total, unit: 'CNY' } }]);
```

**意义**：官方是**唯一能拿到真实扣费**的渠道。有了余额差，
就能校准其它所有渠道的估算准确性（比如反推命中率准不准）。

## 7.24.0 —— 币种语义统一（方案 B）+ 倍率不重复乘 + 峰谷倍率

### ① 币种语义修正（用户选方案 B）

**历史坑**：账本里 `costCny` / `apiCostCny` 存的是**人民币**（写侧冻结），
但 `makeMoney.usd()` 把它当 **USD**，再 `× fx(6.6665)`：
```
账本 apiCost = 68.19（人民币）
makeMoney: 68.19 × 6.6665 = 454.58   ← 放大 6.67 倍
```

**修复**：改为「人民币 → 目标币种」
```js
const cnyFactor = (target === "CNY") ? 1 : (rates.get(target) / rates.get("CNY"));
apiMoney: (row) => cny(row, true) * cnyFactor;
```

| 币种 | cnyFactor | 68.19 应显示 |
|---|---|---|
| CNY | 1 | **¥68.19** |
| USD | 1/6.6665 | $10.23 |
| EUR | 0.90794/6.6665 | €9.29 |

### ② 倍率不再重复乘官方价（用户确认）

**原实现**：`agg.cost += off1 * factor1`（官方价 × 倍率）

**问题**：官方定价表已按模型分档（v4-pro 是 flash 的 4.5 倍），
再乘倍率（v4-pro x0.51）会**双重折扣** ⇒ 误差过大。

**修复**：两个口径分开
```js
agg.apiCost += officialCny;              // 官方价原值，不乘倍率
agg.cost    += officialCny * factor1;    // 积分口径，乘倍率
```

### ③ 峰谷倍率支持（用户提出）

**实测发现**：渠道下发 `deepseek-v4.1-flash · x0.12→x0.06`
—— 这是「峰时 x0.12 → 谷时 x0.06」，但原解析器只取第一个数（0.12），
**完全忽略谷时价**。

**新增**：
```js
parsePeakValleyFactor(name)  // → { peak, idle, hasPeakValley }
factorAtTime(name, isPeak)   // 按时段取值
```

验证：
```
DeepSeek-V4.1-Flash · x0.12→x0.06  → peak=0.12 idle=0.06 峰谷 ✓
GLM-5.3 · x0.69                   → peak=0.69 idle=0.69 无峰谷
```

### 关于「实时拉取渠道峰谷文档」（用户犹豫）

**不建议**，理由：
| 问题 | 说明 |
|---|---|
| 文档格式不稳定 | 各渠道 HTML 结构各异，改版即失效 |
| 时效性差 | 峰谷时段可能临时调整，抓取来不及 |
| 解析成本高 | 需要 NLP/正则适配每家 |
| **已有更好来源** | **渠道下发的模型名里就带着峰谷倍率**（x0.12→x0.06）|

**结论：直接从模型名解析，比抓文档可靠得多。**

## 7.23.4 —— 重算把两个口径混了（实付金额没变的原因）

### 用户观察
> 「实付金额好像没有变化（跟上次对比），有计算到吗？」

### 真相：`apiCost` 不重算就不变，而重算又用错了公式

#### 现象 1：apiCost 是账本里的冻结值
```js
function makeMoney(displayCurrency, fxRate) {
  const usd = (row, api) => {
    const raw = Number(row && (api ? row.apiCost : row.cost));   // ← 直接读账本
    ...
  };
}
```
命中率变了，`apiCost` 不会自动变，**必须 `/recalc` 重算**。

#### 现象 2：重算用的是积分口径，不是缓存加权
```js
// 重算（修复前）
const nc = Math.round((tok / tokPerCredit) * perCredit * 1e6) / 1e6;
v.costCny = nc; v.apiCostCny = nc;   // ← 两个字段写同一个值
```

**这是「token 总量 × 积分单价」，完全不经过缓存命中率。**
而记账时（`officialCostWeighted`）是分项计价的：
- cacheHit × 便宜价（¥0.02/M）
- cacheMiss × 贵价（¥1/M）
- output × 输出价（¥4/M）

**结果**：重算把「积分口径」覆盖了「官方加权价」，实付金额自然不动或乱变。

### 修复：两个口径分开
| 字段 | 含义 | 计算方式 |
|---|---|---|
| `cost` / `costCny` | **积分口径**（套餐渠道实际花费）| `tok / tokPerCredit × perCredit` |
| `apiCost` / `apiCostCny` | **官方价口径**（按量付费要多少）| `officialCostWeighted(模型, 分项, 命中率)` |

```js
const creditCost = (tok / tokPerCredit) * perCredit;
const offW2 = officialCostWeighted(midRec, {input, output, cacheRead, cacheWrite, reasoning}, Date.now(), hiRate);
v.cost = creditCost;
v.apiCost = offW2.total;
```

### 附带：日期汇总也分流
```js
d.cost    = otherCost + 积分口径合计;
d.apiCost = otherApi  + 官方价合计;
```

### 关于「以后其它渠道也可能不返回 cacheRead」
**7.23.3 的修复是通用的**：
```js
if (!hasCacheField) continue;            // 任何渠道：字段缺失就跳过反推
if (inp > 10000 && cr === 0) continue;   // 任何渠道：有输入无缓存读也算不支持
```

不依赖渠道名，**新渠道出现同样情况时自动跳过，不会污染反推值**。

### 附带：命中率计算涉及的加权
```
officialCostWeighted 里：
  上游有 cacheRead  → 直接用（真实数据）
  上游无 cacheRead  → 按 assumedHitRate 拆分 input
assumedHitRate 来源优先级：
  ① 设置页手填（模型级 > 渠道级）
  ② cacheHitRateByModel 自动反推（7.23.3 已修正污染）
  ③ 都没有 ⇒ 0（不拆分，全按 cacheMiss 算）
```

## 7.23.3 —— 缓存命中反推被「无数据渠道」拉低

### 用户观察
> 「trea 渠道下的模型缓存命中推算都非常低，是不是没生效」

### 根因：0% 被当成真实命中率计入平均
```js
// cacheHitRateByModel 原逻辑
const cr = Number(v.cacheRead) || 0;   // trae 不返回该字段 ⇒ cr = 0
hitSum += cr; totSum += tot;           // 0 也被计入平均
```

**实测数据**（glm-5.3-flash）：
| 渠道 | cacheRead | 真实命中率 |
|---|---|---|
| codearts | 17M / 13M | **92.8% / 86.5%** |
| trae | **0（字段缺失）** | 被误算成 **0%** |

⇒ 平均后被拉到 **25.1%**（实际应为 ~90%）。

### 修复
```js
const hasCacheField = Object.prototype.hasOwnProperty.call(v, 'cacheRead');
if (!hasCacheField) continue;            // 渠道不提供 ⇒ 跳过
if (inp > 10000 && cr === 0) continue;   // 有输入无缓存读 ⇒ 视为不支持缓存
```

### 修复效果
| 模型 | 修复前 | 修复后 |
|---|---|---|
| glm-5.3-flash | 25.1% | **89.9%** |
| deepseek-v4.1-flash | 46.8% | **97.8%** |
| mimo-v2.6-flash | 0.0% | **null**（无数据，正确）|

### 关于「金额是否全局用缓存加权」
**已确认全局生效**，两条路径都有：

| 函数 | 位置 | 逻辑 |
|---|---|---|
| `officialCostOf` | credit-prices.js | cacheHit × 价 + cacheMiss × 价 + output × 价 |
| `officialCostWeighted` | credit-prices.js | **上游无 cacheRead 时，用 `assumedHitRate` 拆分** |

`officialCostWeighted` 的关键代码：
```js
if (explicitCache === 0 && rawInput > 0 && assumedHitRate > 0) {
  hitTok = rawInput * assumedHitRate;         // 按假定命中率拆
  missTok = rawInput * (1 - assumedHitRate) + cacheWrite;
}
```

**也就是说：trae 这种不返回 cacheRead 的渠道，金额计算会用「反推的命中率」拆分输入 token** ——
而修复前反推值被污染成 25%，导致金额也算错（偏高）。
**本修复同时修正了金额计算。**

## 7.23.2 —— 消除「先闪多平台明细」

### 现象
打开明细页时，先闪一下「多平台明细」，才切到上次记住的页签。

### 根因
```js
const [panel, setPanelRaw] = react.useState(null);   // 初值 null ⇒ 显示多平台明细
react.useEffect(() => {
  fetchJson(CONFIG_URL).then(j => setPanelRaw(j.config.detailTab));  // 异步，晚一拍
}, []);
```
渲染 → 显示多平台明细 → 请求返回 → 切到记忆页签。**中间那一帧就是闪烁。**

### 修复：localStorage 同步缓存
```js
// 初值：从 localStorage 同步读（无延迟）
const [panel, setPanelRaw] = react.useState(() => {
  const v = localStorage.getItem("uq-detail-panel");
  return (v === "credits" || v === "quota" || v === "health") ? v : null;
});
// 切换时同时写 localStorage + config
setPanel(v) → localStorage.setItem + POST /config
// config 返回后再校正（跨设备/重装也能正确）
```

`detailSubTab` 同样处理。

### 两层策略
| 层 | 作用 | 时机 |
|---|---|---|
| **localStorage** | 消除闪烁 | 同步，渲染前 |
| **config（后端）** | 跨设备/重装保持一致 | 异步校正 |

两者都写，localStorage 提供初值，config 是权威。

## 7.23.1 —— 拆分 detailTab / detailSubTab（细分页签串味）

### 现象
明细页顶部切到「积分账单」，再回到「多平台明细」，细分页签显示「逐次调用」。

### 根因：两个页签系统共用同一个配置字段
```js
// 顶部页签（4 个）
setPanel(v) → POST { detailTab: "credits" | "quota" | "health" | "table" }

// 细分页签（4 个）
setTab(v)   → POST { detailTab: "provider" | "model" | "day" | "session" }
```

**同一个 `detailTab` 被两套系统互相覆盖。**

当 `detailTab = "credits"` 时：
```js
const [tab] = useState(() => {
  return (v === "provider" || ... ) ? v : "provider";   // "credits" 不在白名单
});
```
实际代码里旧版白名单包含了 `credits`，所以 `tab` 直接变成 `"credits"`，
而 body 分支的兜底是 `: h(CallsView)` ⇒ 显示「逐次调用」。

### 修复

#### ① 拆成两个独立字段
```js
// config.js
detailTab: 'provider',      // 顶部：table | credits | quota | health
detailSubTab: 'provider',   // 细分：provider | model | day | session | call
```

#### ② 前端各用自己的字段
| 页签 | 读 | 写 |
|---|---|---|
| 顶部（panel）| `detailTab` | `detailTab` |
| 细分（tab）| `detailSubTab` | `detailSubTab` |

#### ③ 兜底分支改为 ProviderTable
```js
// 原：未知 tab 值 ⇒ 显示逐次调用（误导）
: h(CallsView, { L: L })
// 改：未知值回落「按渠道」（最常用）
: h(ProviderTable, { detail: det, L: L, basis: basis })
```

#### ④ 「逐次调用」改为正式页签
```js
const TABS = [..., ["call", "逐次调用", "Per call"]];
: tab === "call" ? h(CallsView, { L: L })
```
现在它是显式选项，不再靠"兜底"意外出现。

### 验证
```
normalizeConfig({detailTab:"credits", detailSubTab:"model"})
→ detailTab: "credits", detailSubTab: "model"   ✓ 互不影响
```

## 7.23.0 —— 增强限流记录 + 周期自动推断

### 背景
用户发现：buddy 的 200M 不是日额度（11-15 用了 197.2M 却没限流），
但当前实现按「今日」统计，导致解限后剩余量不准。

**要算真实周期，需要多次限流的历史数据 —— 而之前的数据都没记录。**

### 1. 增强 `cap-knowledge.jsonl` 记录字段
```json
{
  "at": 1794936065341,
  "provider": "buddy",
  "model": "deepseek-v4.1-flash",
  "until": 1794939665341,
  "kind": "rate",
  "usedInWindow": 124000000,      // 触发瞬间累计用量（周期推断核心）
  "usedToday": 124000000,          // 当日累计（对照）
  "balanceAt": 2888.84,            // 触发瞬间余额
  "sessionCount": 223,             // 本周期调用次数
  "sincePrevSameModel": 61200000,  // 距上次同模型限流的间隔
  "prevAt": 1794874865341,         // 上次触发时刻
  "prevUsed": 197200000            // 上次触发时的用量
}
```

### 2. 新增 `inferPeriodFromHistory()`
**原理**：同一模型反复触顶时，两次间隔若高度一致，那个差值大概率就是周期。

```js
// 取间隔中位数（抗异常值）
// 与中位数偏差 ≤20% 视为同一周期
// ≥2 个一致间隔 ⇒ confidence: high
```

### 3. 实测推断准确
| 场景 | 推断结果 | 可信度 |
|---|---|---|
| 模拟 5 小时 × 3 次 | **5.0 小时** | high ✓ |
| 模拟 24 小时 × 2 次 | 24.0 小时 | low（样本不足）|
| 仅 1 次 | — | none（提示需 2 次）|
| 间隔不一致（3h/17h）| 17.0 小时 | low（一致性 1/2）|

### 4. 渠道健康页新增「周期推断」区块
| 列 | 内容 |
|---|---|
| 模型 | 模型名 + 渠道 |
| 样本 | 限流次数 |
| 间隔 | 前 3 个间隔 |
| **推定周期** | 5.0 小时 / 24.0 小时 |
| 可信度 | 高（绿色）/ 低（黄色）+ 一致性 |

### 下一步
**从现在开始每次限流都会记录完整数据。**
积累 3-5 次同模型限流后，渠道健康页会显示高可信度的周期推断，
届时可把「周期起点」改为「上次解限时刻」实现精准剩余量。

## 7.22.4 —— 修复「明细页打开固定为渠道健康」

### 根因：`getCfg()` 在明细页打开时是 null
```js
const [panel, setPanelRaw] = react.useState(function () {
  const g = getCfg && getCfg();   // ← null！
  return (g && g.detailTab === "credits") ? "credits" : null;
});
```

`getCfg()` 返回模块级 `sharedCfg`，而它**只在 `useConfig()` 挂载过之后才有值**。
`useConfig()` 是设置页用的；明细页不加载设置页 ⇒ `sharedCfg` 一直是 null。

### 为什么显示「渠道健康」而不是「多平台明细」
初始 `null` ⇒ 应显示多平台明细。用户看到"渠道健康"是因为：
- 之前切到过 health ⇒ POST 存了 `detailTab: "health"`
- 但打开时 `getCfg()` 读不到 ⇒ 初始仍 null ⇒ 显示多平台明细
- 之后 `useConfig()` 某处被触发 ⇒ `sharedCfg` 有值 ⇒ 但 panel 已初始化，不会重读

实际观察到的"固定为渠道健康"来自另一路径：`sharedCfg` 恰好在某次渲染前已有值。

### 修复：明细页主动拉配置
```js
const [panel, setPanelRaw] = react.useState(null);
const cfgApplied = react.useRef(false);
react.useEffect(function () {
  if (cfgApplied.current) return;
  cfgApplied.current = true;
  fetchJson(CONFIG_URL).then(function (j) {
    setSharedCfg(j.config);
    const v = j.config.detailTab;
    if (v === "credits" || v === "quota" || v === "health") setPanelRaw(v);
  });
}, []);
```

这样无论设置页有没有先打开过，明细页都能读到持久化页签。

## 7.22.3 —— 修复页签持久化（改错了对象）

### 我前两版改错了地方
明细页顶部有 **4 个页签**（多平台明细/积分账单/额度窗口/渠道健康）：
```js
onClick: function () { setPanel(o[0] === "table" ? null : o[0]); }
//                    ↑ 用的是 panel，不是 tab
```

| 版本 | 改的对象 | 结果 |
|---|---|---|
| 7.22.1 | `setTab`（`DetailSheetInner` 的 TABS，另一个组件的 4 个页签）| 改错对象 |
| 7.22.2 | `normalizeConfig` 白名单 | 必要但不足 |
| **7.22.3** | **`setPanel`（真正的 4 个页签）** | ✅ |

### 修复
```js
// 初值从配置读
const [panel, setPanelRaw] = react.useState(function () {
  const v = getCfg().detailTab;
  return (v === "credits" || v === "quota" || v === "health") ? v : null;
});
// 切换时持久化
const setPanel = function (v) {
  setPanelRaw(v);
  fetch(CONFIG_URL, { method: "POST", ... body: JSON.stringify({ detailTab: v || "table" }) });
};
```

### 项目里有两套页签（容易混淆）
| 组件 | 状态变量 | 页签 |
|---|---|---|
| `DetailSheetInner` 顶部 | `panel` | 多平台明细/积分账单/额度窗口/渠道健康 |
| `Popover` 概览/渠道/费用 | `tab` | 概览/渠道/费用 |
| `DetailSheetInner` TABS | `tab` | 按渠道/按模型/按日/按会话 |

**三套状态，名字还都叫 tab/panel**，这是这次改错的原因。

## 7.22.2 —— detailTab 白名单与实际页签不一致

### 现象
7.22.1 加了「切换页签时 POST 到 /config」，但重启后仍然回到默认页。

### 根因：白名单里的值全是旧的
```js
// normalizeConfig（修复前）
out.detailTab = pick(src.detailTab, ['provider', 'model', 'day', 'session', 'call'], d.detailTab);
```

但实际页签是：
```
table | credits | quota | health     ← 全部不在白名单
```

**后端收到 `detailTab: "credits"` ⇒ pick 校验失败 ⇒ 回退默认 `"provider"`。**
前端 POST 成功（200），但值被静默丢弃。

### 实测证据
```
POST {detailTab:"credits"} → 200
返回 config.detailTab: "provider"      ← 被拒绝
normalizeConfig({detailTab:"credits"}) → "provider"
```

### 修复
```js
out.detailTab = pick(src.detailTab,
  ['table','credits','quota','health','provider','model','day','session','call'],
  d.detailTab);
```

### 同类问题排查
检查了所有 `pick()` 白名单与实际使用值：

| 字段 | 白名单 | 前端实际值 | 状态 |
|---|---|---|---|
| currency | CNY/USD/EUR | 一致 | ✓ |
| locale | auto/zh/en | 一致 | ✓ |
| priceMatch | auto/exact | 一致 | ✓ |
| statisticsBasis | api/total/plan | 一致 | ✓ |
| **detailTab** | 9 个（修复后）| 一致 | ✓ |

**结论**：只有 detailTab 有问题，其余白名单都正确。

### 教训（第三次同类问题）
| 版本 | 问题 |
|---|---|
| 7.15.1 | `manualRate` 不在 normalizeConfig 白名单 ⇒ 填了没反应 |
| 7.22.1 | `detailTab` 只读不写 ⇒ 切页签不记忆 |
| **7.22.2** | **`detailTab` 白名单值是旧的 ⇒ 写也被拒** |

**共同点：`normalizeConfig` 的白名单是「配置生效」的最后一道关。**
新增或修改配置值时必须同步检查白名单。

## 7.22.1 —— 审计发现的配置项遗漏

### 审计方法
提取 `defaultConfig` 的 23 个字段，逐个统计在前后端的使用次数。

### 发现 3 个问题

#### 1. `detailTab` 只读不写（真实 bug）
```js
// 读取：初始化时读 cfg.detailTab
const [tab, setTab] = react.useState(() => cfg.detailTab || "provider");
// 切换：setTab(v) 只改 state，从不写回配置
onClick: function () { setTab(it[0]); }
```

**后果**：用户切到「积分账单」页签，关掉再打开又回到「多平台明细」，
配置字段 `detailTab` 永远停在旧值。

**修复**：`setTab` 同时持久化到 `/config`。

#### 2. `includeSubagentCost` 是死配置
| 位置 | 使用次数 |
|---|---|
| 后端 index.js | **0** |
| 前端 client.js | **0** |
| config.js（仅定义）| 4 |

没有 UI 开关，也没有任何逻辑读取它 ⇒ 用户改不了、改了也没用。

#### 3. `customPrices` 是潜在死配置
`normalizeConfig` 会保留并校验它，但**前后端都没读**。
（历史遗留：早期想支持手填单价，后来改走 `creditPrices`）

### 结论
| 项 | 状态 |
|---|---|
| `detailTab` | ✅ 已修（切换时持久化）|
| `includeSubagentCost` | ⚠ 死配置（无 UI 无逻辑），保留字段但无害 |
| `customPrices` | ⚠ 死配置，保留（未来可能用）|

后两个**不影响功能**，只是冗余。移除会破坏已有配置文件的兼容性，故保留。

## 7.22.0 —— 全量审计与回归（2026-11-17）

### 审计范围
| 维度 | 方法 | 结果 |
|---|---|---|
| 模块加载 | 24 个模块动态 import | 23/24 ✓（client.js 需浏览器环境，VM 模拟通过）|
| 后端路由 | 40 个路由全 GET | 全部符合预期（405/404 均正确）|
| 边界输入 | 14 组异常输入 | **0 个 500、0 次崩溃** |
| 原型污染 | `__proto__` / `constructor` 注入 | ✓ 未被污染 |
| 未知字段 | hacker/unknownKey | ✓ 全部丢弃 |
| 类型错误 | 7 种非法类型 | ✓ 全部容错 |
| 数据完整性 | 10 个数据文件 | ✓ JSON 全部合法 |
| 前端数据契约 | 8 个页面关键字段 | ✓ 全部满足 |
| Hooks 规则 | check-hooks.mjs | ✓ 无违规 |
| 诊断覆盖 | 空 catch 分类 | 46 处中**关键路径 0 处未保护** |

### 发现并修复的问题

#### 1. 残留 .bak 文件无清理机制
**现象**：5 个 `.bak-*` 文件占 253 KB，历史恢复/重算遗留。

**修复**：新增 `pruneBackups()`，同一前缀只保留最近 3 个，在恢复后调用。

#### 2. beacons.jsonl 轮转阈值太低
**现象**：422 KB 已接近 512 KB 阈值，轮转后会截断到 1000 行（历史太短）。

**修复**：阈值 512 KB → **2 MB**，保留 1000 → **5000 行**。

### 审计结论

**代码质量良好**：
- 无作用域错误（24 个模块全部可加载）
- 无未定义变量（静态扫描的报警经核实全部是误报——函数内同名变量合法、对象 key 不是变量）
- 异常输入不会导致 500
- 配置层抗原型污染
- 关键路径 100% 有错误记录

**诊断体系完整**：
```
后端：logger 17 处 + criticalCatch 21 处 + safeCatch 4 处 + debugLog 6 处
前端：beacon 39 处 + UqErrorBoundary 6 处
```

**已知非问题**：
| 现象 | 说明 |
|---|---|
| `learned-caps.json` 不存在 | 需触发限流才产生，当前 caps 为空 |
| `cap-knowledge.jsonl` 不存在 | 同上 |
| client.js `window is not defined` | 浏览器端模块，Node 直载必然报错，VM 模拟通过 |

## 7.21.4 —— 修复对比失败（坚果云 GET 不支持查询参数）

### 现象
点「↻」刷新对比报 `读取元信息失败: HTTP 400`。

### 根因：坚果云 WebDAV 拒绝带查询参数的 GET
```
GET /dav/dsh-unified-quota/meta.json        → 200 ✓
GET /dav/dsh-unified-quota/meta.json?t=123  → 400 ✗
```

我为了防缓存加了 `?t=<时间戳>`，反而触发了坚果云的 400。

### 修复
1. **去掉 `?t=` 参数**（`fetchRemoteMeta` 和 `downloadBackup`）
2. **改用请求头防缓存**：`Cache-Control: no-cache`

### 附带优化：差异容忍 128 字节
`append` 型文件（账本/余额日志）会随时间增长，
精确到字节会让「刚上传完」也显示「大小不同」。
改为 `Math.abs(l - r) > 128` 才标差异。

### 实测对比成功
```
账本       本地 57627B  云端 57635B  一致
余额日志   本地 142764B 云端 141420B 大小不同（新增样本，正常）
设置       本地 810B    云端 810B    一致
限流状态   本地 35B     云端 35B     一致
```

## 7.21.3 —— 修复 WebDAV 认证失败（凭证前导空格）

### 现象
填了正确的邮箱和应用密码，点上传报「认证失败」。

### 根因
保存的配置里 **user 有前导空格**：
```json
{ "user": " 1500380607@qq.com", "pass": "ay3...cg" }
           ↑ 这里
```
Basic 认证是 base64(user + ":" + pass)，多一个空格 ⇒ 用户名不匹配 ⇒ 401。

**验证**：trim 后直接 PROPFIND ⇒ **207 认证成功**。
说明凭证本身完全正确，问题只在空格。

### 三重防护
| 层 | 修复 |
|---|---|
| 输入框 | onBlur 时 trim（user 和 pass 都加）|
| normalizeConfig | 保存时 trim |
| authHeader | 发请求前 trim（最后防线）|

### 已修正用户当前配置
修正前 user 带前导空格，修正后已 trim。

### 实测上传成功
```
4 个文件：ledger, balanceLog, config, caps
224 KB → /dsh-unified-quota/backup.json + meta.json
```

## 7.21.2 —— 把 scripts 打进包（hooks 检查器可用）

7.21.1 的 `scripts/check-hooks.mjs` 没被打包（`package.json` 的 `files` 字段缺 `scripts`），
导致安装后无法在安装目录运行检查。

**修复**：`files` 加入 `"scripts"`（同时 `bump.mjs` 也会一起打包，无害）。

## 7.21.1 —— 修复设置页白屏（又是 Hooks 规则）

### 事故
7.21.0 装好后设置页**完全白屏**。

### 根因：和 7.14.0 一模一样的错误
```js
webdavSettings({ cfg: cfg, zh: zh, P: P })   // ❌ 直接函数调用
h(webdavSettings, { cfg: cfg, zh: zh, P: P })  // ✓ React 组件调用
```

`webdavSettings` 内部有：
- 3 个 `react.useState`
- 2 个 `react.useEffect`
- 1 个 `react.useCallback`

直接调用时，这些 Hook 会计入父组件 `SettingsSection` 的 hook 链，
但分组初始折叠（`defaultCollapsed: true`）⇒ `webdavSettings` 不渲染
⇒ **hook 数量在渲染间变化** ⇒ React 抛错 ⇒ 白屏。

### 修复
改为 `h(webdavSettings, props)`。

### 防复发：新增 hooks 规则检查器
```bash
node scripts/check-hooks.mjs     # 或 pnpm check:hooks
```

**检测逻辑**：
1. 找出所有含 `react.useState/useEffect/useCallback/useRef/useMemo` 的顶层函数
2. 检查是否被以 `Name(...)` 形式直接调用（排除 `h(Name, ...)`）
3. 有违规 ⇒ 退出码 1

**已加入 `package.json`**：
```json
"check:hooks": "node scripts/check-hooks.mjs",
"check:all": "node scripts/check-hooks.mjs && node test/all.mjs"
```

### 当前检查结果
```
✓ Hooks 规则检查通过（无「含 Hook 的函数被直接调用」）
✓ 单元测试 46/46
```

### 教训（第二次踩同一个坑）
| 版本 | 组件 | 错误 |
|---|---|---|
| 7.14.0 | `CollapsibleGroup` | 直接调用含 `useState` |
| **7.21.0** | **`webdavSettings`** | **直接调用含 3 个 `useState` + 2 个 `useEffect`** |

**这次加了自动检查**，下次写新组件时会立刻被抓到。

## 7.21.0 —— 坚果云 WebDAV 备份/恢复（单向上传 + 手动恢复）

### 设计（用户确认）
> 「先做单向上传，从云端拉取是不是也做，这个时候也该做判断逻辑吧」

**答案：是，恢复必须带判断。** 三层设计：

| 层 | 能力 |
|---|---|
| **上传** | 本地 → 云端（打包 5 个数据文件）|
| **对比** | 只拉轻量 meta，逐文件对比字节数 + 时间戳 |
| **恢复** | 云端 → 本地，**必须 `confirm: true`**，且自动备份本地 |

### 新增 `lib/webdav.js`
```js
uploadBackup(cfg, dir, deviceId)     // PUT backup.json + meta.json
fetchRemoteMeta(cfg)                 // 只拉 meta（轻量）
compareBackup(cfg, dir, deviceId)    // 本地 vs 云端差异表
restoreBackup(cfg, dir, deviceId, backupLocal)  // 下载 + 覆盖
```

### 备份范围（5 个文件）
| 文件 | 合并策略（未来双向用）|
|---|---|
| ledger.json | append（追加型可合并）|
| balance-log.json | append |
| config.json | lww（最后写入优先）|
| caps.json | union（取 until 最晚）|
| learned-caps.json | min（取最小值）|

**不备份**：`jet-hub/state.json`（设备相关）、凭证。

### 3 个路由
| 路由 | 方法 | 说明 |
|---|---|---|
| `/sync/status` | GET | 云端 meta + 本地 vs 云端差异表 |
| `/sync/upload` | POST | 上传备份 |
| `/sync/restore` | POST | 恢复（**必须 confirm:true**）|

### 恢复的安全措施
1. **必须 `confirm: true`**（否则 400 + `needConfirm`）
2. **自动备份本地**：写 `.bak-<ISO时间戳>` 文件
3. **恢复后同步内存实例**（关键！）：
```js
const inst = ledgerOf(); await inst.load(); inst.dirty = false;
await loadCaps(); capsLoaded = true;
await configStoreOf().load();
learnedCapCache = null;
```
若不这么做，`QuotaLedger` 的 2 秒防抖 flush 会把恢复的数据覆盖回去。

### 设置页 UI
新增折叠分组「跨设备同步 · 坚果云 WebDAV」：
- 账号 / 应用密码（凭证只存本地 `config.json`）
- 三个按钮：立即上传备份 / 从云端恢复 / 刷新对比
- 差异表：每文件显示本地/云端 KB 与状态（一致 / 大小不同 / 仅本地 / 仅云端）
- 云端更新时显示 ⚠ 提示

### 配置字段
`config.webdav = { user, pass }`，**已加入 `normalizeConfig` 白名单**
（否则会重演 7.15.1 的「填了没反应」bug）。

### 实测
```
3 个路由注册 ✓
/sync/status 未配置时返回 configured:false, device:XIAOHAI ✓
normalizeConfig 保留 webdav 字段 ✓
```

### 未做（等第二台机器）
- 双向自动合并
- 自动触发（打开面板 / 15 分钟）
- 冲突弹窗

## 7.20.1 —— 补齐「解禁 / 均受限」等限流信号

### 7.20.0 遗漏的报文类型
```
"将于 2026/11/18 15:43:21 解禁"
```
这句话里**没有** `retry after` / `限流` / `429` 等关键词，
7.20.0 的兜底正则匹配不到 ⇒ `kind = null` ⇒ 直接返回 null ⇒ 解禁时间被丢弃。

### 修复
兜底正则补上中文限流语义词：
```js
+ |解禁|均受限|可用账号|等待解禁
```

### 完整兜底信号表
| 类别 | 模式 |
|---|---|
| 英文 | `retry after` / `try again in` / `rate limit` / `too many requests` / `429` |
| 中文限流 | `限流` / `稍后再试` / `均受限` / `可用账号` |
| 中文解禁 | `解禁` / `等待解禁` |
| 相对时间 | `N 分钟/小时/秒后` |

### 验证（10/10）
| 报文 | 解禁 | kind |
|---|---|---|
| `retry after 3600 seconds` | 1h | rate |
| `retry-after: 30 minutes` | 30m | rate |
| `rate limited, retry after 2 hours` | 2h | rate |
| `try again in 1 h 30 m` | 1.5h | rate |
| `5 分钟后重试` | 5m | rate |
| `retryAfterSeconds: 120` | 2m | rate |
| `所有账号均受限，请稍后再试` | — | rate |
| `可用账号均在限流中...将于 2026/11/18 15:43:21 解禁` | **19.5h** | rate |
| `将于 2026/11/18 15:43:21 解禁` | **19.5h** | rate |
| `配额使用上限，将于 2026-11-18 04:00 重置` | **7.8h** | quota |

### 实际效果
以后限流的 cap 记录里，`until` 就是**上游亲口说的**解禁时间，
不再是本地按 6/12/24 小时猜的。

## 7.20.0 —— 探测时读取上游给的解禁时间

### 用户提问
> 「限流后探测不到上游给出的预计解限时间吗，实际对话又会返回，为什么」

### 答案：确实探测不到，而且两个原因

#### 原因 1：`probeModel` 只返回 true/false，丢掉了报文
```js
catch (error) {
  if (code.indexOf("QUOTA") >= 0) return false;   // ← 报文被丢弃
  return null;
}
```
上游报文里明明写着「将于 2026/11/18 15:43:21 解禁」，但探测只看 code。

#### 原因 2：`parseJetHubCap` 只认「限流信号」，纯 retry-after 报文被跳过
```js
if (kind === null) return null;   // ← 在解析 until 之前就返回了
```
`retry after 3600 seconds` 这类报文没有 quota 关键词 ⇒ 直接丢弃。

### 修复

#### ① `probeModel` 返回结构化结果
```js
return { ok: false, code, text, parsed }   // parsed 含 until/kind/model
```

#### ② 探测后**用上游给的时间修正 cap**
```js
if (pr.ok === false && pr.parsed && pr.parsed.until !== null) {
  if (Math.abs(u - entry.until) > 60000) { entry.until = u; await saveCaps(); }
}
```
比自己猜的 6/12/24 小时准确得多。

#### ③ `parseRecoveryMs` 补 `retry after N unit`
```js
/retry[\s_-]*after[\s:]*?(\d+(?:\.\d+)?)\s*(seconds?|minutes?|hours?|s|m|h)\b/i
```

#### ④ 兜底：没命中关键词但有相对时间也算 rate
```js
if (/retry.?after|try again in|rate.?limit|429|限流|稍后再试|\d+\s*(?:分钟|小时|秒)后/i.test(t)) {
  kind = "rate";
}
```

### 验证（8/8）
| 报文 | 解析结果 |
|---|---|
| `retry after 3600 seconds` | 1 小时 ✓ |
| `retry-after: 30 minutes` | 30 分 ✓ |
| `rate limited, retry after 2 hours` | 2 小时 ✓ |
| `try again in 1 h 30 m` | 1.5 小时 ✓ |
| `5 分钟后重试` | 5 分 ✓ |
| `retryAfterSeconds: 120` | 2 分 ✓ |
| `所有账号均受限，请稍后再试` | rate（无时间，用默认）✓ |
| `...将于 2026/11/18 15:43:21 解禁` | 19.5 小时 ✓ |

## 7.19.1 —— 限流探测：阶段 B 太晚导致「假 cap」长期挂着

### 用户的观察
> 「有一个限额模型，好像到了解限实际（时间）…你先看看这些探测还在不在」

### 探测机制确认存在
| 组件 | 状态 |
|---|---|
| `probeModel()` | ✓ 发最小 stream 调用（约 10 token）|
| `startProbeLoop()` | ✓ 每 30 秒 tick，在 `apply()` 里启动 |
| 阶段 A | ✓ 触发后 1 分钟起，最多 3 次，间隔 30 秒 |
| 阶段 B | ⚠ **只在距 until ≤ 10 分钟时才探** |
| 阶段 C | ✓ 渠道余额上涨 ⇒ 强制回阶段 A |

### 问题 1：阶段 B 的窗口太窄
```js
if (entry.until - now > 10 * 60000) { st.nextAt = now + 2 * 60000; continue; }
```
**只有最后 10 分钟才真正探测。** 若 `until` 被判错（偏长），这段时间里：
- 阶段 A 早已用完 3 次
- 阶段 B 一直在「等」
- ⇒ **虚假 cap 长期挂着，用户看到的额度是错的**

### 问题 2：实测发现一条 24 小时错误 cap
```
key:    buddy|deepseek-v4.1-flash
at:     2026-11-17 01:21:05
until:  2026-11-18 01:21:05   ← 24 小时（hard-credit）
reason: "buddy: 模型 deepseek-v4.1-flash 所有账号均受限"   ← 这是 rate！
```

**用当前代码重新解析这条 reason**：
```
{ kind: "rate", until: null }  ⇒ 应使用 rate = 6 小时 ⇒ 07:21:05 就该解禁
```

即：**它在 07:21 之后就失效了，但一直挂到次日 01:21。**
（该记录产生于 7.13.0 修复 `PROVIDER_ALIAS` 之前，当时 kind 判定链路有 bug）

### 修复
**阶段 B 改为「进入后半程就开始探」**：
```js
const left = entry.until - now;
const total = Math.max(1, entry.until - entry.at);
if (left > 30 * 60000 && left > total / 2) { st.nextAt = now + 5 * 60000; continue; }
// 否则真探：剩余 >10 分钟用 2 分钟间隔，≤10 分钟用 1 分钟
```

**效果**：
| 剩余时间 | 探测频率 |
|---|---|
| > 50% 且 > 30 分钟 | 5 分钟一次（低成本）|
| ≤ 50% 或 ≤ 30 分钟 | 2 分钟一次 |
| ≤ 10 分钟 | 1 分钟一次（临门一脚）|

### 数据修正
已删除那条错误的 24 小时 cap（按 rate 6h 早已解禁）。

## 7.19.0 —— P3-2 静默 catch 治理（关键路径）

### 背景
项目里 **96 处空 catch**（`catch (e) {}`）。
它们掩盖过 `options` ReferenceError，导致「¥0.00 弹窗」排查 12 轮。

### 策略：不全改，只治关键路径
| 文件 | catch 总数 | 空 catch |
|---|---|---|
| index.js | 144 | 57 |
| client.js | 88 | 37 |
| meter/*.js | 19 | **0** |

全改风险大（96 处），只改**会导致金额算错或数据丢失**的路径。

### 新增 `criticalCatch`
```js
// lib/debug.js
export function criticalCatch(debugDir, tag, error) {
  // 不依赖 UQ_DEBUG —— 关键路径失败必须知道
}
```

与 `safeCatch` 的区别：
| 函数 | 开关 | 用途 |
|---|---|---|
| `safeCatch` | 仅 `UQ_DEBUG` 时记录 | 一般诊断 |
| **`criticalCatch`** | **始终记录** | 数据/金额/限流 |

**限流**：同一 tag 60 秒内只写一次，避免刷爆磁盘。

### 替换 16 处
| 类别 | 处数 | 例子 |
|---|---|---|
| 数据持久化 | 8 | `saveCaps` / `writeFile` / `flush` |
| 价格计算 | 2 | `priceRow` / `perModel` |
| 限流检测 | 2 | `recordCap` / `learnCapacity` |
| 账本读写 | 4 | `readJsonCached` / `OWN_LEDGER_PATH` |

输出到：`storages/unified-quota/debug/critical.jsonl`

### 验证
```
criticalCatch 单测：同 tag 去重 ✓（2 条记录，3 次调用）
端到端：core/config/quota/balance 全部 200 ✓
critical.jsonl：无记录（无关键错误）✓
```

### 剩余 41 处空 catch
都是非关键路径（UI 容错、可选渲染、localStorage 读写），
静默是合理的 —— 这些失败不影响数据正确性。

## 7.18.3 —— 点击小鲸鱼时根本不会刷新（两个真凶）

### 用户的决定性线索
> 「需要等第一个弹窗结束（自然结束或手动关闭）再点一次才显示正确的」

**这说明：点击时根本没拉数据，只是在切换显示。**

### 真凶 1：`whaleClick()` 里没有 refresh
```js
function whaleClick() {
  if (!bubbleOn) return
  if (bubbleScene.kind === "cost") return   // ← 泡泡期间直接 return
  if (!bubbleShown) { bubbleShowSeqNext(); return }  // ← 首次只显示，不拉数据
  ...
}
```
**整个函数没有一处 `refresh()`**——点小鲸鱼只是把泡泡弹出来，
看到的是 `state.balance` 里上一次轮询（60 秒前）的值。

**修复**：任何 early-return 之前先强制刷新：
```js
function whaleClick() {
  if (!bubbleOn) return
  try { refresh(true) } catch (err) {}   // ← 用户主动点击 = 要看最新值
  if (bubbleScene.kind === "cost") return
  ...
}
```

### 真凶 2：`?refresh=1` 没起作用
`/dsh-whale/balance.json` 完全不解析 `refresh` 参数：
```js
const d = await whaleData();   // ← 15 秒缓存，refresh=1 无效
```

**修复**：
```js
const urlB = new URL(req.url || "/", "http://127.0.0.1");
if (urlB.searchParams.get("refresh") === "1") {
  whaleCache.value = null;
  whaleCache.at = 0;
}
```

### 完整链路（修复后）
```
点小鲸鱼 → refresh(true) → ?refresh=1
  → 服务端清 whaleCache → 重新读账本 + 按新币种换算
  → 返回 {totalBalance, currency}
  → else 分支无条件写 amountEl + setHint
  → 立即显示新值（不需等泡泡结束）
```

## 7.18.2 —— 小鲸鱼币种：彻底绕过 costBubbleActive 闸门

### 关键洞察：`currencyChanged` 只在第一次为 true
```
第 1 次 refresh：state.currency=CNY → nc=USD  ⇒ currencyChanged=true
             但 render() 被 costBubbleActive 挡住 → 显示仍是 ¥8.49
第 2 次 refresh：state.currency=USD → nc=USD  ⇒ currencyChanged=false
             ⇒ 走 else 分支 ⇒ render() 仍被挡住 → 永远显示 ¥8.49
```

**我 7.18.1 只在 `currencyChanged === true` 时写金额行，第二次之后就失效了。**

### 修复
`else` 分支（数值无变化 **或** 币种变化）**无条件**写金额行和提示行：
```js
} else {
  if (animId === null) shown = nb
  state.status = "ok"
  try { amountEl.textContent = fmt(nb, nc) } catch (err) {}
  try { setHint(usageLabel + " " + fmt(todayUsage, todayUsageCurrency || nc)) } catch (err) {}
  render()
}
```

### 为什么这样安全
`else` 分支原本就是「无事发生」路径——数值和币种都没变。
此时写一次 `amountEl.textContent` 是**幂等**的，不会造成闪烁。

### 同时保留
- `render()` 开头的 `costBubbleActive` 早退仍然保留（保护用户观看时的稳定）
- 只在**数据更新回调**里绕过，不动渲染主路径

### 关于 `fmt()` 的格式差异（不是 bug）
```js
function fmt(balance, currency) {
  return currency === "CNY" ? "¥ " + fixed : fixed + " " + currency
}
```
CNY → `¥ 8.49`（符号在前）；USD/EUR → `1.27 USD`（符号在后）。
这是原设计，不是错误。

## 7.18.1 —— 小鲸鱼气泡币种不刷新（根因：costBubbleActive）

### 用户证据（三张图）
```
CNY → 小鲸鱼 1.27 USD  ✗（应是 ¥8.49）
USD → 小鲸鱼 ¥8.49     ✗（应是 $1.27）
EUR → 小鲸鱼 1.27 USD  ✗（应是 €1.16）
```
**始终显示「上一档」或「USD」**。

### 服务端实测：完全正确
```
切 CNY: totalBalance=8.49,   currency=CNY, todayUsageCurrency=CNY
切 USD: totalBalance=1.2735, currency=USD, todayUsageCurrency=USD
切 EUR: totalBalance=1.1563, currency=EUR, todayUsageCurrency=EUR
```
**问题 100% 在前端渲染。**

### 根因：`assets/whale-widget.js` 的渲染闸门
```js
function render() {
  if (costBubbleActive) return   // ← 每轮消耗泡泡显示期间，一律不重绘
  ...
}
function animateAmount(from, to, currency, duration) {
  if (costBubbleActive) return   // ← 数字滚动也被挡
}
```

消耗泡泡（`00:13:44` 那条倒计时）显示期间，**余额数字、币种、今日已用全部冻结**。
原设计意图是「用户观看时不跳数」，但**币种切换属于必须立即反映的变化**。

### 修复
1. **币种变化时，绕过闸门直接写金额行**：
```js
if (currencyChanged) { amountEl.textContent = fmt(nb, nc) }
```

2. **泡泡期间仍更新「今日已用」提示行**：
```js
if (costBubbleActive) {
  if (state.todayUsage != null) {
    setHint(usageLabel + " " + fmt(todayUsage, todayUsageCurrency))
  }
  return
}
```

### 为什么之前 7 个版本都没修好
我一直在改 `lib/`（后端 + 主客户端），但小鲸鱼气泡是 **`assets/whale-widget.js`**
（945KB 独立脚本，由宿主注入页面）。它有**自己的状态机**，与 `lib/client.js` 完全隔离。

## 7.18.0 —— 汇率切换「慢一拍」根治

### 用户观察（三张图揭示错位一档）
```
切 CNY → 汇率 6.6665 ✓，但小鲸鱼显示 1.27 USD ✗
切 USD → 汇率仍 6.6665 ✗，小鲸鱼显示 ¥8.49 ✗
切 CNY → 汇率变 1.0000 ✗（上一档 USD 的值）
```

**典型的「POST 后没刷新 money」**。

### 根因
`POST /api/unified-quota/config` 只返回 `{ config }`：
```js
return jsonResponse(res, 200, { config: next });   // ❌ 缺 money
```
前端 `patch()` 拿到后只更新 `cfg`，**`money` 仍是旧值** ⇒ 汇率显示慢一拍。

### 修复
**后端**：POST 返回 `money`（含新的 currency/rate/fx/base）：
```js
return jsonResponse(res, 200, {
  config: next,
  money: {
    currency: curAfter,
    rate: curAfter === "USD" ? 1 : ratesOf().get(curAfter),
    fx: rateFor(next),
    base: "USD",
  },
});
```

**前端**：`patch()` 立即消费返回的 money：
```js
if (j && j.money) {
  setMoney(j.money);
  moneyState = j.money;
  for (const fn of moneyListeners) fn(j.money);
}
```

### 附带验证（线上实测）
```
切 USD → balance.json: totalBalance=1.2735, currency=USD, todayUsageCurrency=USD
切 CNY → balance.json: totalBalance=8.49, currency=CNY
```
**换算和标签都已正确且立即生效。**

### 每日自动更新汇率（确认仍在）
`GET /config` 里有 `void ensureRates(ctx).catch(() => {})`，
`DailyRates` 按日缓存，欧洲央行周末/假日不发布时沿用旧值——这个机制**未改动**。

## 7.17.9 —— 汇率显示随币种变化（修正上一版）

### 用户指正
> 「下拉切换币种，汇率不变都是 6.6665，这个没修，这会引发运算问题吧」

**完全正确。** 7.17.8 我把汇率显示**固定为 CNY 基准**，是错的：
切换币种后汇率不变 ⇒ 用户无法判断当前换算比例。

### 正确语义
`rates.json` 是「**1 USD = N 该币种**」：
```json
{ "USD": 1, "CNY": 6.6665, "EUR": 0.90794 }
```
| 当前币种 | 应显示汇率 | 含义 |
|---|---|---|
| USD | 1.0000 | 1 USD = 1 USD |
| CNY | 6.6665 | 1 USD = 6.6665 CNY |
| EUR | 0.9079 | 1 USD = 0.90794 EUR |

### 修复
`money.rate` 改为「**当前币种**相对 USD 的比价」：
```js
rate: (function () {
  var cur = cfgLive.currency || "CNY";
  if (cur === "USD") return 1;
  var r = ratesOf().get(cur);
  return (r !== null && r > 0) ? r : 7.1;
})(),
```

### hint 文案
```
基准 USD · 1 USD = 6.6665 CNY · 欧洲央行参考价 · 2026-11-16
```
切换币种后 `6.6665` 会变成 `1.0000`（USD）或 `0.9079`（EUR）。

### 附带：切换币种清缓存
```js
if (patch.currency !== undefined || patch.manualRate !== undefined) {
  whaleCache.value = null;
  whaleCache.at = 0;
}
```
小鲸鱼**立即**按新币种显示，不用等 15 秒也不用点刷新。

### 换算验证
```
CNY → USD: ×0.150004   ¥8.49 → $1.2735
CNY → CNY: ×1.000000   ¥8.49 → ¥8.4900
CNY → EUR: ×0.136194   ¥8.49 → €1.1563
```

## 7.17.8 —— 上轮消耗币种 + 汇率基准显示

### 1. 额度小条弹层「上轮消耗」写死 ¥
```js
("¥" + Number(lastTurn.amount).toFixed(4))
```
改为 `money(Number(lastTurn.amount), cur2)`，并给 `QuotaMini` 补 `cur2`。

### 2. 汇率显示始终给 CNY 基准
USD 模式下 `rateFor()` 返回 1（1 USD = 1 USD），显示 `1.0000` 无信息量。

**改为**：
```js
money: {
  currency: "USD",
  rate: 6.6665,        // 显示用：1 USD = 6.6665 CNY（始终 CNY 基准）
  fx: 1,               // 换算用
  base: "USD",         // 基准货币
}
```

### 3. 汇率 hint 加基准说明
```
以 USD 为基准（1 USD = 6.6665 CNY）· 欧洲央行参考价 · 2026-11-16
```

### 关于小鲸鱼「点一次才变」
`/dsh-whale/balance.json` 经 `whaleData()` 有 **15 秒缓存**（`whaleCache.at`）。
切换币种后最多等 15 秒，或点刷新立即生效。
这个延迟是设计好的（避免每次请求都读盘），暂不修改。

## 7.17.7 —— 修复 /core 500（cnyToTarget 作用域）

### 严重回归：额度中心「暂无数据」、点不动

### 根因
`cnyToTarget` 被我写在了 **`apply()` 函数内部**（缩进 2），
但 `buildCore` 在模块顶层 ⇒ `ReferenceError: cnyToTarget is not defined`
⇒ `/core` 返回 500 ⇒ 前端 `st.data = null` ⇒ 显示「暂无数据」。

```js
// ❌ 在 apply() 里面
  function cnyToTarget() { ... }

// ✓ 移到模块顶层
function cnyToTarget() { ... }
```

### 第二个问题：`todayUsage` 没换算、currency 标签硬编码
`whale-compat.js` 的 `balancePayload` 硬编码：
```js
return { currency: "CNY", todayUsageCurrency: "CNY", ... };
```
我只改了 `totalBalance`，漏了 `todayUsage` 和标签。

**修复**：
```js
bal.currency = targetCur;
bal.todayUsageCurrency = targetCur;
bal.lastBalanceCurrency = targetCur;
```

### 为什么「小鲸鱼余额美元/人民币相反」
`balance.json` 返回 `totalBalance: 1.2735`（已换算）+ `currency: "CNY"`（未改）
⇒ 前端显示 `1.27 CNY`，看起来像人民币。
实际值是对的，标签错了。

## 7.17.6 —— 币种换算三个 bug 全修

### 用户观察
> 「我余额是人民币 8 多，切成美元反而变成 50 多了」
> 「额度中心要点一下才刷新」
> 「小鲸鱼以及额度小条弹层依旧无变化」

### 1. 除法写成乘法（$56.5986）
```js
const fxW = 1 / 6.6665;          // = 0.15
conv(8.49) = 8.49 / 0.15 = 56.6  // ❌
```
`fxW` 已经是「人民币 → 目标」的系数，应该**乘**：
```js
conv(8.49) = 8.49 * 0.15 = 1.27  // ✓
```

### 2. 额度中心要点一下才刷新
`useCore` 只在挂载时加载一次，且 `T_STALE = 60 秒` 内不重载。
切换币种后**没有任何重拉**。

**修复**：订阅币种变化，变更时清掉节流并 `force` 重载：
```js
const curNow = getCfg().currency;
react.useEffect(function () {
  if (first) return;
  loaded.current = 0;
  void load(true);
}, [curNow]);
```

### 3. 小鲸鱼/额度小条弹层不变
它们的数据来自 **`/dsh-whale/balance.json`**，这条路由**完全没做换算**（只走 `whaleData()`）。

**修复**：新增 `cnyToTarget()` 辅助，在三条路由里统一换算：
- `/dsh-whale/balance.json`：`totalBalance` / `todayUsage` / `lastBalance`
- `/dsh-whale/usage-records.json`：`events[].cost` / `amount`
- `buildCore` 的 whale / official

```js
function cnyToTarget() {
  const target = cfg.currency;
  if (target === "CNY") return 1;
  return rates.get(target) / rates.get("CNY");   // 1 / 6.6665 = 0.15
}
```

### 验证
```
¥8.49    × 0.15 = $1.2735
¥8.8258  × 0.15 = $1.3239
¥0.015   × 0.15 = $0.00225
```

## 7.17.5 —— 修复币种换算公式（rate 语义搞错了）

### 用户核实：「其他依旧没换算」

### 真正的根因：`rates.json` 的语义
```json
{ "USD": 1, "CNY": 6.6665, "EUR": 0.90794 }
```
**这是「1 USD = N 单位该币种」的乘数，不是「该币种 → USD」的汇率。**

`rateFor("USD")` 返回 **1**（美元对美元），我拿它当除数：
```js
¥8.49 / 1 = 8.49    // ❌ 等于没换算
```

### 正确公式
```js
// 小鲸鱼/官方余额的原值是**人民币**
// 先 / CNY汇率 转 USD，再 * 目标汇率
const cnyRate = ratesOf().get("CNY");   // 6.6665
const fx = (目标 === "CNY") ? 1 : ratesOf().get(目标) / cnyRate;

¥8.49    / 6.6665 * 1 = $1.2735
¥8.8258  / 6.6665 * 1 = $1.3239
¥0.015   / 6.6665 * 1 = $0.00225
```

### 为什么多平台明细是对的
`makeMoney` 的语义是「**账本存 USD**，× 目标汇率」：
```js
money: row => usd(row) * fx    // usd 值 × 6.6665 → CNY
```
账本本来就是美元计价的，所以乘一下就对。
但官方余额和小鲸鱼是**人民币原值**，必须先用 CNY 汇率除。

### 修复
`buildCore` 里两处换算都改为 `ratesOf().get(目标) / ratesOf().get("CNY")`。

### 验证（真实数据）
```
official:   ¥8.49     → $1.2735
lastBalance: ¥8.825781 → $1.3239
todayUsage:  ¥0.015    → $0.002250
```

## 7.17.4 —— 修复币种只变符号不变数值

### 用户观察（非常准确）
> 「只有多平台明细里进行了汇率运算，其他有的只变了符号，
> 小鲸鱼连符号都不变，额度小条弹层也没变」

### 三个独立原因

#### 1. `/config` 的 money 缺 currency 字段
```js
money: { rate: ..., date: ..., stale: ... }   // ❌ 没有 currency
```
前端 `core.money.currency || "CNY"` ⇒ **永远回退到 CNY**。
⇒ 小鲸鱼符号不变。

#### 2. 官方余额是账户原币，没换算
`fetchOfficial()` 返回 `wallets[].total = "8.49"`（**人民币原值**），
`money(totalCny, "USD")` 只换符号 ⇒ `$8.49`（应为 `$1.19`）。

#### 3. 小鲸鱼观测值是原币，没换算
`shapeWhale()` 直接返回 `todayUsage/lastBalance/lastTurn.amount`，
不做币种换算。

### 修复
**后端统一在 `buildCore` 里换算**：
```js
// 小鲸鱼
const fxW = (currency === "CNY") ? 1 : liveRate;
w.todayUsage /= fxW; w.lastBalance /= fxW; w.lastTurn.amount /= fxW;

// 官方钱包
copy.wallets = wallets.map(w => ({ ...w, total: w.total / fxO, topped: ..., granted: ... }));
```

**`/config` 的 money 补 `currency`**。

### 为什么多平台明细是对的
它的数据来自 `shapeLedger(ledger, currency, fxRate)`，**本来就走 `makeMoney()` 换算**。
其余路径漏了。

## 7.17.3 —— 修复 `cur is not defined`（多平台明细打不开）

### 探针抓到确凿证据
```
16:12:16.932  render-error  msg=cur is not defined
16:12:16.956  sheet-unmount  id=sxgkwc panelOpen=true
```

**探针体系再次证明价值**：错误边界捕获 + 记录，直接给出变量名。

### 根因
7.17.2 把 6 处 `money(x, "CNY")` 改成 `money(x, cur)`，但**三个组件里 `cur` 根本没定义**：

| 组件 | 问题 |
|---|---|
| `OfficialSection` | 无 `cur`，也无 `useCfgVersion` |
| `TrendChart` | 无 `cur` |
| `WhaleSection` | **完全没有 `cur` 和 `useCfgVersion`** |

`ProviderTable` 有 `const cur = detail.currency`（正确），其余是我改漏的。

### 修复
```js
// OfficialSection
const __c1 = getCfg && getCfg();
const cur = (core.money && core.money.currency) || (__c1 && __c1.currency) || "CNY";

// TrendChart
const __c2 = getCfg && getCfg();
const cur = (__c2 && __c2.currency) || "CNY";

// WhaleSection（连 useCfgVersion 都缺）
useCfgVersion();
const __cw = getCfg && getCfg();
const cur = (core.money && core.money.currency) || (__cw && __cw.currency) || "CNY";
```

### 教训
**批量替换后必须验证「替换目标变量在作用域内存在」**，
不能只检查语法。这次的检查脚本：
```js
// 找出所有用了 cur 但所在函数没定义 cur 的
if (/\bmoney\([^)]{0,60}\bcur\b/.test(body) && !/(?:const|let|var)\s+cur\s*=/.test(body)) bad.push(fn);
```

## 7.17.2 —— 修复配额页 500 + 币种全局联动

### 1. 额度窗口 500（`learned is not defined`）
7.16.0 的 `limitOf` 用了 `learned` 变量，但声明没插进去：
```js
const learnedCaps = await loadLearnedCaps();
// ← 少了 const learned = learnedCaps.entries || {}
const limitOf = (provider, model) => {
  const lc = learned[provider + "|" + model];   // ❌ ReferenceError
```

这是我上次用超长锚点替换失败留下的半成品。

**修复**：补上 `const learned = (learnedCaps && learnedCaps.entries) || {};`

### 2. 币种只有多平台明细联动
**根因**：多个组件硬编码 `"CNY"`：
```js
money(officialNum, "CNY")   // 额度中心
money(totalCny, "CNY")      // 官方钱包
money(today, "CNY")         // 小鲸鱼区块
money(v, "CNY")             // 趋势图
```

**共 6 处硬编码**，改为读 `cur`（来自 `getCfg().currency`）。

#### 还补了 `useCfgVersion()`
`ProviderTable` / `OfficialSection` / `TrendChart` / `DetailSheetInner` 缺这个 hook，
即使读了币种，切换后也不会重渲染。

### 现在全部 13 个显示金额的组件都联动
```
✓ OfficialSection   ✓ UsageSection    ✓ WhaleSection
✓ Popover           ✓ ProviderTable   ✓ ModelTable
✓ BucketTable       ✓ DayTable        ✓ SessionTable
✓ TrendChart        ✓ RankList        ✓ DetailSheetInner
✓ UnifiedQuotaCard
```

## 7.17.0 —— P3-3 单元测试（46 个用例）+ 抓回丢失的严格匹配

### 单测立刻抓到一个真 bug
写 `cachehit.test.mjs` 时，`glm-5.3` vs `glm-5.3-flash` 的用例**失败了**。

**原因**：7.11.9 的严格匹配修复只在**安装目录**改过，源码目录仍是旧的前缀匹配。
后来 7.15.x 从 7.11.5 包回滚源码时，修复被覆盖掉了。

```js
// 源码里一直是：
if (!(ml === target || ml.indexOf(target) === 0 || target.indexOf(ml) === 0)) continue;
```

**这正是单元测试的价值**：没有测试，这个回归会一直潜伏。

### 测试框架
零依赖，`node test/all.mjs`：
```
test/runner.mjs        断言库（test/eq/ok/close/summary）
test/factor.test.mjs   倍率解析      11 用例
test/cap.test.mjs      限流四级判定  13 用例
test/config.test.mjs   配置规范化    12 用例
test/cachehit.test.mjs 模型名匹配    10 用例
test/all.mjs           汇总入口
```

`package.json` 加了 `"test": "node test/all.mjs"`。

### 覆盖的关键回归
| 用例 | 覆盖的 bug |
|---|---|
| `hy4free` → 0 | 7.6.2 free 识别 |
| `Spark X2.5` 不误判 | 7.6.2 正则边界 |
| `manualRate` 保留 | **7.15.1 白名单丢弃** |
| `glm-5.3` ≠ `glm-5.3-flash` | **7.11.9 严格匹配** |
| 业务码 14018/6004 | 7.3.0 四级判定 |
| 中文「均受限」| 7.3.0 中文模式 |
| 样本 <10000 跳过 | 反推最小样本 |

### 测试专用导出
`lib/index.js` 新增：
```js
export const __test__ = { parseJetHubCap, cacheHitRateByModel, realConsumption };
```
不影响运行时。

## 7.16.0 —— 容量学习：触发限流时自动记录该模型的上限

### 用户需求（澄清）
> 「比如该模型单个周期内上限 200M（本来不知道，上游决定的），
> 如果我用到这了，那么会触发报错任务中断，
> 然后这个时候本周期内我调用该模型用了多少量，就该更新为一个上限」

**核心**：渠道不告诉我们容量，但**触顶时的用量 ≈ 容量**。

### 实现

#### 1. 新增 `learned-caps.json`
```json
{ "entries": { "buddy|hy4flash-free": { "tokens": 1234567, "at": ..., "samples": 2, "lastSeen": 1300000 } } }
```

#### 2. `learnCapacity(provider, model, tokens)`
- 触发限流时调用
- **取最小值**：真实容量 ≤ 任何一次触顶时的用量
- 记录 `samples`（学了几次）和 `lastSeen`（最近一次触顶用量）

#### 3. `limitOf()` 优先级扩展
```
模型手填 > 渠道手填 > 学习到的容量 > 无上限
```
新增 `source: "learned"`，前端可标注「已学习」。

#### 4. 接入限流检测
`recordCapFromError` 里读取账本当日该模型用量，调用 `learnCapacity`。

### 效果
**第一次触顶后**，额度小条就有基准了：
```
之前：hy4flash-free  已用 0 tok  ·  上游限流  ·  等待解禁
之后：hy4flash-free  已用 1.2M / 1.2M tok  ·  已触顶  ·  0%
```
下个周期再看到这个模型，就能直观知道「还剩多少」。

### 局限
- 只在**触顶时**学习，没触顶前仍显示 `—`
- 周期口径按「今日」估算（多数渠道按日重置；若实际是 5 小时窗口，数值会偏小）
- 学到的值是**下限**（真实容量可能略大），保守估计更安全

## 7.15.1 —— 修复 ∞ 残留 + manualRate 被丢弃

### 1. ∞ 符号仍在（3 处漏改）
| 位置 | 之前 | 现在 |
|---|---|---|
| 小条弹层「今日已用」| `X / ∞ tok` | `X tok` |
| QuotaView `usedText` | `已用 X / ∞ tok` | `已用 X tok` |
| QuotaView `leftText` | `∞` | `—` |

**语义**：没有软上限时，不应该显示「/ ∞」或「∞」——那是无信息的噪音。

### 2. 手动汇率填了没反应
**根因**：`normalizeConfig` 是**白名单模式**：
```js
const out = { ...d };
out.currency = pick(...);
out.exchangeRate = clamp(...);
out.decimals = ...;
// ← manualRate 不在这里 ⇒ 被丢弃
```
前端填了值 → `patch` 合并 → `normalizeConfig` 白名单过滤 → **manualRate 消失** → 界面读回空值。

**修复**：
```js
const mr = Number(src.manualRate);
out.manualRate = Number.isFinite(mr) && mr > 0 ? Math.min(1000, Math.max(0, mr)) : 0;
```

### 教训
**每次新增配置字段，必须同时改 `normalizeConfig`**，
否则前端能写、后端会丢，表现为「填了没反应」。

## 7.15.0 —— P2-3 汇率手动覆盖 + 修复「触顶+∞」语义矛盾

### P2-3 汇率手动覆盖
**问题**：ECB 周末/节假日不发布新价，只能沿用旧价（如 11-16 的数据用到 11-17）。

**实现**：
- 新增配置 `manualRate`（0 = 用自动抓取）
- `rateFor()` 优先返回 `manualRate`
- 设置页「金额与币种」组新增「手动指定汇率」输入框：
  - 填值 → 覆盖自动抓取，右侧出现 `↺` 按钮恢复自动
  - 空值 → 显示「（自动）」

### 修复「已触顶 + ∞ tok」语义矛盾
**现象**（用户截图）：
```
hy4flash-free  ·  已用 0 / ∞ tok  ·  已触顶  ·  0% · 剩 0
```
上限是 `∞`（没设软上限），却显示「已触顶」和「0%」，语义矛盾。

**根因**：`isCapped` 同时覆盖了「软上限触顶」和「上游限流」两种情况，
但显示逻辑假定一定有软上限。

**修复**：
| 情况 | 之前 | 现在 |
|---|---|---|
| 有软上限 + 触顶 | 「已触顶」+ 0% | 「已触顶」+ 0%（不变）|
| **无软上限 + 上游限流** | 「已触顶」+ 0% + ∞ | **「上游限流」+「等待解禁」** |
| 无软上限 + 正常 | `∞ tok` | `已用 N tok`（不再显示无意义的 ∞）|

## 7.14.1 —— 修复设置页空白（Hooks 规则违反）

### 事故
7.14.0 后设置页**完全空白**。

### 根因
`CollapsibleGroup` 内部用了 `react.useState`，但调用方式是**直接函数调用**：
```js
CollapsibleGroup({ id: "money", ... }, child1, child2)   // ❌ 不是 React 组件
// 内部：react.useState(...)  → Hook 被绑定到父组件的 hook 链 → 顺序错乱
```

**React Hooks 只能在组件渲染过程中调用。** 直接调用函数时，
`useState` 会计入父组件 `SettingsSection` 的 hook 数量，
但 7 个分组各调用一次 ⇒ hook 数量在渲染间变化 ⇒ **React 抛错，整个设置页白屏**。

### 修复
改为标准 React 组件调用：
```js
h(CollapsibleGroup, { id: "money", ... }, child1, child2, ...)
// 组件内改用 props.children（React 自动填充）
```

### 教训
**任何含 Hook 的函数都必须是 React 组件**，用 `h(Comp, props, ...children)` 调用。
直接 `Comp(props)` 调用只在「无 Hook」时安全。

## 7.14.0 —— P2-2 设置分组折叠（方案 A）

### 用户选择：方案 A（分组折叠）

### 实现
新增 `CollapsibleGroup` 组件：
```js
function CollapsibleGroup(props, ...children) { ... }
```
- 点击标题展开/收起
- 折叠状态存在 `localStorage` 的 `uq-set-collapsed`，跨会话保留
- 箭头旋转 90° 指示状态
- 键盘可操作（Enter / Space）

### 7 个分组全部转换
| id | 标题 | 默认 |
|---|---|---|
| money | 金额与币种 | 展开 |
| creditPrice | 积分单价 · 套餐性价比 | **折叠** |
| cacheHit | 假定缓存命中率 | **折叠** |
| pricing | 计价方式 | **折叠** |
| visibility | 显示内容 | 展开 |
| detail | 明细页 | 展开 |
| softLimits | 每日软上限 | **折叠** |

**默认折叠的是「配置一次就不动」的高级项**，常用项保持展开。

### 顺带清理
`caps.json` 里那条错误记录（`deepseek-account|deepseek-v4.1-flash`，reason 却是 `buddy:`）
已合并到正确的 `buddy|deepseek-v4.1-flash`。

这是 `PROVIDER_ALIAS` 未定义时代的遗留数据，7.13.0 已修根因。

## 7.13.1 —— 修复插件加载失败（async 被拆开）

### 事故
7.13.0 安装后插件**完全消失**（连入口都没有）。

**根因**：插入 `PROVIDER_ALIAS` 时锚点选错，把 `async` 和 `function` 拆开了：
```js
async /** 渠道显示名/别名 → 内部 provider id */
const PROVIDER_ALIAS = { ... };

async function recordCapFromError(error, hint) {   // ← async 被孤立
```

**效果**：`async` 变成一条独立表达式 ⇒ `ReferenceError: async is not defined`
⇒ **整个 ESM 模块加载失败** ⇒ 插件不注册 ⇒ 全部消失。

### 关键教训
**`node --check` 检不出这类错误！**
```
index.js 语法 ✓        ← --check 通过
import ✗ async is not defined   ← 实际加载失败
```

因为 `async` 作为标识符是**语法合法**的，只有运行时才报错。

### 新增强制检查
以后每次打包前必须做双重验证：
1. `node --check`（语法）
2. **动态 `import()`（运行时加载）** ← 新增，能抓住 ReferenceError

### 修复
把 `async` 和 `function` 重新连起来。

## 7.13.0 —— P2-1 渠道健康页 + 修复两个隐藏的 ReferenceError

### 修了两个「函数不存在」的 bug

#### 1. `appendCapKnowledge` 只有调用没有定义
```js
try { await appendCapKnowledge(provider, model, untilMs, reason); } catch (e) {}
//                 ↑ 从未定义 ⇒ 静默失败 ⇒ cap-knowledge.jsonl 从未生成
```
**修复**：补上完整实现（含 kind 推断、512KB 自动截断）。

#### 2. `PROVIDER_ALIAS` / `KNOWN_PROVIDERS` 只有引用没有定义
```js
const mapped = PROVIDER_ALIAS[head] || head;   // ❌ ReferenceError
if (KNOWN_PROVIDERS.has(mapped)) provider = mapped;
```
**后果**：`buddy: 模型 ...` 这样的报文，`headMatch` 正确提取到 `buddy`，
但 `PROVIDER_ALIAS` 未定义 ⇒ 抛错 ⇒ 被 catch 吞掉 ⇒ provider 保持 `hint.provider`（`deepseek-account`）。

**这就是之前 caps.json 里 `deepseek-account|deepseek-v4.1-flash` 的 reason 写着 `buddy:` 的原因。**

**修复**：补上 12 个渠道的别名表和 12 个白名单。

### 新增 P2-1 渠道健康页

**后端** `GET /api/unified-quota/channel-health`：
```json
{
  "active": [{"provider":"buddy","model":"hy4flash-free","until":...,"active":true,"reason":"..."}],
  "history": [...],
  "byProvider": {"buddy": {"count":3,"lastAt":...,"withUntil":2,"kinds":{...},"models":{...}}}
}
```

**前端** 明细面板新增「渠道健康」页签：
- **冷却中**：每条显示渠道/模型/剩余时间/解除时刻（红色高亮）
- **历史统计**：按渠道汇总次数、含解禁时间比例、最近一次、限流类型
- 30 秒自动刷新

### 数据来源
`storages/unified-quota/cap-knowledge.jsonl`（限流事件永久累积）
+ `caps.json`（当前生效的冷却）

## 7.12.6 —— 找到真凶：`c is not defined`

### 红字错误（用户截图）
```
渲染出错：
ReferenceError: c is not defined
```

### 根因
7.10.1 给 `ProviderTable` 加模型级命中率徽标时，插入的代码用了 `c`：
```js
// ProviderTable 里，models.map(function (m) { ... }) 的回调
(function () { const mh = c.modelCacheHit && c.modelCacheHit[m.model]; ... })()
//                    ↑ c 不存在，这里应该是 r（渠道行）
```

**`c` 只存在于 `CreditBillView` 的 `chans.map(function (c)` 作用域。**
`ProviderTable` 里用的是 `r`（rows.map(function (r)）。

### 为什么表现为「面板消失」
点击渠道行 → `setOpenRow` → `ProviderTable` 重渲染 → 展开行执行到 `c.modelCacheHit` → **ReferenceError** →
React 卸载整个子树 → 面板消失。

7.12.5 加的错误边界捕获到了，才显示出这条红字 —— **终于看到真正的错误了**。

### 修复
```js
const mh = r.modelCacheHit && r.modelCacheHit[m.model];   // c → r
```

### 教训
这个 bug 从 7.10.1 就存在（当时加模型徽标），但因为没有错误边界，
表现是「面板消失」，看起来像 DOM/事件问题，导致排查了 10+ 轮。

**错误边界 + 红字显示是这次能定位的关键。**

## 7.12.5 —— 坐标探针结果：事件正确，是渲染期崩溃

### 坐标探针给出了决定性答案
```
14:46:03.650  dlg-down       tag=TD cls=num pt=554,519 el=429,501 144x31
14:46:03.783  sheet-unmount  panelOpen=true
```

**`tag=TD` 说明事件正确到达表格单元格**（不是误触关闭按钮），
`pt=554,519` 也落在 `el=429,501 144x31` 范围内（429~573, 501~532）。

**所以：不是坐标错位、不是误触，是点击后的渲染过程崩溃。**

### 关键发现：ProviderTable 没有错误边界
```js
tab === "provider" ? h("div", null, h(ProviderTable, {...}))   // ❌ 裸渲染
```
点击渠道行 → `setOpenRow` → `ProviderTable` 重渲染 → 若抛异常，
整个 `DetailSheetInner` 被 React 卸载（异常往上冒到没有边界的地方）。

**这完全解释了**：`panelOpen=true` 但面板消失，且没有 `entry-sheet-close`。

### 修复
1. **`body` 整体包进 `UqErrorBoundary`**
2. **`UqErrorBoundary.componentDidCatch` 加 beacon**，记录：
   - 错误消息
   - 6 层调用栈
   - React componentStack（哪个组件崩的）
3. 加 `row-click` 与 `pt-render` 探针，确认点击后的渲染路径

### 预期
重启后点渠道行，面板**不再消失**，而是：
- 正常展开/收起（如果崩溃已修复）
- 或显示红色错误信息（如果仍有其他崩溃点）

## 7.12.4 —— 坐标探针：定位「点表格却触发关闭按钮」

### 已知事实
- 面板点了数据格就消失
- beacon 记录 `sheet-close-call target=uq-winbtn uq-winbtn-close`
- **但你点的是表格的「积分当量」单元格**

⇒ 事件目标与视觉位置不一致。可能原因：
1. 点击瞬间 DOM 被替换（slot 重建）
2. CSS `transform` 造成坐标偏移
3. 面板位置在点击瞬间变化

### 本次加的探针
在 `.uq-dlg` 上监听 `mousedown` 捕获阶段，记录：
```js
beacon("dlg-down", "tag=<标签> cls=<class> pt=<鼠标x,y> el=<元素left,top 宽x高>")
```

重启后点一次数据格，日志会显示：
- `pt=` 鼠标实际坐标
- `el=` 事件目标的矩形位置
- `tag=`/`cls=` 事件目标是什么

**如果 pt 落在 el 内但 tag 是 close 按钮** ⇒ DOM 替换导致
**如果 pt 不在 el 内** ⇒ 坐标偏移
**如果 dlg-down 的 tag 是 td** ⇒ 事件正常，关闭来自别处

### 同时验证
若 `dlg-down` 出现多次（同一坐标不同 tag），说明 DOM 在点击瞬间被替换。

## 7.12.3 —— 联动筛选改用全量交集映射

### 用户反馈
> 「点某个渠道下某个模型后，想再选择别的模型（如果该渠道有多个），
> 需要点筛选点全部模型才重新出现」

### 根因
`det.models` 和 `det.providers` 是**被当前筛选裁剪过的**：
```
筛选 qodercn 后：
  models 总数: 3     ← 只剩 qodercn 的
  providers 总数: 1  ← 只剩 qodercn
```
前端用这两个数组构建 `modelToProvs` / `provToModels`，
=> 交集映射也是裁剪后的 => 联动失效。

### 修复：后端提供全量映射
在过滤**之前**收集全量交集：
```js
// 先记录，再判断 keep
(allModelToProvs[model] = allModelToProvs[model] || new Set()).add(provider);
(allProvToModels[provider] = allProvToModels[provider] || new Set()).add(model);
if (!keep(provider, model)) continue;
```

`/detail` 的 `options` 新增：
```json
{
  "providers": [...], "models": [...],
  "modelToProvs": { "glm-5.3-flash": ["codearts","trae"] },
  "provToModels": { "buddy": ["deepseek-v4.1-flash", "hy4free", "glm-5.3", ...] }
}
```

### 验证
筛选 `qodercn` 时：
```
options.providers: 7（全量，未被裁剪）
options.models: 14（全量）
modelToProvs: 14 个键（全量）
glm-5.3-flash 的渠道: ["codearts","trae"]   ← 不受筛选影响
```

前端改用 `options.modelToProvs` / `options.provToModels`，联动恢复正常。

## 7.12.2 —— 渠道/模型双向联动筛选

### 用户需求
> 「选择渠道后，模型筛选本应该只出现该渠道拥有的模型，而不是所有模型」
> 「选择某个模型（比如千问的），那么渠道筛选下就应该只有有这个模型的渠道」

### 原实现的问题
```js
// 选渠道：清空模型
onChange: e => { setFProvider(e.target.value); setFModel(""); }
// 选模型：清空渠道
onChange: e => { setFModel(e.target.value); setFProvider(""); }
```
两个下拉**互相清空**，且选项列表是**全量**的，无法组合筛选。

### 新实现：基于交集的双向联动
数据源（后端已有）：
- `det.models[].providers` —— 每个模型出现在哪些渠道
- `det.providers[].models` —— 每个渠道有哪些模型

```js
const provsShown = fModel ? providers.filter(p => modelToProvs[fModel].has(p)) : providers;
const modelsShown = fProvider ? models.filter(m => provToModels[fProvider].has(m)) : models;
```

**交互逻辑**：
- 选渠道 → 模型下拉只剩该渠道的模型；若当前模型不属于该渠道，自动清空
- 选模型 → 渠道下拉只剩有该模型的渠道；若当前渠道没有该模型，自动清空

### 数据验证
| 选择 | 联动结果 |
|---|---|
| qodercn | 只剩 qfmodel, qmodel, dfmodel |
| glm-5.3 | 只剩 buddy |
| glm-5.3-flash | 只剩 trae, codearts |
| qoder 独有模型 | qfmodel, qmodel, dfmodel |

**这也从数据上印证**：`glm-5.3` 与 `glm-5.3-flash` 是不同模型（渠道完全不重叠）。

## 7.12.1 —— 回滚 7.12.0（更糟），回到 7.11.5 基线

### 7.12.0 的问题
尝试用 body 下单例 root + display 控制显隐：
- 点数据格**仍然消失**
- **切换会话后不再出现**（比之前更糟）

原因推测：单例 root 与风件 React 树分离，状态更新不触发重渲染，
面板渲染一次后就不再响应 `__uqPanelOpen` 变化。

### 回滚
从 `dsh-unified-quota-7.11.5.tgz` 解包恢复 `client.js` / `index.js` / `package.json`，
基线与 7.11.5 完全一致（2465 行）。

### 仅保留一个安全改动：筛选逻辑
```js
// 原：选模型时清空渠道 ⇒ 无法筛「某渠道下的某模型」
const pickModel = row => { setFModel(row.model); setFProvider(""); };

// 新：保留渠道
const pickModel = row => { setFModel(row.model); };  // 不动 provider
```

### 面板消失问题的现状
**已确认根因**：DSH slot 每 ~700ms 重建组件（beacon: entry-mount 65 次 / sheet-mount 303 次），
slot 内的 portal 跟着销毁重建，用户点击瞬间赶上 DOM 替换 ⇒ 事件目标错位（日志显示落到关闭按钮）。

**已尝试且失败的方案**：
1. 7.11.3 模块级状态 → 状态保住但 DOM 仍被替换
2. 7.11.6 组件内 createRoot → 多窗口
3. 7.12.0 模块级 createRoot + display → 状态不更新，更糟

**下一步**：等 7.12.1 验证基线恢复后，再研究 DSH slot 的重建触发条件，
或许可以从「阻止 slot 重建」而非「绕过重建」入手。

## 7.12.0 —— 面板走 body 单例 root（显示/隐藏不卸载）+ 筛选修复

### 1. 筛选逻辑 bug（用户指出）
```js
const pickModel = row => { setFModel(row.model); setFProvider(""); ... };  // ❌ 清空了渠道
```
选模型时把渠道筛选清空了 ⇒ 只能看「全渠道」，无法「某渠道下的某模型」。

**修复**：
- `pickModel` **保留**渠道筛选
- `pickProvider` 切渠道时**才**清空模型（避免无效组合）

### 2. 面板消失：根因是 portal + slot 重建
```js
open ? mountPop(h(...)) : null   // createPortal 到 body
```
slot 每 ~700ms 重建 ⇒ 组件卸载 ⇒ **portal 被销毁重建** ⇒ DOM 节点被移除再插入。
用户点击的瞬间恰好碰上 DOM 替换 ⇒ 事件目标错位（日志显示落到 `uq-winbtn-close`）。

### 3. 修复：body 下单例 root + display 控制
```js
let __uqPanelHost = null, __uqPanelRoot = null;   // 模块级单例
function __uqRenderPanel(open, ...) {
  __uqEnsurePanelHost();                            // 只创建一次
  __uqPanelRoot.render(h("div", { style: open ? null : { display: "none" } }, ...));
}
```

**关键差异**（对比 7.11.6 失败方案）：
- host 存在**模块级变量**，不是组件内变量 ⇒ slot 重建不会重复创建
- 用 `display: none` 隐藏而非 `unmount` ⇒ 关闭/再开不重建 DOM
- 面板 DOM 从创建后**永不卸载** ⇒ 点击时不会碰上替换

### 4. 模型命名（用户建议）
确认 `api-models.json` 的 `id` 是**官方模型 ID**（603 个，578 唯一），
`glm-5.3` 与 `glm-5.3-flash` 是**两个独立条目**。

同一 id 有多个倍率（跨渠道）：
```
glm-5.3: x0.69 / x0.78 / x0.79
deepseek-v4.1-flash: x0.11 / x0.12→x0.06 / x0.18
```
⇒ 倍率是「渠道+模型」维度，不是模型本身。

## 7.11.9 —— 模型名严格匹配（glm-5.3 ≠ glm-5.3-flash）

### 用户纠正
> 「glm5.3 和 5.3flash 是不同的模型，不是命名问题」

**之前判断错了。** 原匹配逻辑：
```js
if (!(ml === target || ml.indexOf(target) === 0 || target.indexOf(ml) === 0)) continue;
```
`glm-5.3` 是 `glm-5.3-flash` 的前缀 ⇒ 两者被合并 ⇒ 命中率互相污染。

### 修复：严格匹配
只允许三种情况：
1. **完全相同**
2. **版本/日期后缀**：`-1017`、`-0813`、`-v1`、`-20260101`
3. **`_` 与 `.` 等价**：`deepseek-v4_1` ≡ `deepseek-v4.1`

```js
const VERSION_SUFFIX = /^[-.](v?\d{2,}|\d{4}-?\d{2}-?\d{2})$/;
```

### 验证（9/9 通过）
| A | B | 结果 |
|---|---|---|
| glm-5.3 | glm-5.3-flash | **不匹配** ✓ |
| deepseek-v4.1-flash | deepseek-v4.1-flash-1017 | 匹配（版本后缀）✓ |
| deepseek-v4_1-flash | deepseek-v4.1-flash | 匹配（_ ≡ .）✓ |
| qmodel | qfmodel | 不匹配 ✓ |

### 模型别名库评估（用户提出）
**结论：不可行，需人工维护。**

查证：
- `aile.sh/models/<provider>/<model>` 有模型定价，但**只覆盖它自己的 P2P 供应商**
- 各渠道（buddy/trae/qoder）**不公开模型映射**
- `qmodel`/`dfmodel`/`qfmodel` 是 qoder 内部代号，实际对应模型未知

实测到的 qoder 内部代号定价（可作参考）：
| 代号 | 输入 | 输出 | 缓存读 |
|---|---|---|---|
| qmodel | $0.400/M | $1.60/M | $0.080/M |
| dfmodel | $0.300/M | $1.20/M | $0.006/M |
| qfmodel | $0.150/M | $0.470/M | $0.016/M |

**建议**：做成「可编辑的别名表」（设置页），用户手动配置同义模型。

## 7.11.8 —— 面板 UI 状态提升到模块级

### 毫秒级日志揭示真相
```
12:54:48.704  entry-unmount  id=e4o6hro
12:54:48.718  entry-mount    id=e4e9jzi   ← 14 毫秒内重建
12:54:49.418  entry-unmount  id=e4e9jzi
12:54:49.433  entry-mount    id=ellpghx   ← 15 毫秒内又重建
```

**统计**：
- `entry-mount` 65 次 / `entry-unmount` 57 次
- `sheet-mount` **303 次** / `sheet-unmount` 49 次

**DSH slot 每 ~700ms 重建一次入口组件。**
面板挂在 slot 内 ⇒ 跟着重建 ⇒ 你点击时 DOM 正在被替换，
事件落到「鼠标位置恰好的元素」（本次是关闭按钮）⇒ 面板关闭。

### 7.11.6 为什么失败
把面板挂到独立 `createRoot` 思路正确，但：
- 每次 slot 重建都新建 host，**旧 host 没清理** ⇒ 多窗口
- 关闭按钮关掉新实例，旧实例还在 ⇒ 关不掉

### 7.11.8 方案：状态提升（不是脱离 DOM）
```js
const __uqPanelUI = { mins: false, maxed: false, pos: null, box: null, tab: "provider", win: 30, basis: "api" };
const [mins, setMins0] = react.useState(__uqPanelUI.mins);
const setMins = react.useCallback(v => { __uqPanelUI.mins = v; setMins0(v); }, []);
```

slot 重建后组件从模块级读回 `mins`/`maxed`，**恢复原样**而不是"消失/重置"。

### 关于「glm-5.3 记到 trae」的澄清
账本**没有记错**：
- `trae:glm-5.3-flash` 86M = **11/1 ~ 11/13 的历史累积**
- `buddy:glm-5.3` 4M = **今天你用的**

两个模型名不同（`glm-5.3-flash` vs `glm-5.3`），但命中率反推已正确合并（都是 25.5%）。

## 7.11.7 —— 回滚独立 root（引入多窗口）+ 修轮询依赖

### 1. 回滚 7.11.6 的独立 createRoot
7.11.6 把面板挂到 body 下的独立 root，结果：
- **出现多个窗口**（每次 slot 重建都新建 host，旧 host 没清干净）
- **关闭按钮失效**（关掉的是新实例，旧实例还在）

已回滚到 slot 内渲染（7.11.5 的行为）。

### 2. 积分不变的真正原因：轮询 effect 依赖 data
```js
}, [pick, load, data && data.capped]);   // ❌ data 在依赖里
```
每次 `setData(j)` 都会改变 `data` ⇒ 这个 effect 重新执行 ⇒ **清理定时器 + 重新计时**。
再叠加 DSH slot 每 1-2 秒重建组件（`data` 重置为 null 又触发一次），
定时器几乎永远走不到 8 秒触发点 ⇒ **轮询实际没在跑**。

**修复**：
```js
}, [pick, load]);   // capped 通过 dataRef.current 读取（已经是 ref，不需要进依赖）
```

### 日志佐证
```
12:49:09 ~ 12:50:05  mini-current 每 8 秒一次   ← 7.11.5 的 ref 修复让轮询恢复了
今日 trae: spent=523.92 granted=100               ← 数据本身正确
```
轮询恢复后数据是对的，但 `data` 依赖导致定时器被反复重置，实际刷新率远低于 8 秒。

## 7.11.6 —— 面板脱离 slot 生命周期（独立 createRoot）

### 用户的洞察是决定性的
> 「是不是并没有关闭，而是最小化的问题」
> 「用最小化按钮，切换会话后窗口再次出现」

**完全正确。** 这就是「组件被重建」的典型表现，不是关闭。

### 日志数据
```
entry-mount 总数: 41
apply      总数: 19
```

**entry-mount(41) 远多于 apply(19)** ⇒ 不是插件重载，是 **DSH 的 slot 每 1-2 秒重建组件**。

重建时：
```
12:39:30  entry-unmount  id=ek2582t
12:39:30  sheet-unmount  id=sfvjlc panelOpen=true   ← 状态说"该开着"
12:39:30  entry-mount    id=egaff7h                ← 新实例
12:39:30  sheet-mounted  ok                        ← 面板重新挂载
12:39:31  entry-unmount  id=egaff7h                ← 1 秒后又重建
```

面板渲染在 slot 组件树内 ⇒ 每次重建都卸载+重挂 ⇒ 视觉上「闪一下就没了」。

### 修复：独立 createRoot
```js
// 面板不再渲染在 slot 组件内
const host = document.createElement("div");
document.body.appendChild(host);
const root = rd.createRoot(host);
root.render(api.createElement(DetailSheet, { ... }));
```

**面板现在挂载在 body 下，slot 怎么重建都不影响它。**

模块级 `__uqPanelOpen` + 订阅机制负责同步开关状态。

## 7.11.5 —— 小条积分不更新（闭包冻结）+ onClose 来源追踪增强

### 1. 小条积分停留在旧值（44 分，实际 477）
**根因**：轮询闭包冻结
```js
react.useEffect(function () {
  const tick = function () {
    void load(pick).finally(...)   // ❌ pick 是首次渲染的闭包值，永不更新
  };
  timer = setTimeout(tick, 15000);
}, []);                             // ❌ 依赖空数组
```
组件重建（DSH slot 每 2 秒重建，见 7.11.3 日志）后 `pick` 变了，
但轮询里的 `load(pick)` 永远用旧值 ⇒ 一直显示旧模型/旧渠道的积分。

**修复**：
```js
const pickRef = react.useRef(pick); pickRef.current = pick;
const dataRef = react.useRef(data); dataRef.current = data;
// tick 里读 pickRef.current / dataRef.current
```

**同时**：轮询间隔 15s → **8s**（积分变化更及时）。

### 2. onClose 来源追踪增强
日志显示 `why=[object Object]` ⇒ `onClose` 被以 **React 事件对象**为参数调用，
即某个 `onClick: onClose` 直接绑定。

**增强追踪**：记录事件的 `type` / `target.className` / `currentTarget.className` + 7 层调用栈，
下次日志能直接看出是哪个元素触发的。

### 备注
buddy 余额样本确认正常：
```
12:33:05  total=3169.75
12:34:06  total=2959.73
```
数据采集没问题，是小条读到了旧闭包值。

## 7.11.4 —— onClose 被「幽灵」调用：加调用栈追踪 + 修 Escape 依赖

### 新证据（用户切换会话测试）
用户发现：点 80.93 面板消失 → **切换会话后面板又出现** → 再点又消失。
这说明 7.11.3 的模块级状态生效（切换会话触发重渲染时组件按 open=true 重新渲染面板），
但**面板渲染出来后 1 秒内被某种东西调用了 onClose**。

### 日志铁证
```
12:20:51  entry-click       open=false
12:20:51  sheet-mount       id=sz2p3s
12:20:51  entry-open        open=true
12:20:52  entry-sheet-close open=true    ← onClose 被调用了！
12:20:52  sheet-unmount     panelOpen=false
```

### 找到的第一个真 bug：Escape 监听的依赖错误
```js
// 原代码
react.useEffect(function () {
  const onKey = function (e) { if (e.key === "Escape") onClose(); };
  document.addEventListener("keydown", onKey);
  return function () { document.removeEventListener("keydown", onKey); };
}, [onClose]);   // ❌ 内联 onClose 每次渲染都是新引用
```
每次渲染都解绑+重绑，且闭包持有过期 state。改为 ref + []，只绑一次。

### 本次加的探针
```js
beacon("sheet-close-call", "why=... stack=...")   // onClose 调用栈（谁调的它）
beacon("sheet-escape", "key=...")                 // Escape 键记录
beacon("pick-provider", "trae")                   // 点击表格渠道行
beacon("pick-model", "deepseek-...")              // 点击表格模型行
```

### 持久化探针永久保留（用户确认）
三层诊断体系（beacon / UQ_DEBUG / UqErrorBoundary）已写入 docs/NEXT-PLAN.md。

## 7.11.3 —— open 状态提升到模块级（DSH slot 会重建组件）

### 实例追踪日志（决定性）
```
12:10:44  entry-mount  id=e3vdi3a
12:10:44  entry-open   id=e5bm7pk open=false
12:12:37  apply        keys=fiber          ← 插件重新 apply
12:12:39  entry-mount  id=esk6w0n
12:12:46  entry-click  open=false
12:12:46  sheet-mount  id=sh4k8z
12:12:46  entry-open   id=esk6w0n open=true
12:13:13  sheet-unmount id=sh4k8z
```

**entry-mount 出现 3 次，实例 ID 各不相同**（e3vdi3a / e5bm7pk / esk6w0n），
**entry-unmount 0 次** ⇒ DSH 的 slot 系统在**替换组件实例**，且不走 React cleanup。

`open` 是组件内 `useState` ⇒ **每次重建都重置为 false** ⇒ 面板消失、再点无效。

### 修复：状态提升到模块级
```js
let __uqPanelOpen = false;
const __uqPanelSubs = new Set();
function __uqSetPanelOpen(v) { ...通知所有订阅者... }

// window 级钩子只注册一次
window.addEventListener("unified-quota:open",  () => __uqSetPanelOpen(true));
window.addEventListener("unified-quota:close", () => __uqSetPanelOpen(false));
```

组件内：
```js
const [open, setOpen] = react.useState(__uqPanelOpen);   // 初值取自模块级
react.useEffect(() => { setOpen(__uqPanelOpen); ...订阅... }, []);
```

这样即使组件被重建 N 次，`open` 状态依然保留。

### 附带
`sheet-unmount` 探针现在记录 `panelOpen=` 模块级状态，用于区分「用户关闭」和「被重建」。

## 7.11.2 —— 面板 2 秒后被卸载：加实例 ID 追踪

### 最新 beacon 日志（重启后点击）
```
12:08:18  entry-click   open=false
12:08:18  sheet-mount   L=zh          ← 3 次！
12:08:18  sheet-mounted ok
12:08:18  sheet-mount   L=zh
12:08:18  sheet-mount   L=zh
12:08:20  sheet-unmount bye           ← 2 秒后卸载
```

**关键**：**没有 `entry-sheet-close`** ⇒ `onClose` 没被调用 ⇒ 不是用户关闭，
而是 React 层面父组件重渲染导致 `open` 变回 false（或组件树重建）。

`sheet-mount` 出现 3 次 ⇒ **3 个独立实例**（`useEffect` 依赖 `[]`，重复渲染不会重复执行）。

### 本次加的探针
```js
beacon("entry-mount",  "id=eXXXXXX")            // 入口实例挂载
beacon("entry-open",   "id=eXXXXXX open=true")  // open 状态每次变化
beacon("entry-unmount","id=eXXXXXX")            // 入口实例卸载
beacon("sheet-mount",  "id=sXXXXX L=zh")        // 面板挂载（带实例 ID）
beacon("sheet-unmount","id=sXXXXX")             // 面板卸载（带 ID）
```

重启后点一次，就能看出：
- 有几个入口实例（id 不同）
- `open` 何时从 true 变 false
- 哪个 sheet 实例被卸载

## 7.11.1 —— 入口点不开的真因：组件被注册了两次

### beacon 日志的铁证
```
11:47:46  entry-click   open=false    ← 第一次点，打开了
11:47:46  sheet-mount   L=zh          ← 挂载 3 次（多个实例）
11:47:46  sheet-mounted ok
11:48:07  sheet-unmount bye           ← 21 秒后被卸载
11:51:17  entry-click   open=true     ← 再点，open 已经是 true
11:51:18  entry-click   open=true     ← 点了 3 次全是 true ⇒ setOpen(true) 无效
11:51:19  entry-click   open=true
```

### 根因
`DetailEntryButton` 被**注册到两个地方**：
1. `conversation.session.header.actions` slot（`slots.register`）
2. `mountFallback` → `react.createElement(DetailEntryButton, { standalone: true })` + `createRoot`

**两个实例各自有独立的 `open` state。**
点击其中任何一个，只有它自己的 `open` 变成 true；
但用户看到的面板由**另一个实例**渲染（它的 `open` 仍是 false）⇒ 面板不出现。
再点击时，被点的实例 `open` 已经是 true ⇒ `setOpen(true)` 是空操作 ⇒ 彻底点不开。

这解释了 `sheet-mount` 出现 3 次（多个实例交替），以及 `open=true` 却看不到面板。

### 修复
用 window 事件同步所有实例的 `open`：
```js
// 点击时广播（带 from 标识避免自触发）
window.dispatchEvent(new CustomEvent("unified-quota:open", { detail: { from: selfId } }))
// 所有实例监听
window.addEventListener("unified-quota:open", ev => { if (ev.detail.from !== selfId) setOpen(true); })
// 关闭时广播，所有实例一起关
window.dispatchEvent(new CustomEvent("unified-quota:close"))
```

### 为什么前几轮都没找到
- 接口 200 → 不是数据问题
- 错误边界没抓到 → 不是渲染崩溃
- `pointer-events` → 7.10.4 修的是另一个问题（真实存在但非本次根因）
- **beacon 持久化** → 第一次拿到完整操作序列，才看到 `open=true` 与 `sheet-unmount` 并存

**用户建议的「全局持久化探针」直接解决了这次排查。**

## 7.11.0 —— 全局持久化探针 + 面板不显示的真因线索

### beacon 日志的关键发现（用户操作后读取内存日志）
```
11:40:05  entry-click   standalone=false open=false
（之后无任何 entry-sheet-close）
```

**结论**：
1. 点击**到达了按钮**，`setOpen(true)` 执行了
2. **没有** `entry-sheet-close` ⇒ 面板**没有被关闭**
3. 但面板确实不显示 ⇒ **`open=true` 时 `DetailSheet` 渲染失败或渲染为空白**

所以问题不是「被关闭」，而是「渲染不出来」。前几轮的方向（事件冒泡、pointer-events）虽然有价值，但不是这次的根因。

### 1. beacon 持久化（用户建议）
之前 beacon 只存在内存数组（60 条），**重启即丢失**，无法回溯。
现在每次 beacon 同时追加到：
```
storages/unified-quota/beacons.jsonl
```
- 超过 512KB 自动截断到最近 1000 行
- 内存仍保留最近 200 条供快速查询

### 2. 新增 `/api/unified-quota/beacon-log?n=100`
直接读磁盘日志，重启后也能查：
```json
{"ok":true,"total":1234,"items":[{"at":...,"stage":"entry-click","detail":"open=false"}]}
```

### 3. DetailSheet 挂载探针
```js
beacon("sheet-mount", "L=" + L)      // 函数体执行
beacon("sheet-mounted", "ok")        // useEffect 挂载成功
beacon("sheet-unmount", "bye")       // 卸载
```
重启后再点入口，日志会明确告诉我们：
- 只有 `entry-click` → DetailSheet **连函数体都没进**（渲染被拦截）
- 有 `sheet-mount` 无 `sheet-mounted` → 挂载中崩溃
- 有 `sheet-mounted` 后立刻 `sheet-unmount` → 被卸载

## 7.10.5 —— 入口点不开：加点击/关闭诊断

### 现象（用户反馈）
点「积分当量」的数字后面板关闭，**入口按钮还在但再也点不开**。
积分账单 / 额度窗口两个页签都正常。

### 已排除
- 接口 500：全部 200
- 渲染异常：错误边界未捕获
- `.uq-anchor` 的 `pointer-events`：7.10.4 已加 `.uq-anchor>*{pointer-events:auto}`

### 本次诊断
在入口按钮的 `onClick` 和 `DetailSheet` 的 `onClose` 各加一个 `beacon`：
```js
onClick: e => { e.stopPropagation(); beacon("entry-click", "open=" + open); ... }
onClose: () => { beacon("entry-sheet-close", "open=" + open); setOpen(false); }
```

重启后再点一次，就能从 `/api/unified-quota/beacon` 日志看到：
1. 点击**有没有触发**（若无 entry-click，说明按钮被遮挡或事件没到）
2. 关闭**是谁触发的**（若有 entry-sheet-close，说明面板打开后立即被 onClose）
3. `open` 状态在那一刻的值

### 附带
入口按钮的 onClick 加了 `e.stopPropagation()`，防止点击冒泡到宿主。

## 7.10.4 —— 面板消失的真正根因：CSS pointer-events 继承

### 现象
点击明细面板里「积分当量」的蓝色数字（或排行里的任意行），**整个面板消失**，连入口也不见了。
设置页正常、接口全部返回 200、错误边界也没抓到异常 —— 说明**不是崩溃，是面板被关掉了**。

### 根因
```css
.uq-anchor { pointer-events: none }
```

弹窗结构：
```html
<div class="uq-anchor">        <!-- pointer-events: none -->
  <div class="uq-dlg">         <!-- 继承 none ⇒ 点不到！ -->
    <div class="uq-sheet" onClick={onClose}>   <!-- 点击穿透到这里 ⇒ 关闭 -->
```

`pointer-events: none` 会**向后代继承**，而 `.uq-anchor` 上没有恢复规则。
于是 `.uq-dlg` 内所有元素都不接收指针事件，点击**穿透到下层遮罩**，
遮罩的 `onClick: props.onClose` 被触发 ⇒ 面板关闭。

为什么设置页没事？因为它是 slot 渲染，不在 `.uq-anchor` 内。

### 修复
```css
.uq-anchor { pointer-events: none }
.uq-anchor > * { pointer-events: auto }   /* 新增：子元素恢复 */
```

### 附带加固
- `RankList` 的 onClick 加 `e.stopPropagation()`（双保险）

### 为什么之前查不到
试过：接口 200、错误边界、`kilo`/`money` 的 null 处理、`modelCacheBadge` 参数、`closed` 状态…
**都没有问题** —— 因为问题根本不在 JS，而在 CSS。

**教训**：面板「消失」不一定是崩溃。
先区分「渲染异常」和「被关闭」：前者错误边界能抓到，后者不会。

## 7.10.3 —— 加错误边界：面板消失时能看到真正的错误

### 问题
点明细面板里的蓝色数字（`estTokensPerCredit`）后，整个面板消失、入口也不见了。
设置页已经正常，说明不是语法问题，而是**渲染期抛异常**导致 React 卸载整棵树。

### 修复：React 错误边界
新增 `UqErrorBoundary`（class 组件，`getDerivedStateFromError` + `componentDidCatch`），
包住三处：
1. `DetailSheet`（侧栏弹层的明细）
2. `DetailSheet`（底部小条的明细）
3. `CreditBillView`（明细里的积分账单页签）

**效果**：渲染异常时面板不再消失，而是显示：
```
渲染出错：
TypeError: xxx is not a function
    at CreditBillView (client.js:1234:56)
```
这样下次就能直接看到错误行号和原因。

### 事故记录：差点丢失 13574 字节代码
修复过程中，我用 `indexOf("\n}")` 定位 `DetailSheet` 函数结尾，
结果匹配到了函数内部的第一个 `}`，**删掉了 DetailSheet 剩余的 13574 字节**。

**恢复过程**：
- 从 `node_modules/dsh-unified-quota/lib/client.js`（已安装的 7.10.2 完整版）恢复
- 备份到 `_dev/client-7.10.2-good.js`
- 重新只做「加错误边界」这一件事

### 教训
1. **不要用 `indexOf("\n}")` 定位函数结尾** —— 必须做括号配对
2. 每次大改前先 `copyFile` 备份
3. 改完立刻 `node --check`，不要积累多处修改再检查

## 7.10.2 —— 面板消失（React hook 顺序错误）+ 设置项重构

### 严重 bug：点一下面板消失
**根因**：`SettingsSection` 里新加的 `useState` 放错了位置 ——
它被插在 `ensureCss()` **之前**、`useCfgVersion()` **之前**：
```js
function SettingsSection() {
  const [showAllCacheModels, setShowAllCacheModels] = React.useState(false);  // ❌ 在 ensureCss 前
  ensureCss();
  useCfgVersion();   // ← 内部有 useState/useEffect
}
```
虽然 hook 顺序本身没被打乱（都是无条件调用），但**后续的手动编辑把括号结构改坏了**，
导致整个 `SettingsSection` 的函数体错位、`return h(...)` 提前闭合，
**设置页整个渲染崩溃** ⇒ 用户看到「面板消失」。

### 修复
1. `useState` 移到所有 hooks 之后、early return 之前（正确位置）
2. 把「假定缓存命中率」整段**抽成独立函数 `cacheHitSettings()`**，
   避免 JSX 嵌套过深导致括号难维护（这次就是嵌套太长改错的）
3. `cacheBadge` / `modelCacheBadge` 移出 `SettingsSection`，放到 `CreditBillView` 之前

### 其它改动
- 小条弹层移除「模型来源」「上限来源」两行（用户反馈无用）
- 「假定缓存命中率」改为**自动反推为主**：
  - `/config` 新增 `modelCacheRates`（每个模型的反推命中率）
  - 默认只显示「无反推值需手填」的模型 + 已手填的
  - 「显示全部 N 个」按钮展开完整列表
  - 每个模型旁标注「自动反推 99.1%」或「无反推值，需手填」

### 教训
JSX 嵌套超过 8 层后，手动编辑括号极易出错。
**应及早抽成独立函数**，而不是继续深挖。

## 7.10.1 —— 徽标加错组件 + 设置页过度精简

### 用户反馈
1. 积分账单里**没有**看到模型级命中率徽标
2. 设置页「假定缓存命中率」的模型列表不精准
3. 积分单价分组「又精简了」

### 根因 1：徽标加在了错误的组件
`c.modelCacheHit` 的渲染加到了 **`ProviderTable`（多平台明细）**，
但截图看的是 **`CreditBillView`（积分账单）** —— 两个完全不同的组件。

**修复**：抽出 `modelCacheBadge()` 辅助函数，两个组件都调用。

### 根因 2 & 3：设置页被上一版「精简」伤到
7.9.1 为了减少噪音，把两个分组都改成「只列用过的」。
用户明确表示：**长度问题应该靠折叠/多页解决，不该删条目**。

**修复**：
- 积分单价：恢复 `st.providers`（全部渠道）
- 假定命中率：恢复完整 `modelList`（账本内所有模型）

### 附加：last-turn 持久化诊断
`last-turn.json` 一直没生成。加了**常驻 trace**（不受 `UQ_DEBUG` 限制）：
`storages/unified-quota/lastturn-trace.jsonl`，记录每次 finalize 的 `turn/cost/tokens`。
落盘失败也会通过 `safeCatch` 记录到 `debug/error.jsonl`。

## 7.10.0 —— 命中率按模型细分 + 上轮数据持久化

### 用户反馈（3 点）
1. 小条弹层没有「上轮消耗」数据
2. 缓存命中应按「渠道下的模型」细分，而不是只看渠道整体
3. 设置页「假定缓存命中率」应按模型配置，且不该简化掉渠道列表

### 1. 上轮数据持久化
`last-turn` 之前只读内存 `whaleLastTurnState`，进程重启或当前轮未结算时返回 null。
现在结算时同时写盘的 `storages/unified-quota/last-turn.json`，路由读不到内存时用磁盘兜底。

### 2. 命中率细分到模型
`/credits` 新增 `modelCacheHit`：
```json
{"deepseek-v4.1-flash": {"real": 0, "inferred": 0.99, "source": "inferred", "tokens": 772490000}}
```
前端在每个模型行显示徽标（绿=本渠道实测 / 黄=跨渠道反推）。
渠道级徽标保留（横向对比用），模型级徽标补充（看具体模型）。

### 3. 设置页改为按模型配置
`assumedCacheHit` 的 key 从「渠道」改为「模型」：
```json
{"deepseek-v4.1-flash": 0.84}
```
理由（用户指出）：同一模型跨渠道命中率接近，按模型配置可复用；
且「有 cacheRead 返回的渠道用不到这个数，只有不返回的才用得到」。

兼容：计价时**先查模型**，查不到再查渠道（旧配置仍生效）。

### 4. 恢复完整列表
设置页不再精简渠道/模型列表 —— 长度问题留待「折叠」「多页」解决（P2-2）。

## 7.9.1 —— 缓存命中率徽标不显示（两处作用域/字段缺失）

### 截图反馈
渠道行没有出现彩色命中率徽标，且设置页「假定缓存命中率」列出 12 个渠道（含从未使用的）。

### 根因 1：`todayAgg` 不在 credits 路由作用域
```js
const dayAgg2 = todayAgg.byProvider.get(c.provider);  // ❌ ReferenceError
```
`todayAgg` 属于 `/quota` 路由，`/credits` 用的是 `agg`。异常被 `catch` 吞掉 ⇒ `cacheHit` 恒为 null。

### 根因 2：聚合 row 缺分项字段
`perModelOfOwnLedger` / `perModelOfSingleDay` 的 row 只有 `{model, tokens, requests, days}`，
**没有 `input` / `cacheRead`** ⇒ 算不出命中率。

### 修复
1. `todayAgg` → `agg.byProvider`
2. 两个聚合函数的 row 增加 `input/output/cacheRead/cacheWrite` 分项并累加

### 验证（真实数据）
| 渠道 | 真实命中率 | 来源 |
|---|---|---|
| deepseek-account | 99.1% | real |
| workbuddy | 99.4% | real |
| codearts | 95.3% | real |
| qodercn | 95.1% | real |
| buddy | 76.7% | real |
| **trae** | 0%（不返回）| **反推 53.9%** |

### 顺带修复
- `deepseek-account` / `deepseek-official` 标签重复 → 区分为「DeepSeek 官方（账号）」「DeepSeek 官方（API）」
- 设置页两个分组改为**只列用过/配置过的渠道**（12 个 → 3-5 个，噪音大幅减少）

## 7.9.0 —— 第 2 批（准确性与体验）

### P1-2 每轮明细 UI
底部小条弹层新增 6 行「上轮」数据：
- **上轮消耗**：`¥0.0393` 或「免费模型」
- **上轮输入**：`312,665 tok`
- **上轮缓存命中**：`0 tok（0.0%）`
- **上轮输出**：`386 tok`
- **上轮步数**：`12`
- **计价口径**：`积分价（实际扣费）`

数据来自 `/dsh-whale/last-turn.json` 的 `breakdown` 字段（15 秒轮询）。

### P1-1 Qoder 快照值标注
抓取失败的渠道（如 Qoder）现在显示：
```
⚠ 快照值 ¥0.00995（专业版双11，请核对官网）
```
而不是伪装成「自动抓取」。用户能一眼看出这是内置快照。

### P1-3 缓存命中率按渠道显示
`/credits` 新增 `cacheHit` 字段：
```json
{"real": 0.992, "inferred": 0.991, "source": "real", "tokens": 389000000}
```
前端在渠道行显示彩色徽标：
- **绿色** = 上游返回的真实值（如 buddy 99.2%）
- **黄色** = 按同模型反推的估算值（如 trae）

悬停显示详情：「缓存命中率 99.2%（上游返回），命中比未命中便宜 50 倍」

## 7.8.0 —— 技术债清理（第 1 批）

### P3-4 版本号自动同步
新增 `scripts/bump.mjs`：
```bash
node scripts/bump.mjs 7.8.0     # 一次同步 4 处
node scripts/bump.mjs --check   # 只检查一致性（CI 用）
```
同步位置：`package.json` / `lib/index.js BUILD` / `lib/client.js CLIENT_VERSION` / `CSS_REV`。
之前每次发版要手工改 4 处，漏一处就会出现「宿主/客户端版本不一致」的黄色横幅。

### P3-5 备份文件清理
5 个 `.bak-vNN` 文件（lib/client.js.bak-v56/57、lib/index.js.bak-v58、
meter/config.js.bak-v31、meter/stream-meter.js.bak-v35）移到 `_dev/archive/`。
git 已有完整历史，源码目录不再有干扰文件。

### P3-1 诊断代码统一
新增 `lib/debug.js`，替代散落的 6 个 `*-dbg.jsonl` 探针：
```js
debugLog(DSH_HOME, 'cost', { turn, tokens, cost })
safeCatch(DSH_HOME, 'meter-pricing', e)
```
**开关**（默认关闭，零开销）：
```bash
UQ_DEBUG=1            # 全部通道
UQ_DEBUG=cost         # 只 cost
UQ_DEBUG=cost,error   # 多通道
```
日志写到 `<DSH_HOME>/debug/<channel>.jsonl`。

### 3 处关键 catch 加了诊断
把曾经掩盖 `ReferenceError`（导致 ¥0.00 排查 12 轮）的静默 catch 换成 `safeCatch`：
- `meter-pricing`（计价块）
- `session-event`（事件处理器）
- `session-listen`（监听注册）

以后同类问题会直接出现在 `debug/error.jsonl`，不用再靠猜。

### 教训固化
`docs/NEXT-PLAN.md` 第四节记录了本轮踩坑的方法论：
1. 先确认代码有没有执行，再怀疑逻辑
2. 用文件写入做诊断（DSH 日志拿不到）
3. 诊断覆盖完整路径（入口 → 分支 → 出口）
4. 修「显示值」时先查「谁还会写它」

## 7.7.3 —— 重算结果又被覆盖：内存实例未同步

### 现象
/recalc 返回 `{oldSum: 1115.99, newSum: 17.07}`，文件也确实写进去了，
但 20 秒后再读，又变回 ¥1116。

### 根因
`lib/meter/ledger.js` 的 QuotaLedger 是**内存实例**：
```js
schedule() { this.dirty = true; setTimeout(() => { void this.flush(); }, 2000); }
async flush() { ... await fs.writeFile(tmp, JSON.stringify(this.data)); ... }
```
**2 秒防抖 flush 会用内存 data 覆盖文件。**
`/recalc` 只改了文件，内存里的 `inst.data.days` 还是旧值，
于是下一次记账（或定时 flush）就把重算结果覆盖回去了。

### 修复
在 `/recalc` 写文件的同时，同步内存实例：
```js
const inst = ledgerOf();
inst.data.days = ledger.days;
inst.dirty = true;
await inst.flush();
```

### 教训
「改文件」和「改内存」必须同时做。这个插件有三层数据：
1. 磁盘文件（JSON）
2. 内存实例（QuotaLedger）
3. 进程缓存（balanceLogCache / ownLedgerCache / creditPriceCache）
任何一层不同步，都会被另一层覆盖。

## 7.7.2 —— 记账口径也改用积分价（账本不再被覆盖）

### 问题
7.7.1 重算后 trae 从 ¥1107 → ¥16.61，但**很快又涨回 ¥1111**。

### 根因
`priceRow()` 是**记账用**的函数，它一直用官方价目表：
```js
const cost = resolved.priced ? costOf(buckets, resolved.entry, atMs, peak) : 0;
return { costCny: cost * rate, ... };
```
所以每轮对话宿主都按官方价写入账本，把重算结果覆盖掉。
**弹窗和账本用的是两套不同口径** —— 这是我一直没注意到的。

### 修复
在 `priceRow()` 里加入积分口径优先：
```js
const perCredit = table[provider].perCredit;
const spent = realConsumption(balanceLog, provider, 1).today.spent;
const tokPerCredit = todayTok / spent;
const creditCny = (myTok / tokPerCredit) * perCredit;
return { costCny: creditCny, ..., creditBasis: true };
```
带 5 秒节流的实时读（避免缓存过期导致口径漂移）。

### 效果
现在**弹窗与账本同口径**，重算结果不会再被覆盖。

## 7.7.1 —— 按模型反推命中率 + trae 历史金额重算

### 1. 命中率改为「按模型」而非「按渠道」（用户建议）
实测验证：同模型跨渠道差异 < 5%
- deepseek-v4.1-flash: workbuddy 99.4% / buddy 99.2% / codearts 97.6%
- deepseek-v4.1-flash-1017: codearts 94.1%

实现 cacheHitRateByModel()：遍历同名模型的所有渠道，累计 cacheRead/(input+cacheRead)，
排除免费模型（hy4free 15.4%、hy4flash-free 1.6% 会拉低均值）。

优先级：手填 assumedCacheHit > 按模型反推 > 0

### 2. trae 历史金额重算（虚高 66 倍）
trae: 815M token 账本记 ¥1107.80 → 按积分口径应为 ¥16.61

迁移已执行（备份 ledger.json.bak-before-recalc-*）：
- byProviderModel 逐条重算
- 日级 costCny/cost/apiCost 同步
- sessions[] 按占比重算
- 只改 trae，其它渠道零改动（已验证）

### 3. 新增 POST /api/unified-quota/recalc
按当前积分单价与同窗口基准重算该渠道全部历史。

## 7.7.0 —— 缓存加权计价 + 每轮 token 构成细分

### 1. 发现：trae 不返回缓存数据
`usage-dbg.jsonl` 实测：
```json
{"inputTokens":326461,"outputTokens":386,"reasoningTokens":63}
```
**没有 `cacheReadTokens` 字段。**
所以账本里 `cacheRead=0`（18 万输入全记未命中），
费用被按「全部未命中」算 —— 而实际缓存命中率可能 84%，**费用偏高 5-6 倍**。

### 2. 新增：缓存加权计价
`officialCostWeighted(model, buckets, now, assumedHitRate)`

官方价目比例（flash，CNY/1M）：
| 项目 | 空闲 | 高峰 |
|---|---|---|
| 缓存命中 | 0.02 | 0.04 |
| 缓存未命中 | 1.0 | 2.0 |
| 输出 | 4.0 | 8.0 |

**命中 : 未命中 : 输出 = 1 : 50 : 200**

实测（32.6 万输入）：
| 假定命中率 | 费用 |
|---|---|
| 0% | ¥0.328 |
| 30% | ¥0.232 |
| 50% | ¥0.168 |
| 84% | ¥0.059 |
| 99% | ¥0.011 |

**命中率 99% vs 0% 相差 29 倍** —— 这个参数影响极大。

### 3. 新增配置 `assumedCacheHit`
```json
{ "trae": 0.84 }
```
设置页新增「假定缓存命中率」分组，每渠道一个输入框（填 0-100%）。
上游返回 `cacheRead` 时以真实值为准，不返回时才用假定值。

### 4. 每轮 token 构成细分
`agg` 新增分项累计：
```js
sumInput / sumCache / sumOutput / sumReasoning / sumCacheWrite / steps
```
并通过 `last-turn` 的 `breakdown` 字段暴露：
```json
{"input":326461, "cache":0, "output":386, "reasoning":63, "steps":12, "hitRate":0}
```
后续可做「每轮细分」UI（现在数据已就绪）。


## 7.6.9 —— 弹窗金额虚高 52 倍（计价口径错误）

### 现象
上一轮弹窗显示 **¥2.03**，但只用了 190 万 token。
用户质疑"trae 渠道估算是不是非常偏高"——**确实偏高，而且离谱**。

### 诊断（真实数据）
```
/current:  spent=233.6156 积分, channelTokens=177,589,263, creditModel.factor=0.06
抓取价:    trae = ¥0.015725/积分
```

按积分口径算：
```
1 积分 = 177589263 / 233.6156 = 760,177 token
本轮 1.90M token  = 2.498 积分
本轮花费          = 2.498 × ¥0.015725 = ¥0.0393
```

**实际应 ¥0.039，弹窗却显示 ¥2.03 —— 虚高 51.7 倍。**

### 根因
弹窗走 `priceRow()` → `DEFAULT_PRICE_TABLE`（**DeepSeek 官方 API 价**，输入 ¥1/M、输出 ¥4/M）。

但 trae 是**白嫖渠道**，真实成本是「**积分 × 积分单价**」，与官方 API 价无关。
1 积分能换 76 万 token，折合每 M token 仅 ¥0.02 —— 比官方价便宜 50 倍。

### 修复
计价优先级改为：
```
① 积分口径：本轮token ÷ (今日token/今日积分) × 积分单价   ← 白嫖渠道走这条
② 官方价目表 priceRow()                                   ← 只有①拿不到才用
③ 官方分项定价 officialCostOf()
④ 兜底 ¥3.2/M
```

### 验证
| 口径 | 本轮金额 |
|---|---|
| 修复前（官方价）| ¥2.0319 |
| **修复后（积分价）** | **¥0.0393** |
| 虚高倍数 | 51.7x |

今日累计：233.6 积分 × ¥0.015725 = **¥3.67**（而不是 ¥130+）


## 7.6.8 —— ¥0.00 最终根因：`options` 未定义（ReferenceError）

### 四个探针的数据（决定性）
```
usage-dbg.jsonl     ✓ 1 条：input=304958 cache=0 output=512
                    rawUsage={"inputTokens":304958,"outputTokens":512}
                    dKeys=["turn","step","message","usage","stream"]
                    srcObj=null
block-dbg.jsonl     ✗ 不存在
fallback-dbg.jsonl  ✗ 不存在
cost-dbg.jsonl      ✗ 不存在
```

**关键**：`agg.tokens` 累加成功（所以 usage-dbg 有数据），
但紧接的计价块**连第一个探针都没跑到**。

### 真因
```js
try {
  let provider0 = (options && options.provider) || ...;   // ← options 从未声明！
  let model0 = (options && options.model) || ...;
  ...block-dbg 探针...
} catch (e) { /* 计价失败不影响计数 */ }                  // ← ReferenceError 被静默吞掉
```

`options` 是上一版重构时遗留的变量，**从未声明**。
访问 `options.provider` 抛 `ReferenceError`，被外层 `catch` 吞掉，
于是**整个计价块（含所有兜底）从未执行过**。

这解释了全部现象：
- `agg.tokens` 有值（在 try 外累加）
- `agg.cost` 恒为 0（try 内第一行就炸）
- 所有兜底无效（都在同一个 try 里）
- `cost-dbg.jsonl` 从不出现（同理）

### 修复
```js
const evSrc = (d && d.source) || null;
let provider0 = (evSrc && evSrc.provider) || '';
let model0 = (evSrc && evSrc.model) || '';
// 追加：从 message 对象嗅探 model（DSH 的 assistant message 可能带 model 字段）
if (!model0) { ... msg.model / msg.response.model ... }
```

### 为什么前 10 版都没修好
我一直在**修改 try 块内部的公式**（倍率、官方价、同窗口计算、占位值），
但 try 块**第一行就抛异常**，后面所有代码从未执行。

**教训**：怀疑「逻辑错误」之前，先确认「代码有没有被执行」。
探针的价值就在于此——它们用「文件是否存在」直接回答这个问题。


## 7.6.6 —— 免费模型显示「免费」而非 ¥0.00

### 问题
免费模型（倍率 ×0）的 `agg.cost` 被设为 `0.0000001`（仅为让结算继续进行），
但挂件用 `toFixed(2)` 格式化 ⇒ 显示 `¥0.00`。

**用户无法区分**「免费模型」和「计价失败」——两者都显示 0.00。

### 修复
免费模型的 `amount` 传 **`null`**（不是 0.0000001），并附加 `free: true` 标记：

```js
const amountOut = agg.free === true ? null : (Math.round(agg.cost * 1e8) / 1e8);
whaleLastTurnState = { turn, amount: amountOut, tokens, ts, free: agg.free === true };
```

- `free: true` + `amount: null` → 挂件显示 `--`（明确不是金额）
- `free: false` + 正常金额 → 显示实际花费

### 7.6.5 的核心修复（回顾）
真正的 ¥0.00 根因是**占位值污染**：
```js
agg.cost += est > 0 ? est : 0.0001;   // ← 写入 0.0001
if (!(agg.cost > 0)) { ...兜底... }    // ← 0.0001 > 0 ⇒ 兜底永跳过
```
7.6.5 改为「只有真算出金额才累加」，让兜底能正常接手。

**7.6.6 是配套改进**：即使兜底算出金额，免费模型也应显示「免费」而非 0.00。


## 7.6.5 —— ¥0.00 真因锁定并修复（占位值污染）

### 诊断数据（7.6.4 重启后采集）
```
route-dbg:  {"seq":173, "lt":null, "ltType":"object"}   ← 路由读到 null
cost-dbg:   文件不存在                                    ← 兜底从未执行
finalize:   {"hasAgg":true, "cost":0, "tokens":3045716}
```

### 真因：占位值 `0.0001` 污染了 `agg.cost`
主计价块（行 2023）：
```js
agg.cost += est > 0 ? est : 0.0001;   // est=0 时写入 0.0001
```
紧接的无条件兜底（行 2030）：
```js
if (!(agg.cost > 0) && ...) { ... }   // 0.0001 > 0 ⇒ 条件为 false ⇒ 兜底跳过
```
**结果**：`agg.cost = 0.0001`，四舍五入后显示 ¥0.00，
兜底**永远不执行**（所以 `cost-dbg.jsonl` 从未生成）。

这是整条链的最后一环：我前几版都在改「兜底里的公式」，
但兜底**根本进不去**，因为占位值让它的前置条件失效了。

### 修复
```js
// 只有真算出金额才累加；算不出就让兜底接手
if (est > 0) { agg.cost += est; agg.unpriced = true; }
```

### 同时加固：状态用 ctx 共享
`route-dbg` 显示路由读到的 `lt` 恒为 null，但 `seq` 正常
⇒ 怀疑闭包隔离。改为双写双读：
```js
ctx.__uqWhaleState = whaleLastTurnState;          // 两处赋值都写
const lt = ctx.__uqWhaleState ?? whaleLastTurnState;  // 路由优先读
```

### 验证预期
重启后：
- `cost-dbg.jsonl` **应该出现**（说明兜底真的执行了）
- `last-turn` 的 `amount` 应为实际金额
- 弹窗不再是 ¥0.00


## 7.6.3 —— 积分实时可见 + 定位 ¥0.00 残留

### 1. 积分刷新（用户反馈：一定要打开明细才刷新？）
**是的，之前就是这样。**

- `/current` 接口本来就返回 `spent`（实测 `spent=206.77`）
- `QuotaMini` 每 15 秒轮询 `/current`
- **但小条 UI 只显示百分比，没显示积分**

**修复**：
- 小条直接显示今日积分：`87.3% 206.8分`
- 积分账单刷新间隔 30s → **10s**

现在不用打开多平台明细，底部小条就能看到积分在涨。

### 2. ¥0.00 残留（诊断证据）
`finalize-dbg.jsonl`：
```json
{"hasAgg":true, "cost":0, "tokens":9533052, "turn":179}
```
**hasAgg=true、tokens 有 953 万、cost=0** ⇒ 计价代码执行了但没算出金额。

关键发现：`model0` 是 `deepseek-v4.1-flash`（**不含倍率后缀**），
所以 `priceFactorFromName` 返回 `Infinity`（未知），
`isFreeModel` 判为 false，走 else 分支。

但 else 分支里 `officialCostOf('deepseek-v4.1-flash', ...)` 实测返回 **¥7.08**（非 0）……
所以理论上 `agg.cost` 应该 > 0。

**已加 `cost-dbg.jsonl` 详细诊断**，记录每次兜底后的
`provider0 / model0 / f1 / factor1 / input / cache / output / cost`，
重启后跑一轮就能看到到底哪个环节归零。


## 7.6.2 —— 倍率三态 + 免费模型识别（用户指出的关键漏洞）

### 用户提出的问题
「无条件兜底是否考虑了模型倍率以及倍率为 0（免费模型）的问题」

**答案：原来的代码没有正确考虑，有两个 bug。**

### Bug 1：倍率 0 被强制改成 1
```js
const factor1 = usableFactor(f1) && f1 > 0 ? f1 : 1;   // f1=0 → 变成 1
```
**限时免费模型（×0）被当成 ×1 收费，凭空多算钱。**

### Bug 2：免费模型根本识别不出来
`priceFactorFromName` 只认中文「免费」：
```js
if (text.indexOf("免费") >= 0) return 0;
```
而 `hy4flash-free`、`hy4free`、`Qwen-Flash-Free` 这类英文命名**返回 Infinity（未知）**
⇒ 被当成 ×1 计费。

### 修复
1. **倍率三态**（兜底 + 主块都改）：
   ```js
   const known = Number.isFinite(f);
   const isFree = known && f === 0;      // 免费：费用必须为 0
   const factor = known ? f : 1;          // 未知：保守按 1
   ```
2. **扩充免费识别**：`free` / `-free` / `_free` / `Free` / `trial` / `限免`

### 验证（10/10 通过）
| 模型名 | 倍率 | 判定 |
|---|---|---|
| hy4flash-free | 0 | ✓ 免费 |
| hy4free | 0 | ✓ 免费 |
| deepseek-v4.1-flash-free | 0 | ✓ 免费 |
| 免费模型 | 0 | ✓ 免费 |
| Qwen-Flash-Free | 0 | ✓ 免费 |
| deepseek-v4.1-flash · x0.11 | 0.11 | ✓ 正常 |
| deepseek-v4.1-flash · x0.18 | 0.18 | ✓ 正常 |
| qfmodel | ∞ | ✓ 未知 |
| **Spark X2.5** | ∞ | ✓ **未误判为免费** |

最后一条是关键回归：`Spark X2.5` 含 `2.5` 但**不含 free**，必须保持「未知」而不是「免费」。

### 免费模型的轮次处理
免费模型仍然：
- `agg.tokens` 正常累加（在 return 之前）
- `agg.free = true` 标记
- 用极小值 `0.0000001` 保证 `agg.cost > 0` ⇒ `finalizeTurn` 仍会推进轮次（弹窗照弹，但金额显示 0）


## 7.6.1 —— ¥0.00 的真正根因：整块计价被跳过

### 证据
`last-turn` 实测：
```json
{"seq":166, "turn":176, "amount":0, "tokens":1569339}
```
**turn 有值、tokens 有值，amount 却是 0** ⇒ 不是精度问题，是真的算成了 0。

### 根因
整个计价逻辑包在：
```js
if (provider0 && model0) {
  const p0 = priceRow(...);
  ...
}
```
一旦 `provider0` 或 `model0` 为空（实测 trae 渠道的 `session/event` 里
`d.source.provider/model` 可能缺失，而 `usedOf(sid)` 也没记录到），
**整块被直接跳过** ⇒ `agg.cost` 保持 0 ⇒ 弹窗 ¥0.00。

之前几版都在改「块内」的公式，但**块根本没执行**。

### 修复
在 `if (provider0 && model0) {...}` **之后**加无条件兜底：
```js
if (!(agg.cost > 0) && (input + cache + output) > 0) {
  const off1 = officialCostOf(String(model0 || ''), buckets, Date.now());
  agg.cost += (off1 !== null && off1 > 0) ? off1 * factor1 : (tok1 / 1e6) * 3.2 * factor1;
}
```
**只要有 token 消耗，就一定产生非零金额。**

### 验证（真实量级 156.9 万 token）
| model | 官方价 | 倍率 | 结果 |
|---|---|---|---|
| deepseek-v4.1-flash | ¥1.6426 | 1 | **¥1.6426** |
| deepseek-v4-flash | ¥1.6426 | 1 | ¥1.6426 |
| **(空字符串)** | ¥1.6426 | 1 | **¥1.6426** ← 关键：空也能算 |

对照旧的 ¥3.2/M 加权估算 = ¥4.99，官方分项计价 ¥1.64（因为缓存命中率 84%，命中部分只要 ¥0.02/M）。


## 7.6.0 —— 积分账单自动刷新 + DeepSeek 官方精确计价

### 1. 积分账单「卡住不动」（真 bug）
接口实测返回 `spent=143.05`，但界面显示 114。

**根因**：`CreditBillView` 只有一行加载：
```js
react.useEffect(() => { void load(30); }, [load]);   // 只在挂载时加载一次
```
**没有任何刷新机制** ⇒ 打开后数字永远停在那一刻。

**修复**：加 30 秒定时刷新（页面隐藏时跳过）。

### 2. DeepSeek 官方定价（用户要求）
抓到官方文档：https://api-docs.deepseek.com/zh-cn/quick_start/pricing

**完整价目（CNY / 1M token）**：

| 项目 | deepseek-flash 空闲/高峰 | deepseek-v4-pro 空闲/高峰 |
|---|---|---|
| 输入（缓存命中）| 0.02 / 0.04 | 0.15 / 0.30 |
| 输入（缓存未命中）| 1.0 / 2.0 | 4.5 / 9.0 |
| 输出 | 4.0 / 8.0 | 13.5 / 27.0 |

- **高峰时段**：工作日 9:00-12:00、14:00-18:00（北京时间）
- **空闲价 = 高峰价的一半**，周末/节假日全天空闲

**替代原来的粗估**：之前用「¥3.2/1M 加权平均」，现在改为**按缓存命中/未命中/输出分项精确计价**。

验证：
```
flash 空闲 ¥1.6100 / 高峰 ¥3.2200（刚好 2 倍）✓
v4-pro 空闲 ¥6.6000 ✓
```

### 3. Qoder 抓取：确认无法实现
- `qoder.com.cn/pricing` 和 `qoder.cn/pricing` 都是 **7.9KB 的 SPA 骨架**
- `qoder.cn/` 首页有 472KB，但只有 FAQ 文字，**价格靠 JS 从 API 动态加载**
- 找到的 API 端点都是 `/api/v1/auth`、`/api/v1/users` 这类登录相关，**没有公开的定价 API**

**结论**：只能用内置快照（¥0.00995 专业版双11）。


## 7.5.0 —— 积分单价贯通到弹窗 + 设置页显示抓取值 + TRAE 解析修复

### 1. 设置页看不到积分单价数据（用户反馈）
不是没做，是**显示得不明显**：
- 输入框只显示占位符「如 0.01」，没有展示自动抓取到的值
- 用户以为"没填数据"

**修复**：
- `/config` 响应新增 `fetchedPrices` / `fetchedAt`
- 设置页每个渠道的 label 下显示：`自动抓取 ¥0.01120（旗舰版包年）`
- 抓不到时显示：`未抓取到，用默认 ¥0.0106`

### 2. TRAE 抓取失败（真实 bug）
原始 HTML 128KB 里**确实有** `会员 Lite`，但我的解析器按 `## 会员` 分段
（那是 Markdown 格式），而真实 HTML 转文本后是换行分隔。

**修复**：按 `会员\s*` 切分，段内取 `¥数字` 和 `N 积分/月`。
验证：8 个套餐全部解析成功，最优 Ultra首月 ¥0.01572。

### 3. Qoder 抓取失败（技术限制）
`qoder.com.cn/pricing` 是纯 SPA（7.9KB 骨架），内容靠 JS 渲染，
服务端 fetch 拿不到。`web_fetch` 能拿到是因为它执行 JS。

**处置**：用内置快照兜底（¥0.00995 专业版双11），并在设置页标注「未抓取到」。

### 4. 弹窗金额没走抓取单价（¥0.00 的另一半原因）
- `/credits` / `/quota` 用 `cpriceTable`（抓取值）✓
- **小鲸鱼弹窗用 `priceRow`（内置价目表）✗** ⇒ trae 等渠道返回 0

**修复**：弹窗兜底改为
```
est = (本轮 token ÷ 该渠道每积分 token 数) × 抓取单价
```
与积分账单同口径，两边数字能对上。


## 7.4.0 —— 修复「积分消耗卡住不动」

### 现象
trae 渠道一直在用，但积分账单里的消耗**卡在 80** 不动。

### 诊断
查 `balance-log.json` 的 trae 样本：
```
02:12:15  total=2333.1852   ← 最后一条
（之后 24 分钟没有任何新样本）
```
而 `realConsumption` 逐段累计算出 `spent=79.87` —— **数据本身是对的**，
问题是**样本不再新增**，所以 spent 永远停在 79.87。

### 根因（两个）
1. **`recordBalances` 只在 `/quota` 路由调用**
   ⇒ 不打开「额度窗口」，余额就永远不会被采样。
2. **`CREDITS_TTL_MS = 60_000`**
   ⇒ 即使打开，60 秒内也用缓存，不会重新拉余额。

### 修复
在 **每次模型调用后**（`meter.record` 内）也采样一次余额：
```js
if (nowMs0 - lastBalanceSampleAt >= 60000) {
  lastBalanceSampleAt = nowMs0;
  void (async () => {
    const roster1 = shapeRoster(await readJsonCached(ROSTER_CANDIDATES[0])) || [];
    const cache1 = await loadCredits(ctx, roster1);
    if (Array.isArray(cache1.providers)) await recordBalances(cache1.providers);
  })();
}
```
- 60 秒节流，避免刷爆 `balance-log`
- 异步执行，不阻塞记账
- 这样只要你在用模型，余额样本就会持续更新 ⇒ `spent` 自动增长

### 关于「差额不更新」的另一面
`recordBalances` 的去重条件是「余额相同 **且** 30 秒内」，所以余额真的变了
一定会记录。之前的「卡住」不是去重导致的，是**根本没触发采样**。


## 7.3.0 —— 分级限流检测 + 渠道错误知识库

### 社区调研成果（一手资料）
从 4 个来源挖掘到可靠信息：
1. **DSH 源码** `dsh-llm/lib` + `dsh-llm-pi-ai/lib` —— `classifyPiAiError` 的真实分类顺序
2. **`@dmh2002/dsh-connect-qoder` v1.25.1** —— qoder 渠道完整错误处理
3. **WorkBuddy2API 源码分析** —— 最完整的限流分级（业务码 + 冷却策略）
4. **forum.trae.cn / aliyun 社区** —— 真实用户报错文案

### 关键发现：DSH 只认英文模式
```js
function classifyPiAiError(message) {
  if (/\b(?:401|403)\b/.test(...)) return "AUTH";     // 最先命中！
  if (isQuotaExceededError(message)) return "QUOTA";  // 只认 5 条英文正则
  if (/\b429\b|rate.?limit/i.test(...)) return "RATE_LIMIT";
}
```
**中文报错（如「所有账号均受限」）不会被 DSH 识别为 QUOTA**；
且报文里若带 `403` 会被误判为 AUTH（密钥失效）—— 这是社区插件踩过的坑。

### 新检测器：四级判定（社区验证的顺序）
| 优先级 | 依据 | 例 |
|---|---|---|
| ① | **业务码** | 14018 积分耗尽 / 6004 模型配额 / 14003 模型繁忙 |
| ② | **HTTP 状态码** | 402 积分耗尽 / 429 限流 |
| ③ | **英文模式** | `insufficient quota`（DSH 官方 5 条） |
| ④ | **中文文案** | 「配额使用上限」「额度不够」「使用量已超出频率限制」 |

**顺序很重要的原因**（社区踩坑）：429 的响应体常带 "quota exceeded"，
按关键词先判会把限流误归为积分耗尽，硬冷却 12 小时。

### 分级冷却时长（按 kind）
| kind | 默认冷却 |
|---|---|
| hard-credit（积分耗尽）| 24h |
| quota（配额耗尽）| 12h |
| rate（一般限流）| 6h |
| model-quota（模型配额）| 6h |
| model-busy（模型繁忙）| 10min |

### 知识库自动积累
`storages/unified-quota/cap-knowledge.jsonl`，每次限流追加一条：
```json
{"at":1794..., "provider":"buddy", "model":"deepseek-v4.1-flash",
 "until":..., "hasUntil":true, "text":"..."}
```
用得越多越准，永久保存，零维护。

### 检测器单测（12 条全通过）
buddy×2 / qodercn×2 / trae / workbuddy / 英文×2 / 402 / 429 / 业务码 / 正常文本拒绝 —— 全部正确。

### 修复 ¥0.00 弹窗
`names0` 属于 `/current` 路由作用域，在 `session/event` 处理器里**不可见**，
抛 `ReferenceError` 被外层 catch 吞掉 ⇒ `agg.cost` 恒为 0。
改用 `priceFactorFromName(model0)`，兜底值 `0.0001`。

### 关于「积分差额不更新」
核查结论：**不是 bug**。`recordBalances` 在余额未变时不写新样本（去重），
所以 `qodercn`/`codearts` 今日未使用 → 余额不变 → 无差额可算 → spent=0。
`buddy`/`trae` 有使用，差额正常更新（14 分钟前刚写入）。


## 7.2.0 —— 修复积分账单 500 + 统一默认单价

### 1. 积分账单 500（关键）
本地复现拿到真实异常：
```
[unified-quota] credits failed: priceTable is not defined
```
7.0.0 给 `/quota` 加了 `priceTable`，但 `/credits` 路由也用了 `resolvePrice` 却没有定义。

**修复**：在 `/credits` 路由内补上
```js
const cstore = configStoreOf(); await cstore.load();
const ccfg = cstore.get();
const cpriceState = await refreshCreditPrices(ctx).catch(() => null);
const cpriceTable = (cpriceState && cpriceState.table) || {};
```

**验证**（本地复现）：
```
credits: HTTP 200 ✓
  trae    spent=50.57 × ¥0.015725 = ¥0.795
  buddy   spent=43.61 × ¥0.0112   = ¥0.488
```

### 2. 统一回退单价（用户要求）
「拉不到积分的渠道暂时统一一个价格」——这个方法是对的，因为
积分单价本质是**套餐折扣率**，同档渠道差异不大。

**三层回退**：
1. 抓取到的真实单价
2. 用户手填的 `creditPrices`
3. **`officialFallbackPrice(baseAt1x)`** —— 用「1 积分 ≈ N token」× DeepSeek 官方 token 单价（¥3.2/1M）反推
4. **`DEFAULT_CREDIT_PRICE = 0.0106`** —— 四渠道中位数，兜底

### 3. quota 的 models 新增单价字段
之前只有 `/credits` 有，现在 `/quota` 每个模型也带
`creditPrice` / `creditPriceSource` / `creditPlan`。

**验证**：
```
quota: HTTP 200 ✓
  deepseek-v4.1-flash  price=0.0112 (fetched)
  hy4free              price=0.0112 (fetched)
```


## 7.1.0 —— 渠道名映射修复 + 估算改进 + Minimax 支持

### 1. 上游报错后额度窗口不显示上限（关键 bug）
实测 `caps.json` 写的是 `deepseek-account|deepseek-v4.1-flash`，
但报错文本说的是 `buddy: 模型 ... 所有账号均受限`。

**根因**：`recordCapFromError` 优先用 `hint.provider`（来自 `agent/error`，是 DSH 内部 id
`deepseek-account`），而不是报文里的 `buddy` ⇒ 上限挂到不存在的渠道 ⇒ 额度窗口查不到。

**修复**：渠道名优先级改为
1. **报文前缀**（`buddy: ...`）— 最准确
2. 报文里的 `providerHint`（`CodeBuddy (腾讯)` → `buddy`）
3. `hint.provider` — 仅兜底
新增 `KNOWN_PROVIDERS` 白名单校验，避免解析出垃圾渠道名。

### 2. 弹窗显示 0 消耗
未定价模型的兜底值从 `0.000001` 改为按 token 估算：
```js
est = (tokens / 1e6) * 0.5 * factor
```
这样气泡金额有实际意义。

同时修了一个时序 bug：`whaleLastTurnState` 原本只在 `setTimeout` 里赋值，
路由轮询时可能读到 `null`（返回 `turn: null, amount: null`）。
改为**立即同步**赋值。

### 3. 新渠道不显示「1 积分 = ? token」
`qodercn` 的 `creditModel.baseAt1x` 为 `null`（该渠道今日无余额差样本）。

**修复**：加跨渠道兜底 —— 用其它渠道的加权平均基准推算，
并标注 `source: "inferred"`，小窗显示时说明是推断值。

### 4. 新增 MiniMax 定价源
`https://platform.minimaxi.com/docs/guides/pricing-token-plan`
积分包：`¥30/4489`、`¥150/22460`、`¥500/74900` = **¥0.00668/积分**

### 当前可抓取渠道（4 个）
| 渠道 | 最优单价 |
|---|---|
| **MiniMax** | **¥0.00668** ★ |
| Qoder CN | ¥0.00995 |
| CodeBuddy | ¥0.01120 |
| TRAE | ¥0.01572 |

### 不可抓取的渠道及原因
- **Cline**：按量计费（usage-based），无积分套餐
- **ZCode**：无公开积分定价页
- **OpenCode**：美元计费（$10/$60），非积分制
- **CodeArts**：仅企业版公开定价
- **豆包**：走火山引擎 API 按量计费

这些渠道保留「手填积分单价」入口。


## 7.0.0 —— 渠道积分单价每日自动抓取

### 需求
各渠道的「1 积分多少钱」不想手填，希望每天自动抓取；抓不到就用官方定价回退；
有多个套餐时取**最优惠**的那个。

### 实现
新增 `lib/meter/credit-prices.js`：

| 函数 | 职责 |
|---|---|
| `PRICE_SOURCES` | 三个渠道的定价页 URL + 内置套餐快照（回退用） |
| `parsePricingPage(id, text)` | 从页面纯文本解析套餐（每家一个正则策略） |
| `bestPlanOf(source)` | 取「每积分单价最低」的方案 |
| `resolvePrice(...)` | 优先级：抓取 > 手填 > 官方回退 |
| `shouldRefresh(state, now)` | 每天只抓一次 |

宿主端 `refreshCreditPrices()`：
1. 逐渠道 `fetch` 定价页 → HTML 转纯文本 → 解析
2. 解析成功则用最优方案单价；失败回退到内置常量表
3. 结果落盘 `credit-prices.json`，每天刷新一次

`/quota` 响应新增 `creditPrice` / `creditPriceSource` / `creditPlan` / `realSpent`。

### 抓取验证（真实页面）
| 渠道 | 解析结果 | 最优方案 | 单价 |
|---|---|---|---|
| CodeBuddy | ✓ 6 套餐 | 旗舰版包年 ¥6720/年 | **¥0.01120/分** |
| TRAE | ✓ 8 套餐 | Ultra 首月 ¥629 | **¥0.01572/分** |
| Qoder CN | ✓ 9 套餐 | 专业版双11 ¥19.9 | **¥0.00995/分** |

★ 最划算：**Qoder CN ¥0.00995/积分**

### 重要发现：年付远比月付划算
以 CodeBuddy 旗舰版为例：
- 月付 ¥999 → ¥0.01998/分
- 连续包月(7折) ¥700 → ¥0.01400/分
- **连续包年(5.6折) ¥6720/年 → ¥0.01120/分** ← 几乎便宜一半
- 加量包 ¥50/1000分 → ¥0.05/分 ← 贵 4.5 倍，**千万别买**


## 6.9.0 —— 修复未定价模型不弹窗 + 新增积分单价（套餐性价比）

### 1. 未定价模型导致弹窗和提示音都不触发
`priceRow()` 对未收录的模型返回 `priced=false, cost=0`，实测：
```
buddy/deepseek-v4.1-flash        priced=true   cost=0.21  ✓
buddy/hy4flash-free              priced=false  cost=0     ✗
qodercn/qfmodel                  priced=false  cost=0     ✗
```
于是 `agg.cost` 恒为 0 ⇒ `finalizeTurn` 里 `if (agg.cost > 0)` 不成立 ⇒ **直接 return，不弹窗也不响铃**。

**修复**（两处）：
1. 未定价时累加极小占位值 `0.000001`，并标记 `agg.unpriced`
2. `finalizeTurn` 判断放宽为 `agg.cost > 0 || agg.tokens > 0`

### 2. 新增「积分单价」——横向对比套餐性价比
你的需求：不用去各渠道官网查套餐，直接在本插件里看到折算后的真实花费。

渠道 API 的 `packages` 只有积分数量（如 `{name:"CodeBuddy个人版", total:100}`），
**没有价格字段** ⇒ 无法自动推算单价。

**方案**：新增配置项 `creditPrices`（`{ "buddy": 0.01 }` 表示 1 积分 = 0.01 元）
- 设置页新增「积分单价 · 套餐性价比」分组，每渠道一个输入框
- `/quota` 响应新增 `creditPrice` 与 `realSpent`（= 消耗积分 × 单价）
- 填了就显示折算金额，不填则保持原样

这样你可以：
1. 在各渠道看到自己充了多少钱、得了多少积分
2. 手填一次单价
3. 之后插件自动算出「这个渠道花了多少真金白银」→ 横向比较哪家划算


## 6.8.1 —— 修复渠道额度全部显示「宿主未提供 connection 服务」

### 问题
侧栏弹层里 9 个渠道全部显示「宿主未提供 connection 服务」，渠道额度 `0 / 0`。

### 根因
```js
export const inject = ['webServer'];   // ← 只声明了 webServer
```
`createChannelPackBridge()` 用 `ctx.get('connection')` 拿服务，但插件可能在
`connection` 就绪**之前**就完成了 apply ⇒ 拿到 `undefined` ⇒ 桥不可用。

而 `bridgeMemo` 只在**成功时**缓存，失败不缓存 —— 这部分是对的，
但 `apply()` 只在启动时跑一次，之后的请求都用同一个 ctx，
所以每次都会重新探测，理论上应该自愈……除非 apply 时路由已注册但
首次请求就在服务就绪前。

### 修复
`inject` 改为 `['webServer', 'connection']`：
cordis 会**等 connection 就绪后**再调用 `apply()`，从根上消除时序问题。

`connection` 是 DSH 内置服务（`@deepseek-ai/dsh-client-connection`），
所有 profile 都有，不会导致插件在精简环境下无法加载。


## 6.8.0 —— 开关可视化 + 汇率兜底 + 消耗估算改用真实价目

### 1. 设置开关看不到开/关状态（截图证实是空白框）
`Switch` 全靠 `.uq-switch` 的 CSS 类渲染，但截图显示是**空白方框** ——
说明 class 样式在某些时序下没生效。

**修复**：改为**全内联样式**，不再依赖 CSS 注入：
```js
background: on ? "#4d6bfe" : "#3a3a41"   // 开=蓝，关=灰
left: on ? 18 : 2                         // 圆点位置
```
现在无论 CSS 是否加载，开关都可见且状态明确。

### 2. 汇率的 money 拿不到
接口明明返回 `{"rate":6.6665,"date":"2026-11-16"}`，但设置页显示「尚未取到」。
根因：`useConfig` 的初始 fetch 有时序问题，`setMoney` 没被调用。

**修复**：
- 新增 `refreshMoney()` / `useMoney()`（订阅式）
- `SettingsSection` 挂载时主动拉一次
- `money` 取值改为 `moneyLive || st.money` 双保险

### 3. 消耗弹窗金额被夸大（用户质疑，确认属实）
原来：
```js
agg.cost += (input + cache + output) / 1e6 * 0.5;   // 统一 ¥0.5/M
```
**这是错的**：输入/输出/缓存单价差 4~16 倍，混算必然失真。

**修复**：改用与账本同源的 `priceRow()`：
```js
const p0 = priceRow(buckets, provider0, model0, Date.now(), config);
agg.cost += Number(p0.apiCostCny) || 0;
```
provider/model 三级兜底：事件字段 → 会话投影 → `usedOf()` 最近记录。

**回答用户的问题**：是的，之前是按「统一 0.5 元/M」瞎猜；现在改为按
**该渠道该模型的真实价目表**（含峰谷）计算，与积分账单同口径。


## 6.7.0 —— 设置项改完立即生效 + 汇率提示改进

### 1. 设置改了界面不变化（"点了没反应"的真因）
审计结果：**12 个设置项全部有真实消费点**（包括 `peakEnabled`，它在宿主端
`priceRow()` 里影响峰谷计价）。所以不是"假开关"。

真正的问题是**响应性**：
```js
sharedCfg = j.config;   // 变量更新了，但组件读的是渲染时的快照
```
其他组件（底部小条、侧栏弹层、侧栏卡片）**不会重新渲染**，所以视觉上"没反应"。

**修复**：加配置订阅机制
- `setSharedCfg()` → 递增 `cfgVersion` 并通知所有订阅者
- `useCfgVersion()` hook → 组件订阅版本号，变化即重渲染
- 已接入：QuotaMini（底部小条）、Popover（侧栏弹层）、UnifiedQuotaCard（侧栏卡片）

现在改「显示币种」「小数位数」「侧栏紧凑」等，界面会**立即更新**。

### 2. 汇率"拿不到数据"
实测 `/api/unified-quota/config` 返回：
```json
{"rate":6.6665,"date":"2026-11-16","stale":false,"error":null}
```
**数据是有的**。日期停在 11-16 是因为 **ECB（欧洲央行）周末/节假日不发布新价**——
接口实测三个源全部返回 `2026-11-16`，不是本插件的 bug。

**改进**：hint 文案区分三种状态
| 状态 | 显示 |
|---|---|
| 今日已更新 | `欧洲央行参考价 · 2026-11-17` |
| 今日未发布（周末/假日） | `欧洲央行参考价 · 2026-11-16 · 欧洲央行今日未发布新价（周末/假日），沿用此价` |
| 取不到 | `尚未取到，使用配置值` |
| 刷新失败 | 附加 `刷新失败：<原因>` |


## 6.6.2 —— 彻底清理诊断代码

6.6.1 漏删了 `finalize-debug.jsonl` 的写入块（正则在跨行多语句时没匹配到）。
本版用括号配对精确定位并删除，确认两个诊断文件引用均已移除。

保留全部功能代码：延迟结算、三阶段探测、子代理判定、turn 去重。


## 6.6.1 —— 移除调试诊断代码

功能稳定后清理排查期间加的写盘诊断：
- `turnend-debug.jsonl`（session 结构探查）
- `finalize-debug.jsonl`（结算判定核对）
- `agent-error-debug.jsonl` 的重复写入

**保留**的功能代码：
- 延迟结算（`turn/start` 取消 + 2.5s 定时器）
- 三阶段恢复探测
- `delegationDepth` 子代理判定（作为防御）
- `turn` 去重（`whaleSettledTurns`）

清理后不再每次结算都写磁盘，减少 I/O。


## 6.6.0 —— 延迟结算：一次对话只弹一次窗（真正解法）

### 6.5.0 的去重为什么不够
去重键是 `sid#turn`，但诊断显示：
```
23:56:30 turn=? willAdvance=true
23:56:40 turn=? willAdvance=true   (10 秒后)
23:56:49 turn=? willAdvance=true   (9 秒后)
```
**是三个不同的 turn 号** ⇒ 去重拦不住。

### 真因（DSH 的 turn 语义）
`agent-loop` 的 `kick()`：
```js
async kick() { while (await this.turn()) {} }
```
**一次用户对话会连续跑多个 turn**（思考 → 工具调用 → 再思考 → ...），
每个 turn 结束都触发 `turn/end`。

所以「turn/end = 一轮对话结束」这个前提本身就是错的。

### 修复：延迟结算 + 取消机制
- 监听 `turn/start`：一旦新 turn 开始，**取消**待结算定时器（本轮还在继续）
- `turn/end` 后**延迟 2.5 秒**才结算并 `seq++`
- 期间若有新的 `turn/start` ⇒ 定时器被清掉，不结算 ⇒ 不会弹窗

这样无论内部跑多少个 turn，**用户看到的是一轮对话 = 一次弹窗 + 一次提示音**。


## 6.5.0 —— 修复「同一轮对话弹两次消耗小窗」（真因）

### 诊断数据（finalize-debug.jsonl）
```
15:53:38  sid=session-d87c5558...  depth=0  isSub=false  willAdvance=true
15:54:13  sid=session-d87c5558...  depth=0  isSub=false  willAdvance=true
```
**同一会话、35 秒内、两次都推进了 seq** ⇒ 这就是弹两次窗的原因。

### 真因
`whaleFinalizeTurn` 结算后**没有把 `agg` 从 Map 里删除**：
```js
if (type === 'turn/end') { whaleFinalizeTurn(sid); return; }
```
而 DSH 在同一轮里会触发**多次 `turn/end`**（观察到 2 次，间隔 35 秒）。
每次都用**残留的同一个 agg** 结算 ⇒ `seq++` 两次 ⇒ 弹窗两次。

### 修复
1. 结算后 **立刻 `whaleTurnAggs.delete(sid)`**
2. 新增 `whaleSettledTurns`（键 `sid#turn`）去重：同一轮只结算一次
3. 集合上限 200 条，防止无限增长

### 覆盖的边界场景
| 场景 | 行为 |
|---|---|
| `turn/end` → `assistant/message`(同 turn) → `turn/end` | 第二次被去重拦截 ✓ |
| 新一轮（turn 号变化） | 正常结算 ✓ |
| `assistant/message` 切换 turn 时触发 finalize | 走同一去重路径 ✓ |

### 关于「子代理」的结论
诊断证明**后台任务不产生独立子会话**（`delegationDepth` 恒为 0）。
之前的子代理方案（`subagent/start`、`delegationDepth`）**都不是本问题的原因**，
保留作为防御，但真正的问题是 turn/end 重复触发。


## 6.4.2 —— 移除会干扰的拖动提示

### 问题
上一版给标题栏加的「按住标题栏可拖动」提示出现两个副作用：
1. 它是 `data-tip` 属性 ⇒ 全局单例气泡在**指针移到标题栏任何位置**时都弹出
2. 用户反馈"指针指向积分账单/额度窗口时它也出现，拖动时固定在窗口左边"
   —— 因为 `:active::after` 的定位基于 `.uq-dlg-top`，会随布局与指针移动而漂移

### 决定：移除，不做修复
DSH 本体那个提示是**系统级窗口的原生行为**，而本插件是自绘浮窗（`position:fixed`）。
强行模仿只能得到"形似神不似"的效果，且引入两个可见副作用。

拖动能力本身完整保留：
- `cursor:grab` / `:active` 时 `grabbing`
- `onMouseDown: onDragStart` 拖动手柄不变

移除内容：
- `.uq-dlg-top::after` 与 `:active::after` 两条 CSS
- 标题栏上的 `data-tip` 属性


## 6.4.1 —— 用 delegationDepth 判定子代理

### 诊断突破
`turnend-debug.jsonl` 记录了 session.header：
```json
{"version":4,"id":"session-...","cwd":"E:\\完全体工作区",
 "isSeeded":false,"delegationDepth":0,"agentPreset":"ptc"}
```
`delegationDepth` 正是主/子会话的天然标记：主会话为 0，子代理 > 0。

（`subagent/start|end` 事件证明是作用域过滤的，本插件收不到。）

### 变更
- `whaleDepth` Map：在 `turn/end` 时从 `session.header.delegationDepth` 记录
- `whaleFinalizeTurn` 判定改为：`isSub = 黑名单命中 || depth > 0`
- 新增 `finalize-debug.jsonl`：记录每次 finalize 的 `sid/depth/isSub/willAdvance`

### 待验证
诊断里目前只出现过主会话（depth=0），说明**后台任务可能没有产生独立子会话**。
若下次仍是 depth=0，则弹窗来自同一会话的多次 turn/end —— 那需要另一套判据。


## 6.4.0 —— 悬停提示对齐 DSH 本体视觉

### 参考 DSH 本体的行为（用户截图）
1. 悬停时**指针处的元素轻微变暗**
2. 提示框是**深黑底 + 白字 + 无边框**、小圆角、紧凑
3. 提示框**贴在指针右下方**，不是元素左对齐

### 变更
| 项 | 之前 | 现在 |
|---|---|---|
| 背景 | `--dsw-alias-bg-layer-3`（主题色） | `rgba(24,24,27,0.96)` 深黑 |
| 文字 | `--dsw-alias-label-primary` | `#f4f4f5` |
| 边框 | 1px 主题边框 | **无** |
| 圆角 | 6px | 4px |
| 字号/行高 | 11px / 1.5 | 12px / 18px |
| 定位 | 元素左对齐 + 下方 | **指针位置 + 右下方偏移** |
| 悬停反馈 | 无 | `filter:brightness(.88)` 变暗 + `cursor:help` |

### 明细弹窗
标题栏按下时显示「按住标题栏可拖动」提示（DSH 本体同款交互）。


## 6.3.1 —— 子代理识别：诊断已证明走错通道

### 关键证据
`turnend-debug.jsonl` 只有一条：
```json
{"sid":"session-d87c5558-...","isSub":false,"subCount":0}
```
而 `subagent-debug.jsonl` **从未生成** ⇒ `subCount: 0` ⇒
**`subagent/start` / `subagent/end` 从未触发到本插件**。

### 原因
DSH 用 `this.host.emitLifecycle("subagent/start", runInfo, root)` 发布，
而 `emitLifecycle` 是**作用域过滤**的（只投递给同一 subagent 树根的订阅者）。
本插件不在那个作用域内，所以永远收不到 —— 6.2.0/6.2.2 的方案从根上不成立。

### 本版
扩展 `turnend-debug.jsonl`，记录 `session` 对象的：
- 全部可枚举键名（`keys`）
- `session.header` 的内容（`header`，可能含 parent 线索）

拿到这些就能确定：能否用 session 自身字段区分主/子会话（比事件更可靠）。


## 6.3.0 —— 三阶段限流恢复探测

### 关于「默认 24 小时」的验证
用户提出假说：解禁时间 = 当日首次对话 + 24h。**数据否定了这个假说**：

| 模型 | 实际解禁 | 反推首次(+24h) | 真实首次对话 | 偏差 |
|---|---|---|---|---|
| deepseek-v4.1-flash | 11/16 13:57:30 | 11/15 13:57:30 | 11/15 **09:14:50** | 4.7h |
| hy4flash-free | 11/17 15:43:21 | 11/16 15:43:21 | 11/16 **11:14:22** | 4.5h |

两例实际间隔为 **20.5h / 17.4h**，既不是 24h 也不锚定首次对话。
更像是渠道侧的固定配额周期，上游给的时间才是权威。
**结论**：默认值改 6h → **24h**（偏保守；宁可多等，探测成功会提前清除）。

### 三阶段探测引擎
探测方式：`ctx.llm.prepareCall(provider, model).stream({maxTokens:4})`
—— **不建会话、不出聊天记录**，单次约 10 token。

| 阶段 | 时机 | 行为 |
|---|---|---|
| **A** 验真+补时间 | 触发后 1 分钟起，最多 3 次，间隔 30 秒 | 成功⇒误报，清 cap；仍失败⇒继续 |
| **B** 等恢复 | 距 `until` ≤ 10 分钟才启动，每 2 分钟 | 成功⇒清 cap 并停止 |
| **C** 充值检测 | 每轮 tick 查渠道余额（不花 token） | 余额上涨⇒该渠道 cap 拉回阶段 A 立即探 |

- 循环周期 30 秒；已过期的 cap 直接清除，不浪费探测
- `ctx.effect` 保证卸载时清理定时器
- 总成本 ≤10 次调用 ≈ 100 token


## 6.2.2 —— 子代理弹窗：加诊断定位

### 问题
后台任务（子代理）跑完仍会弹「本轮消耗」小窗 + 提示音。

### 6.2.0 的修复为什么没生效
我监听了 `subagent/start` / `subagent/end`，从 `info.sessionId || info.id` 取 id 加入黑名单。
但 DSH 的 payload 是：
```js
{ runId, provider, parentSessionId, id, local }
```
**子代理的 `session/event` 里 `session.id` 是否等于 `activation.childId`，我没有验证过。**

### 本版
1. **扩展 id 提取**：同时收集 `sessionId` / `id` / `runId` / `childId`
2. **两个诊断文件**：
   - `subagent-debug.jsonl` —— subagent/start|end 的真实 payload 字段
   - `turnend-debug.jsonl` —— 每次 turn/end 的 sessionId 与是否被判为子代理

重启后跑一次后台任务，读这两个文件就能确定：
- subagent 事件的 key 到底叫什么
- turn/end 里那个 sid 与 subagent 集合里的值是否匹配


## 6.2.1 —— 修复双重注释 + 触顶后加快轮询

### 1. 双重注释（重叠）
`tip()` 同时写 `data-tip` 和 `title`：
- `data-tip` → JS 单例气泡
- `title` → 浏览器原生提示

两者**同时弹出**，位置不同、样式不同 ⇒ 视觉上"双重 + 重叠"。

**修复**：
- `tip()` 不再写 `title`，只写 `data-tip`
- 全文件 30+ 处直接写 `title:` 的 props 统一改为 `"data-tip":`，避免原生提示与气泡并存
- i18n 字典里的 `title` 键保持不动

### 2. 触顶后额度小条没有立即归零
原来是固定 15 秒 `setInterval`。改为**自适应轮询**：
- 正常状态：15 秒
- 已触顶（`data.capped === true`）：**3 秒**

这样触发限流后，最多 3 秒小条就会归零并显示上限。


## 6.2.0 —— 悬停注释的真正根因（React element 字段名）+ 子代理不弹窗

### 1. 悬停注释全局失效 ← 从 5.5.0 起就一直没生效
`tip()` 的判断条件：
```js
if (node.p !== undefined) { ... }   // ← React element 的字段名是 props
```
`h = react.createElement` 返回的元素字段是 `props`，不是 `p`。
所以 `node.p !== undefined` **恒为 false** ⇒ `tip()` 每次原样返回节点，什么都不加。

这意味着：从我把 tooltip 改成"写属性"的那一版（5.5.0）开始，
**所有 tip() 调用全部无效**——而后续几版我一直在改 CSS/定位方案，都没意识到
属性根本没写上去。

**修复**：正确判断并写入 `props`（同时兼容旧的 `p` 字段）。

验证（真实 React element 结构）：
```
props["data-tip"] = "这是说明"   ✓
props.title       = "这是说明"   ✓
props.className   = "uq-help uq-tip-anchor"  ✓
```

### 2. 后台任务跑完也弹消耗小窗
原版小鲸鱼有子代理判断：
```js
const isSub = subagentSessions.has(sessionId) && subagentMuteOn()
if (!isSub) lastTurnSeq++
```
我的实现缺这一步，导致**后台任务（子代理）完成也推进 seq** ⇒ 弹一次；
随后主对话结束再推进一次 ⇒ 又弹一次。

**修复**：监听 `subagent/start` / `subagent/end` 收集子代理 sessionId，
`whaleFinalizeTurn` 里对子代理**跳过 `whaleTurnSeq++`**。
（子代理的用量照常记账，只是不触发挂件提示——与原版一致。）


## 6.1.1 —— 悬停气泡改为 portal 单例 + 修正错误码

### 1. 悬停注释在明细弹窗/底部小条里完全不显示
**根因**：`.uq-dlg`（明细弹窗）和输入框 dock 都有 `overflow: hidden`，
纯 CSS 的 `::after` 绝对定位气泡被**裁切**，连原生 `title` 也没有（因为有更上层的遮挡）。

**修复**：改用 **portal 到 `document.body` 的 JS 单例气泡**：
- 用 `mouseover/mouseout` 事件委托（`closest("[data-tip]")`），**不跟踪 pointermove**
- 只在**进入时**读一次 `getBoundingClientRect` 定位，之后不重算
- 气泡 `pointer-events:none`，不会被指针碰到 ⇒ 无自我触发循环
- `position: fixed` + 挂到 body ⇒ 不受任何祖先 `overflow`/`transform` 影响
- 滚动/缩放/按下立即隐藏

与之前失败那版的区别：**那次每帧 pointermove 都重算坐标并强制布局**（漂移+抖动）；
这次只在进入时算一次。

### 2. 错误码白名单过窄
实测 DSH 抛的是 `errCode: "QUOTA_EXCEEDED"`，而我原来只认 `QUOTA` / `ACCOUNT_QUOTA`。
改为 `includes("QUOTA")` 覆盖所有变体，并补充 `BALANCE`、`INSUFFICIENT_QUOTA`。

> 注：这次限流仍被成功记录了（`buddy|hy4flash-free until=2026/11/17 15:43:21`），
> 是因为文本兜底匹配生效。修错误码是为了不再依赖文本。

### 3. 关于"要点一下小条才刷新"
小条自身是 15 秒轮询。触顶状态写入 `caps.json` 后，下一次轮询才会反映。
如需更快，可以把触顶时的轮询间隔临时降到 3 秒 —— 待确认是否需要。


## 6.1.0 —— 四个问题一并修复

### 1. 额度触顶检测（换通道）
实测 `onerror-debug.jsonl` **从未生成** ⇒ 限流错误根本不经 `llm/stream` 的 catch。
改用 **`ctx.on('agent/error', { turn, step, error })`** —— 这是 DSH 的 `agent-loop` 真正 emit 的事件。
同时保留 `llm/stream` 的钩子作为次要通道。诊断写入 `agent-error-debug.jsonl`。

### 2. 结束音重启后被重置 ← 关键 bug
挂件读取逻辑：`if (d && d.ok && d.settings) usageSet = d.settings`
而我的路由返回的是**扁平结构** `{ ok:true, taskEnd:{...} }` ⇒ `d.settings === undefined`
⇒ `usageSet = null` ⇒ 挂件回落到**内置默认值**（`taskEnd.on: false`）⇒ 表现为"每次重启设置被重置"。
**修复**：返回 `{ ok: true, settings: {...} }` 嵌套结构，写入时也兼容两种入参。

### 3. 任务刚开始就弹消耗小窗
挂件首次轮询逻辑：
```js
if (!lastCostAligned) { if (d.seq > lastCostSeq) { playTaskEndSound(); showCostBubble() } }
```
重启后 `.dshw-turn.json` 的 seq 大于浏览器 localStorage 的旧值 ⇒ 误判"刚完成一轮" ⇒ 弹窗+响铃。
**修复**：进程启动后 3 秒内 `last-turn` 返回 `seq: 0`，
挂件会走「记忆值已过期→拉齐」分支，只更新 localStorage、不弹窗不响铃。

### 4. 悬停注释在明细弹窗内失效
`.uq-dlg` 有 `overflow: hidden`，会裁切绝对定位的 `::after` 气泡。
**修复**：弹窗内禁用 CSS 气泡，回退到原生 `title`（不受 overflow 影响）；
弹窗外的位置（侧栏卡片、设置页）继续用即时 CSS 气泡。


## 6.0.6 —— onError 诊断落盘（定位限流为何捕获不到）

### 背景
6.0.4 加了结构化错误码检测，但实测限流后 `caps.json` 仍无新条目。
DSH 的日志目录为空（`%APPDATA%\@deepseek-ai\dsh-desktop\logs` 里没有任何文件），
拿不到 logger 输出，无法定位。

### 本版
把 `onError` 收到的**完整错误结构**写入：
`~/.dsh/storages/unified-quota/onerror-debug.jsonl`

每条记录包含：
- `hintProvider` / `hintModel` —— 钩子传入的 provider/model
- `errName` / `errCode` —— 错误类型与 DSH 的结构化错误码
- `errMsg` —— 前 300 字符
- `errKeys` —— 错误对象的自有属性名
- `errJson` —— 前 500 字符的 JSON 序列化

下次触发限流后，直接读这个文件就能确定：
- 钩子有没有被调用
- 错误对象长什么样
- provider/model 是否为空（这是 `recordCapFromError` 返回 false 的常见原因）


## 6.0.5 —— 悬停注释改为纯 CSS 即时气泡

### 问题
用户反馈"悬停注释全局失效"。单测证明 `tip()` 机制正常（都正确写了 `title`），
所以问题是**浏览器原生 `title` 有 1–2 秒延迟**，用户体验上等于"没有"。

### 方案
改用 `data-tip` + 纯 CSS `::after`：

```css
.uq-tip-anchor { position: relative }
.uq-tip-anchor:hover::after {
  content: attr(data-tip);
  position: absolute; left: 0; top: calc(100% + 4px);
  /* 其余为外观 */
}
```

`tip()` 同时写三个属性：
- `data-tip` → CSS 即时气泡
- `title` → 无障碍与无 CSS 时兜底
- `className += " uq-tip-anchor"` → 挂载点

### 为什么这次不会再漂移/抖动
- **零 JS 定位**：不监听 pointerover/pointermove，不算坐标
- **由布局引擎定位**：`position:absolute` 相对父元素，浏览器负责
- **pointer-events:none**：气泡不会被指针"碰到"，无闪烁循环
- **不写 DOM**：`::after` 是伪元素，不参与文档流，不会撑高页面

### 验证
| 检查 | 结果 |
|---|---|
| data-tip 写入 | ✓ |
| title 兜底保留 | ✓ |
| className 含 uq-tip-anchor | ✓ |
| 无 className 节点也正确 | ✓ |
| CSS 四条规则齐全 | ✓ |


## 6.0.4 —— 额度触顶检测改用结构化错误码

### 问题
用限流模型发消息后，额度窗口与底部小条都没更新上限。

### 关键证据
- `caps.json` 没有新增条目
- 但账本里 `buddy:hy4flash-free` 今日有 **197 次调用** ⇒ `llm/stream` 钩子在工作
- ⇒ 说明**限流错误没走到 `onError`**，或不匹配文本规则

### 根因方向
DSH 的 `LlmError` 自带 provider-neutral 错误码：
```js
QUOTA_EXCEEDED_CODE = "QUOTA"
ACCOUNT_QUOTA_EXCEEDED_CODE = "ACCOUNT_QUOTA"
```
而我之前**只靠中文文本匹配**（"均在限流中"等），上游换个说法就失效。

### 修复
`recordCapFromError` 改为**结构化优先**：
```js
const code = error.code || error.failure?.code
const isQuotaCode = code === 'QUOTA' || code === 'ACCOUNT_QUOTA'
if (parsed === null && !isQuotaCode) return false   // 两者都没有才放弃
```
文本解析仍用于提取 model / until / provider，但**不再是唯一入口**。

### 兼容处理
`parsed` 可能为 null（结构化命中但文本没解析出），所有字段访问已加容错。


## 6.0.3 —— 额度触顶检测：支持更多上游措辞 + 加诊断

### 问题
截图里 hy4flash-free 已被限流（QUOTA_EXCEEDED），但额度窗口仍显示 `capped=false`。

### 已修
1. **支持「均受限」类措辞**：原来只认 `均在限流中` / `限流中`，
   现在也认 `均受限`、`所有账号均`、`账号均`（上游用词不统一）
2. **放宽模型名正则**：原 `/模型\s+(\S+)\s*的/` 要求后面必须跟「的」，
   而报错常写成「模型 hy4flash-free 所有账号均受限」⇒ 匹配不到。
   改为 `/模型\s+([\w.\/-]{3,})/`

### 验证
| 报文 | 修复前 | 修复后 |
|---|---|---|
| 「…均在限流中，最近一个将于 2026/11/17 15:43:21 解禁」 | ✓ | ✓ |
| 「…所有账号均受限，请稍后再试」 | ✗ null | ✓ model=hy4flash-free |
| 「模型 deepseek-v4.1-flash 运行正常…」（对照） | null | null ✓ 不误判 |

### 待诊断（本版加日志）
报文 1 本来就能解析，却没写入 `caps.json` ⇒ 说明 `onError` 钩子可能没被调用。
已加两条日志：
- `onError provider=… model=… msg=…` —— 确认钩子触发与参数
- `recordCap result=true/false` —— 确认是否落盘

下次限流时看日志即可定位。


## 6.0.2 —— 修复 lastTurnPayload 丢弃 seq（任务结束音的真正根因）

### 根因（隔离测试实测）
`whale-compat.js` 的 `lastTurnPayload`：

```js
if (!s) return { ok: true, seq: 0, turn: null, ... }   // ← 错误：seq 被写死成 0
```

重启后 `whaleLastTurnState === null`（还没跑过任何一轮），于是**即使
`whaleTurnSeq` 已从 `.dshw-turn.json` 载入 84，路由仍然返回 `seq: 0`**。
挂件的 `d.seq > lastCostSeq` 永不成立 ⇒ 任务结束音永不播放。

### 实测证据
隔离环境（预置 `.dshw-turn.json` = 84）：
- 启动日志：`whale turn seq 载入 84`
- 监听注册：`已监听 session/event` ✓
- 初始 last-turn：`{"seq":0,...}` ← **bug 在这里**
- 触发一轮后：`{"seq":85,"turn":5,...}` ✓ 机制本身正常

### 修复
无 lastSession 时返回真实 `seq`，不再写死 0：
```js
if (!s) return { ok: true, seq: seq, turn: null, ... }
```

### 为什么之前几版都没修对
前几版把注意力放在「seq 怎么算」（调用次数/金额/轮次），
但真正的问题是**算出来的值在最后一步被丢弃了**。
诊断日志 + 隔离测试才把它暴露出来。


## 6.0.1 —— 加诊断日志定位 turn 信号为何未生效

### 现象
6.0.0 安装后 last-turn 返回 `{"seq":0,"turn":null}`，
而磁盘上 `.dshw-turn.json` 里是 `{"seq":82}`。说明：
1. 初始化没读到 82（可能路径或时序问题）
2. `turn/end` 事件完全没触发

### 本版
加了两条日志（不改变逻辑）：
- `[unified-quota] whale turn seq 载入 N（路径）` —— 启动时确认读取结果与路径
- `[unified-quota] whale: 已监听 session/event` —— 确认监听注册成功

重启后看日志即可定位：是路径错、初始化失败、还是事件根本没来。


## 6.0.0 —— 任务结束音改用真实轮次信号（对齐原版机制）

### 之前为什么一直不响
前几版我用「账本累计金额」或「调用次数」推算 seq，都是**间接指标**：
- 调用次数：任务中持续增长 → 反复响
- 累计金额：会话并发/后台调用会干扰，且缓存滞后

### 原版机制（从备份源码比对得出）
`dsh-whale-widget` 监听 `ctx.on('session/event')`：
```js
if (type === 'turn/end') { finalizeTurn(sessionId); return }
if (type === 'assistant/message') { /* 按 (session, turn) 聚合 usage */ }
```
`finalizeTurn` 里 `lastTurnSeq++` —— **这才是干净的轮次信号**。

### 本版实现
- 监听 `session/event`：`assistant/message` 累加 token，`turn/end` 结算并 `whaleTurnSeq += 1`
- seq 持久化到 `.dshw-turn.json`（重启不归零）
- `last-turn.json` 返回真实的 `{ seq, turn, amount, tokens, ts }`
- 不再依赖账本、不再有缓存滞后

### 验证（模拟事件）
模拟一轮 50000 input + 2000 output：
```
初始: {"seq":0,"turn":null,"amount":null,"tokens":null}
结束: {"seq":83,"turn":1,"amount":0.026,"tokens":52000,"ts":...}
```
seq/turn/amount/tokens 全部正确。

### 附带修复
`turn` 不再恒为 null —— 挂件的「每轮消耗」气泡也能正常显示本轮轮次。


## 5.9.5 —— 修复 last-turn 返回滞后 seq（缓存误判）

### 实测证据
同时刻对比：
- 直接读 `ledger.json` 算出的 seq = **1,722,184**
- 宿主 `/dsh-whale/last-turn.json` 返回 = **1,721,994**（滞后 190）

### 根因
`readJsonCached()` 的缓存键是 `mtimeMs + ':' + size`。
账本由写入方「temp + fsync + rename」原子替换；rename 后 **mtime 可能落在同一毫秒、size 也可能不变**
⇒ 缓存误判命中 ⇒ 返回旧内容 ⇒ 挂件看到的 seq 滞后 ⇒ `d.seq > lastCostSeq` 不成立 ⇒ 任务结束音不响。

### 修复
`last-turn` 路由**跳过缓存**，每次直接 `fs.readFile + JSON.parse`。
该路由被挂件每秒轮询一次，账本约 55 KB，直接读的成本可忽略。

### 待验证
本轮还需实测「seq 的增长率是否与轮次对齐」：
若任务**进行中** seq 就在涨，说明「累计消费金额」仍不是干净的轮次信号，
需改听 DSH 的会话结束事件（`turn` 字段）取真实轮次。


## 5.9.4 —— 修复任务进行中反复响提示音

### 问题
任务**运行中**挂件就发出提示音，而不是结束后响一次。

### 根因
5.9.3 把 seq 改成了「全账本累计模型调用次数」。
一次任务里有几十次模型调用 ⇒ `calls` 持续增长 ⇒ seq 持续增长 ⇒
挂件的 `if (d.seq > lastCostSeq) playTaskEndSound()` **每次轮询都成立** ⇒ 反复响。

### 修复
seq 改为基于**累计消费金额**（每 0.0001 元一个刻度）：
- 消费金额只在轮次结束结算 ⇒ 任务进行中 seq 不变 ⇒ 不会反复响
- 下限 1000，覆盖小鲸鱼时代 localStorage 里的旧值（75 量级）
- 当前值 1,720,367，单调递增

### 关于设置入口（不是 bug）
任务结束音的设置在两处，都比较深：
1. **弹出菜单 → 「每轮消耗提示」** —— 开关 + 气泡自动关闭秒数
2. **弹出菜单 → 「音效与提示」→「全局设置」→「每轮消耗」行** —— 选择具体音效
   （选项形如 `frag:cost_a`、`preset:duck:press`、`grp:<组名>`）

你的当前设置 `taskEnd = { on: true, sel: "preset:duck:press" }` 是有效的。


## 5.9.3 —— 修复任务结束音不响（seq 单调性）

### 不是设置问题
你的设置完全正常：`taskEnd.on = true`、`sel = "preset:duck:press"`。
音频端点也全部 200：`sound/press.mp3?set=duck` 6370B、`audio-fragment?id=cost_a` 248876B。

### 真因：seq 不单调
挂件判断是否播放任务结束音的逻辑：
```js
if (d.seq > lastCostSeq) { ... playTaskEndSound() }
```
`lastCostSeq` 存在浏览器 localStorage（小鲸鱼时代已达 **75**）。
而我返回的 seq 是「当天会话数」（今天只有 2）→ `2 < 75` → **永不播放**。

### 修复
seq 改为**全账本累计调用次数**（只增不减）：当前 = **8562**，远大于 75。


## 5.9.2 —— 修复音效（真因：路由路径不匹配）

### 5.9.1 修错了一处
5.9.1 只修了 `audio-fragment` 的 `?id=` 参数，实测**仍无声**。向运行中的宿主探测后发现：
- `/dsh-whale/audio-fragment?id=ya1` → **200, 6370 B** ✓（5.9.1 已修好）
- `/dsh-whale/sound/press.mp3?set=duck` → **404** ✗

### 真因
小鲸鱼注册的是**两条精确路径**：
`/dsh-whale/sound/press.mp3` 与 `/dsh-whale/sound/release.mp3`
而我注册的是 `/dsh-whale/sound`（少了 `/press.mp3`、`/release.mp3`），
所以挂件按压音请求 404 → 静音。

### 修复
注册两条精确路由，并实现音效组解析：
- `duck` → press=Ya1.mp3 / release=Ya2.mp3
- `fx1` → press=D1.mp3 / release=D2.mp3
- 自定义组 → 从 `whale-audio/audio.json` 的 groups 里取片段，回退 duck

### 验证（隔离）
| 请求 | 结果 |
|---|---|
| `sound/press.mp3?set=duck` | 200, 6370 B ✓ |
| `sound/release.mp3?set=duck` | 200, 2976 B ✓ |
| `sound/press.mp3?set=fx1` | 200, 3294 B ✓ |
| `sound/release.mp3?set=fx1` | 200, 4232 B ✓ |
| `audio-fragment?id=ya1` | 200, 6370 B ✓ |


## 5.9.1 —— 修复音效失效

### 问题
重启后挂件菜单/缩放正常，但**没有声音**。

### 根因
我的 `/dsh-whale/audio-fragment` 用 `pathname` 取文件名，
而挂件实际请求的是 `?id=<片段ID>`（如 `?id=cost_a`、`?id=ya1`）。
参数没读到 → 404 → 静音。

### 修复
按小鲸鱼 v0.4.2 的映射表实现 `id` → 文件：
- 内置片段：`cost_a→cost-default.wav`、`ask_a→ask-default.wav`、`approve_a→approve-default.wav`、`end_a→task-end-a.wav`、`exp_orb→minecraft-exp-orb.wav`（audio/wav）
- 预设片段：`ya1→Ya1.mp3`、`ya2→Ya2.mp3`、`d1→D1.mp3`、`d2→D2.mp3`（audio/mpeg）
- 自定义片段：回退用户目录 `whale-audio/<id>.(wav|mp3)`

### 验证
9 个片段全部 HTTP 200，字节数与 assets 文件精确一致：
cost_a 248876 / ask_a 276524 / approve_a 304172 / end_a 319288 / exp_orb 59488 / ya1 6370 / ya2 2976 / d1 3294 / d2 4232


## 5.9.0 —— 小鲸鱼整合完成：24 条路由全部自给

### 已接管全部 /dsh-whale/* 路由（挂件所需 23 条 + sound 前缀）
**数据类（用我的账本）**
- balance.json：官方余额 + 账本今日消费
- usage-records.json：我的 22 天账本、逐日逐模型
- last-turn.json：最后一轮消耗（自动从 session 汇总 token）
- api-models.json：我的模型列表

**配置类（共用原有用户数据文件，不迁移、不丢失）**
- size.json：读写 `.dshw-size.json`，15 个字段全保留，写入有范围校验
- usage-settings.json：存于 storages/unified-quota/whale-usage-settings.json
- roles.json / role-image.png：读 `whale-roles/`
- audio.json / audio-fragment / sound：读 `whale-audio/` 与内置 assets
- bubble.json / bubble-imgs.json / bubble-img.png：读 `.dshw-bubble.json` 与 `whale-bubble-imgs/`
- about / wait / update-check / role-delete / role-pin / bubble-img-upload / balance-adjustments

**静态素材**
- image.png / rua.gif：从本插件 assets/ 服务

### 安全
- 所有路由复用本插件既有的信任栅栏（rejected/denyOrigin）
- 配置写入有范围校验，非法值不落盘
- 用户配置已备份至 `_whale-merge-safety/user-config-backup/`

### 验证
隔离测试 24 条路由全部通过：JSON 路由返回 ok:true；图片 255988B/png、气泡 94643B/gif、音效 6370B/mpeg 均正确。


## 5.8.x —— 小鲸鱼整合（方案 A，进行中）
- 5.8.0: 复制挂件资产 + 注册 /dsh-whale/widget.js 路由
- 5.8.1: 注册 webserver/index-inject 注入行（kind:script + onerror 吞错 + 幂等）
- 5.8.2: 新建 whale-compat.js 数据适配层；balance.json / usage-records.json 数据源切换到本插件账本


## 5.7.0 —— 限时免费模型(×0)不再污染积分换算

### 问题
hy4-flash-free 限时免费（倍率 0），它消耗的 3425 万 token 被算进了
「积分 ↔ token」换算的分子 ⇒ 基准被抬高、换算值失真（实测 tokensPerCredit 偏高 3 倍）。

### 全面审查发现的 4 处 bug
1. **加权分子** `weightedInSpan` 用了 `factor !== null` 判定，×0 被计入（应为 `factor > 0`）；
2. **渠道换算** `tokensPerCredit = tokInSpan / spent`，分子含免费 token；
3. **汇总换算** `totals.tokensPerCredit` 同样含免费 token；
4. **/current 的 channelTokens** 未排除免费，小窗换算被污染。

### 修复原则
**倍率 0 = 限时免费：token 照常计入「用量」，但不进入任何「积分换算」。**
- 模型级新增 `isFree` 标记，前端显示「限时免费」徽章；
- 免费 token 单独统计为 `freeTokensInSpan` / `freeTokens`，小窗显示「免费模型 token（不计积分）」；
- 换算统一用 `baseAt1x = Σ(token×倍率>0) / 实扣`，分子分母同口径；
- 免费模型的 `estTokensPerCredit` / `tokensPerCredit` 直接为 null，不编数。

### 验证（可控数据：×1 用 100M、×0.5 用 200M、×0 免费用 300M，实扣 200）
加权 = 200M（排除 300M 免费）✓ / 基准 = 1M tok/分 ✓ /
渠道换算 = 1M ✓（修复前 3M）/ 汇总换算 = 1M ✓ /
免费模型 isFree=true、无积分估算 ✓ / /current 排除免费 ✓


## 5.6.0 —— 设置项全部接线（消除假开关）+ 每项加说明小字

### 审计结果
逐项追踪每个配置键的真实使用位置，发现 **16 项里 12 项是假开关**：
配置能存、开关能拨，但没有任何渲染分支读取它 —— 拨了完全没效果。

### 按用户选择的方案 C 处理：先删后接
**已接线生效（10 项）**：
| 设置 | 生效位置 |
|---|---|
| 小数位数 | `money()` 全局货币显示（实测 dec2=¥0.12 / dec4=¥0.1235） |
| 默认计价口径 | 明细页 `basis` 初始值 |
| 默认时间范围 | 明细页 `win` 初始值 |
| 费用趋势图 | 控制逐日堆叠图显隐 |
| Token 构成 | 控制「分析」区里的构成块 |
| 官方余额 / 渠道积分 / 小鲸鱼 | 控制侧栏弹层的区块与渠道 tab |
| 侧栏紧凑 | 侧栏卡片只留金额与状态点 |
| 每日软上限 | 原本就生效 |

**已删除的假开关（3 项）**：界面语言（已有 auto 跟随）、未知模型匹配（涉及改价逻辑，风险高）、
明细页合并子代理（需判断会话层级，逻辑复杂）。不再让界面出现拨了没反应的开关。

### 每项加 hint 小字
统一格式「这是什么 + 改了影响哪里」，12 个设置项**全部**有说明（软上限用独立说明块）。
例如：
- 侧栏紧凑 →「侧栏只留金额与状态点，隐藏渠道数/今日金额」
- 费用趋势图 →「关掉后明细页不再显示逐日堆叠柱状图」
- 汇率 →「欧洲央行参考价 · 2026-11-16（含日期与 stale 状态）」

### 机制保障
新增 `sharedCfg` 共享配置：设置页读到/改动的值同步给所有组件，
并在 `apply()` 启动时主动读一次配置 —— 后续新增设置项只要写进 sharedCfg 就能全局生效。


## 5.5.5 —— 移除标题栏重复的关闭按钮

标题栏原有两组按钮叠在一起：
- 新加的窗口控制「– □ ×」；
- 遗留的「⤓ 导出 / ⟳ 刷新 / × 关闭」。

现在只保留：**– 最小化 □ 最大化 × 关闭**，以及**⤓ 导出 / ⟳ 刷新**（无重复关闭）。
渲染验证：窗口按钮 3 个、"关闭/×" 全表仅 1 个。


## 5.5.4 —— 小窗的「1 积分 ≈」改为按倍率换算

### 问题
小窗里 `1 积分 ≈ N tok` 用的是**渠道级** `渠道今日token ÷ 实扣积分`，
所以同一渠道下倍率不同的模型会给出**完全相同的数**（用户实测两个模型一样）。

### 修复
`/current` 返回 `creditModel`，与积分账单同口径计算：
- `基准(1×) = Σ(该渠道今日 token × 各模型倍率) ÷ 实扣积分`
- `模型级 = 基准 ÷ 该模型倍率`
- 倍率从渠道下发的模型展示名解析（`priceFactorFromName`）

小窗现在显示：
- `1 积分 ≈ 166,667 tok · ×0.18`（模型级，带倍率）
- `基准 1× ≈ 30,000 tok/分`
- 倍率未知时退回渠道均值并标注「（渠道均值）」，不再让人误以为所有模型一样。

### 验证（隔离数据）
同渠道 m1(×0.18, 100M) 与 m2(×0.06, 200M)，实扣 1000：
| 模型 | 倍率 | 基准 1× | 1 积分 ≈ |
|---|---|---|---|
| m1 | 0.18 | 30,000 | **166,667 tok** |
| m2 | 0.06 | 30,000 | **500,000 tok** |
两者不同且倍数关系正确（0.18/0.06 = 3 倍）。


## 5.5.3 —— 读对 modelSelection 的真实结构

埋点实测拿到的快照是 **`{ lastUsed, next/pending }`**，不是我以为的 `{provider, model}`：
    snap={"lastUsed":{"provider":"codearts","model":"..."},"next":{"provider":...

所以 `snap.provider` 恒为 undefined ⇒ `getPick` 恒返回 null ⇒ 永远退回「最近调用」，
切换模型自然不跟。

修复：优先读 `pending`（「刚选中、还没发消息」的那个），其次 `next`、`lastUsed`。
并把埋点细节从 90 字符放宽到 200，便于以后核对字段名。


## 5.5.2 —— 修复「切换模型血条不跟」的真正原因

### 埋点实测（从运行中的宿主读回）
    [mini-inject-err] ctx is not defined
    [mini-current] src=live used=codearts/deepseek-v4.1-flash-1017

即：`getPick` 抛错 ⇒ 拿不到下拉选中项 ⇒ 永远退回「最近调用」，所以切模型不动。

### 根因
注册代码在 `registerInto(slots)` 里，而 `ctx` 在 `apply(ctx)` 中 —— 两个函数，
`inject` 回调的闭包**够不到 `ctx`**。此前我"看着像在同一作用域"，实际不是。

### 修复
`registerInto(slots)` → `registerInto(slots, ctx)`，调用点同步传 `ctx`。
补完诊断埋点保留（mini-inject / mini-pick / mini-current），便于后续核对。


## 5.5.0 —— 悬停说明统一用原生 title（彻底移除浮动定位）

### 截图证据
1. 表头的「?」出现**焦点蓝环** —— `tabIndex: 0` 让它可聚焦。
2. 悬停 `token ?` 的提示跑到**屏幕最右侧**、压住无关正文 —— 说明 DSH 组件的 Tooltip
   在本插件的 `position: fixed` + 滚动容器上下文里**定位也是错的**。

即：自研 fixed 定位（5.3.x）与组件 Tooltip（5.3.0/5.4.0）**两条路都不可用**。

### 决定：只用原生 title
- `tip(label, node)` 改为**把 title 写进节点 props**（实现从"渲染气泡"变成"加属性"），
  13 处调用**零改动**即切换；
- 移除 `tabIndex`，不再出现焦点蓝环；
- 删除自研 Tip 层的全部代码（监听、气泡、定位），无任何 `pointerover/pointermove` 逻辑。

### 为什么这是"后续新增功能不出问题"的保证
新增悬停说明只有两种安全写法：
1. 直接给节点加 `title` 属性；
2. 调用 `hint(label)`（返回 `{ title }` 可直接展开到 props）。
两者都由浏览器/系统负责定位与渲染：**不漂移、不抖动、不被 overflow 裁切、不受页面缩放影响**。

已写入源码注释作为约定，禁止再自研定位。

### 全量审计结果
自研 pointerover 监听 ✓已无 / pointermove ✓已无 / Tip 组件 ✓已无 /
help 节点 title ✓ / 额度行 title ✓ / 底部血条 title ✓ / Help 无 tabIndex ✓


## 5.4.0 —— 移除自研悬停气泡（漂移/抖动的根源）

### 先取证，避免再猜
用 DSH 自己的 rev 算法（`framedHash("plugin-artifact", [mtime, ctime, size])`）算出安装文件的
revision，再向运行中的宿主请求：

    /plugins/??dsh-unified-quota/client.js&rev=...  →  200, 147084 字节
    newInline = True, CLIENT_VERSION = 5.3.1

结论：**宿主确实在服务 5.3.1**，不是"没更新"，是那套自研定位逻辑本身有问题。

### 为什么 5.3.1 仍会漂移/抖动
我把定位写成「按 clientX/clientY 用 position:fixed 摆放」，并每次 pointermove 都读写
`offsetWidth` 强制同步布局。在实际运行环境里：
- 任何 **页面缩放/容器变换**都会让 fixed 的坐标与指针错位（离原点越远偏得越多）；
- 每帧强制布局会连带整个聊天 DOM 重排 ⇒ 视觉上像窗口在抖。

无论怎么调参数，这条路都脆。

### 做法：删掉自研层，回到稳定方案
- **彻底移除** `installTipLayer`（含监听与死代码），不再接管 `title`；
- 33 处 `title` 恢复为浏览器原生提示：**不会漂移、不会抖动**；
- 需要主题化提示的地方使用 **DSH 原生 Tooltip**（`tip()`，13 处，含「?」释义标记与概览分段）。

代价：原生提示样式跟随操作系统而非 DSH 主题。若之后要我统一成 DSH 主题样式，
会**逐个站点改用 DSH Tooltip 组件**（由 DSH 自己定位与渲染），不再自研坐标。


## 5.3.1 —— 修复悬停提示位置漂移与窗口抖动

### 根因
气泡只靠样式表 class 提供 `position: fixed`。样式表一旦未生效/被替换，它就退化成
`<body>` 末尾的**普通块元素**：
- `left/top` 对 static 元素无效 ⇒ 气泡跑到页面底部 = **位置漂移**；
- 块元素撑高文档 ⇒ 出现/消失滚动条 = **窗口抖动**。
多平台明细里同样是这个全局层，所以一起出问题。

### 修复
1. **关键样式全部内联**（position/z-index/pointer-events/max-width/left/top/display…），
   不再依赖样式表是否加载；class 只作可选美化。
2. **按指针坐标定位**（`clientX/clientY + 14/18`，越界自动翻转），不再用元素矩形。
3. **消除闪烁**：
   - 气泡 `pointer-events: none`，不会被指针“碰到”；
   - `pointermove` 持续跟随；
   - 离开用 **70ms 延后隐藏**，并在 `pointerover` 时取消；
   - 用 `relatedTarget` 判断「在同一个锚点内部移动」，不隐藏；
   - 切换锚点前先还原上一个的 `title`。
4. 滚动 / 滚轮 / 按下 / 窗口缩放时立即隐藏。

### 单元验证（假 DOM）
内联 position ✓ / 悬停定位 314,418 ✓ / 移动到 514,618 跟随 ✓ /
子元素内移动不闪 ✓ / 离开 70ms 后隐藏且 title 还原 ✓ / 外部节点不接管 ✓ / 滚动隐藏 ✓


## 5.3.0 —— 跟随选中模型 + 小窗补全 + 统一主题化悬停提示

### 1. 切换模型后额度条不跟手（真 bug）
之前只认「`llm/stream` 钩子记录的最近一次真实调用」，所以你在下拉框里换了模型、
还没发消息时，血条仍显示旧模型。现在：
- 客户端读取 `session.projections.faceOf("modelSelection")` 的 `{provider, model}`，
  **每 1.5 秒**比对一次（纯内存读，无网络），一换就重新拉取；
- `/current` 支持显式 `provider`/`model` 参数，优先于内存记录；
- 模型来源三态：`selected`（下拉选中）/ `live`（最近调用）/ `ledger`（账本推断），
  并在小窗里写明。

### 2. 小窗详情补全
新增：**1 积分 ≈ N tok**（渠道今日 token ÷ 实扣积分）、**模型来源**、**上限来源**、
**状态/解禁时间**，并在底部附一条血条。

### 3. 悬停提示统一跟随 DSH 主题
浏览器原生 `title` 是 OS 样式、不跟主题；本插件有 30+ 处 title，
且 i18n 字典里也有同名键（不能批量替换）。
改为**全局 Tip 层接管**：`pointerover` 时把 `title` 摘下存到 `data-uq-tip` 并隐藏原生提示，
用 `--dsw-alias-*` 渲染气泡（跟随明暗主题），离开时还原。
只接管 **本插件节点**（祖先类名含 `uq-`），不影响 DSH 自己的提示。

单元验证：摘除/还原/定位/隐藏/不误接管外部节点 —— 全部通过。


## 5.2.0 —— 额度条移到输入框下方 + 可见性兜底

### 位置修正
`conversation.input.dock` 的契约是「输入卡片**上方**」；
`conversation.composer.dock` 才是「输入卡片**下方**」——正是用户要的位置。
已切换到后者。

### 为什么之前「重启了也看不到」——两个原因都堵上了
1. **组件在没有数据时直接 `return null`**：重启后内存里尚未记录任何调用，
   于是整条不渲染，看起来像没生效。现在**无论如何都渲染**：
   无数据时显示虚线占位 `额度 ┄┄ —`（悬停提示「等待本会话第一次模型调用」），
   一眼就能判断插槽有没有挂上。
2. **模型来源**：原来只认 `llm/stream` 钩子的内存记录；重启后为空。
   现在退回**账本最近一天用量最大的模型**，并标注 `modelSource = "ledger"`。

### 跟随窗口缩放
- 血条本身是 dock 内的行内元素，**布局变化自动跟随**（不需要手工定位）；
- 点击展开的小窗是 fixed + portal，已监听 `resize` / `scroll`（捕获阶段）
  **重新锚定**到血条位置，窗口缩放或聊天滚动时不会飘走。

### 注册失败可追踪
`conversation.composer.dock` 的注册包了 try/catch，失败会打一条
`mini-failed` 信标（`/api/unified-quota/beacon`）。


## 5.1.0 —— 对话输入区额度监控（方案①）

### 新增：输入框上方的额度血条
注册到 `conversation.input.dock`（list 型，scope=session），显示**当前会话最后使用
的模型**的额度：
- **细条 + 百分比**（方案①）：`额度 ▬▬░░░░ 76%`，按**剩余**显示；
- 颜色随剩余：>75% 灰绿 / ≤75% 黄绿 / ≤50% 琥珀 / ≤25% 橙 / ≤10% 暗红；
- **无上限 ⇒ 满血 100%**；**已触顶 ⇒ 0% + 红框**；
- **点击**展开小窗（无悬停浮层）：模型、渠道、上限来源、今日已用/上限、剩余、
  今日积分（含签到 ↑）、触顶解禁时间。

### 数据来源
新增 `/api/unified-quota/current?session=<id>`：
- 模型来自 `llm/stream` 钩子记录下来的「本会话最后一次真实调用」（不猜测）；
- 额度取 `softLimits` 的模型级/渠道级；用量取账本当日该模型 token；
- 积分取余额差累计（消耗与签到赠额分开）。

### 技术说明
`conversation.composer.bar` 是 **single** 槽且已被 DSH 输入框占用，不能插入；
`conversation.input.dock` 才是正确位置（全宽条目、位于输入卡片上方）。
该槽的文档要求**浮动层必须 portal 到 document.body**，否则会被输入卡片裁切 —— 已照做。


## 5.0.0 —— 改成非模态浮窗（不再挡住 DSH）

### 问题
原来是「全屏遮罩 + 居中模态框」：遮罩铺满整个屏幕并吃掉所有点击，
所以打开面板后 **DSH 本体完全不可用**。

### 改法：零尺寸锚 + 独立浮窗
- 删除全屏遮罩（`.uq-sheet` 不再使用），改为 **0×0 的定位锚**（`pointer-events:none`）；
- 面板自己 `position: fixed` 定位、`pointer-events: auto`、`resize: both`；
- 面板以外的区域**完全不拦截** ⇒ 可以一边看明细一边操作 DSH。

### 窗口控制（替代大中小预设）
标题栏右侧改为三枚 Windows 风格按钮：
- **–** 最小化：收起为右下角小条（显示 token 合计，点按还原）；
- **□** 最大化 / 还原：最大化铺满视口（留 8px 边距），再点还原到之前尺寸；
- **×** 关闭。

预设的「小/中/大」已移除；尺寸改由 **拖拽缩放 + ResizeObserver 记忆**（4.7.0 已有）。

### 兼容说明
Web/Electron 插件无法创建带系统边框的原生 OS 窗口（那是主进程的能力），
因此这是「页面内的独立浮窗」：视觉与操作像独立窗口，且**不再阻断 DSH**。


## 4.7.0 —— 修鼠标穿透 + 尺寸记忆 + 视觉独立

### 1. 边缘点击穿透到 DSH 本体
两个原因：
- 遮罩 `z-index:24000` 低于 DSH 自身的浮层，点击落到了后面的界面；
- 遮罩没有截断事件，宿主的全局监听（mousedown / pointerdown）仍会收到。

修复：
- `z-index` 提到 `2147482000`，并显式 `pointer-events:auto`；
- 遮罩对 **mousedown / pointerdown / click / dblclick / contextmenu / wheel** 全部
  `stopPropagation`，弹层内的操作不再冒泡给宿主。

### 2. 自由缩放后不记忆
之前只存了「小/中/大」预设值，原生 `resize:both` 拖出的真实尺寸没被保存。
- 用 `ResizeObserver` 监听对话框，250ms 防抖后把**实际宽高**写入 localStorage（`uq-dlg-box`）；
- 关闭时再存一次；下次打开按实际尺寸恢复（实测恢复 700×520）；
- 点「小/中/大」会**清掉**手动尺寸，回到预设。

### 3. 与 DSH 本体的视觉区分
- 遮罩加深（0.42 → 0.55）+ 更强模糊，清楚表示「这是一个浮在上面的独立面板」；
- 对话框阴影加深加宽（`0 32px 80px`），加一圈暗色外描边；
- 顶部加 2px 品牌色强调线，读起来像独立窗口而不是页面的一部分。


## 4.6.1 —— 修复 /detail 500（rates 声明被误删）

### 根因
4.6.0 里我用「从函数起点切到下一个 function」的方式重写 `realConsumption`，
而 `function ratesOf()` 之前恰好有两行**变量声明**：

    let ratesInstance = null;
    let ratesReady = null;

它们不以 `function ` 开头，于是被整段切掉了 ⇒ `ratesOf()` 引用未声明变量 ⇒
汇率模块抛错 ⇒ `buildDetail` 失败 ⇒ 主表「读取失败：500」。

### 修复
补回两行声明，并把「关键声明清单」纳入校验：
`configStoreInstance / ratesInstance / ratesReady / modelNamesCache / capsCache /
balanceLog / officialCache / detailBuilding` 全部存在。

### 验证
7 条路由全部 200、无告警；codearts 正确分离「消耗 189.05」与「签到 +100」，
基准 45,460 tok/分，模型估算 252,559 tok/分。


## 4.6.0 —— 签到/充值不再抵消消耗 + 版本握手

### 修复：积分增加会把消耗抵消（甚至变负）
之前用「首末样本相减」算消耗。中途签到/充值会让余额变大，于是：
`1000 → 900 → 1500 → 1300` 会被算成 `1000-1300 = -300`（负消耗）。
现在改为**逐段累计**：
- 每段余额**下降**计入 `spent`；
- 每段余额**上升**计入 `granted`（签到/充值/每日重置）。
实测该序列得 `spent = 300`、`granted = 600` —— 与真实一致。
界面上两者分开展示：`300 分 ↑600`（绿色箭头为赠额）。

### 修复：改完却没生效的困惑（版本握手）
页面刷新只热更**客户端**；宿主端改动必须完全重启 DSH。
之前只能靠猜。现在：
- 宿主返回 `build`（`/core`、`/credits`、`/quota`）；
- 客户端有 `CLIENT_VERSION`；
- 两者不一致时，积分账单与额度窗口顶部出现**黄色提示条**：
  「宿主端未更新：请完全退出并重开 DSH。客户端 4.6.0 / 宿主 x.y.z」。

### 说明：之前「1× 基准」没显示就是这个原因
接口字段 `baseAt1x` 为 null，是因为宿主还在跑旧代码；客户端已是新版。


## 4.5.0 —— 渠道 1× 基准 + 模型按倍率估算 + 修复负消耗

### 按用户方案实现「基准 + 倍率」
假设 `credits = token × 倍率 × k`，用实扣反推 k：
- **渠道级基准**：`1× ≈ Σ(token×倍率) / 实扣`，即「1 倍率时 1 积分能换多少 token」，
  **常驻显示在渠道名右侧**（蓝色，例如 `1× ≈ 30,000 tok/分`）。
- **模型级估算**：`基准 ÷ 该模型倍率`（例如 ×0.18 → 166,667 tok/分，×0.06 → 500,000）。
- 全部标注为**估算**，随余额样本累积自动变准。

### 修复：余额上涨被算成负消耗
某些渠道每日重置/充值会让余额**变大**，旧实现直接相减得到 `实扣 -100`。
现在：`delta < 0` ⇒ `spent = 0` 且标记 `refilled + 金额`，界面显示「已重置 +123」，
既不给负值，也不假装有消耗。

### 修复：悬停仍显示旧字段
渠道行 tooltip 之前还用 `c.perCredit`（由倍率估算出的错误值，如 5.85 tok），
现在改为：实扣 / 同窗口 token / 基准 1×。

验证（可控数据）：codearts 用 m1(×0.18) 100M + m2(×0.06) 200M，实扣 1000 ⇒
加权 30M、基准 30,000、m1 估算 166,667、m2 估算 500,000；qodercn 余额上涨 ⇒ 实扣 0 + refilled +123。


## 4.4.0 —— 积分口径对齐同一时间窗（真 bug）

### 问题
「1 积分 ≈ N tok」用了**整个窗口的 token** 除以**采样开始后的余额差**。
两个窗口不同 ⇒ 比值必然错得离谱（实测可控数据下偏大 7.7 倍）。
用户的直觉是对的：「要从零开始才准」。

### 修法
`realConsumption` 返回 `from / fromAt`；积分账单只统计**同一窗口内**的 token
（`c.tokensInSpan`，按日键过滤模型明细），并用它算 `tokensPerCredit`。
- 渠道行右侧：`实扣 521.55 分 · 同窗口 30M tok · 57,521 tok/分`；
- 首卡说明也改为「同一时间窗内的 token ÷ 实扣积分」；
- 汇总 `totals.tokensInSpan` 同口径。

验证（可控数据）：昨天 200M + 今天 30M token，余额 2 小时内 6000→5478.45，
结果 `tokensInSpan = 30M`、`1 积分 ≈ 57,521 tok` —— 旧实现会给 441,000（偏大 7.7 倍）。

### 关于 jet-hub 的「剩余积分 8,013,056.40」
这不是本插件的数据。实测把各渠道余额直接相加 = **8,012,599.86**，
与它显示的 8,013,056.40 基本一致 ⇒ 它把 **ZCode 的 8,000,000 token**
当成积分加进去了（各渠道单位不同：credit / token / USD）。
本插件的额度窗口**逐渠道显示并标注单位，不做跨单位求和**。


## 4.3.0 —— 血条并入主题图层（换主题自动跟随）

### 问题
血条原来用**内联硬编码的深色底**（`rgba(0,0,0,.55)` 渐变 + 外阴影），
在行的卡片背景上看起来像是"另一个图层"贴上去的；而且换主题不会变。

### 改法：血条只用主题变量
把血条搬进样式表（`.uq-hp-frame / .uq-hp-track / .uq-hp-fill / .uq-hp-tick /
.uq-hp-label / .uq-hp-pct / .uq-hp-cap`），表面、描边、轨道、文字**全部**取
`--dsw-alias-*`（共 8 处变量），深色值只作为变量缺失时的兜底：

- 外框背景 → `var(--dsw-alias-bg-layer-1)`（与行卡片同一层）
- 轨道 → `var(--dsw-alias-bg-layer-3)`
- 描边 → `var(--dsw-alias-border-l2)`
- 文字 → `var(--dsw-alias-label-tertiary/secondary)`
- 警示色 → `var(--dsw-alias-state-warn-primary)`

只有**血量语义色**（绿→黄→红）用内联自定义属性 `--hp-a/--hp-b`，
因为它表达的是状态而不是皮肤。

### 结果
- 血条与行卡片在同一视觉层，不再像浮在上面；
- 切换明/暗主题时，血条表面与文字**自动跟随**，无需改代码；
- HBar 函数内已无任何硬编码颜色（0 处）。


## 4.2.0 —— 徽章移出血条 + 配置热更新

### 布局
- 「已触顶」徽章不再占用独立列（它会把血条挤短），改为**并入血条下方的标注行**。
- 网格从 3 列降为 2 列：`150px minmax(0,1fr)`，血条吃掉全部剩余宽度。

### 配置热更新
`ConfigStore.load()` 原来只读一次（`if (this.loaded) return`），外部改 `config.json`
必须重启才生效。现在**按文件 mtime 判断是否重读**：
- 手工编辑 config.json / 外部工具写入 ⇒ 下一次请求即生效，无需重启；
- 有未落盘的本地改动（`dirty`）时仍以内存为准，避免被外部覆盖。

### 已为 CodeBuddy 配置日限额
`softLimits.buddy.models["deepseek-v4.1-flash"].tokens = 200000000`（2 亿 token）。
注意：你在 CodeBuddy 客户端里用掉的部分本插件记录不到（不经 DSH），
所以这里的「已用」只含 DSH 内的调用。


## 4.1.0 —— 定稿：经典分段血条 + 数值移到条下方

用户从 5 种样式中选定 **① classic**，其余 4 种已移除（含工具栏的样式选择器与
localStorage 记忆），只保留一种，界面更干净。

### 布局
- 模型行 = 三列网格：`名字(150px) | 血条+标注(自适应) | 触顶徽章`。
- **数值移到血条下方**（同一列内上下结构）：
  上行（左）`已用 197.17M / 200M tok`，右 `9.0% · 剩 4.36M tok`。
- 修掉一个隐藏问题：行内实际有 4 个子元素而网格只有 3 列 ⇒ 会换行错位；
  现在把「条 + 标注」收进同一列，子元素恰好 3 个。

### 血条（唯一形态）
斜角外框 + 内槽 + 顶部高光 + **每 10% 一格刻痕**；触顶 = 空血 + 红框。


## 4.0.0 —— 修血条长度不一 + 5 种血条样式

### 修复：长条图长短不一
模型行原来是 `display:flex`，名字列 `flex:0 1 auto` 会随文字变长 ⇒ 挤掉血条宽度，
于是「deepseek-v4.1-flash」那条比「hy4free」短。
- 改为 **CSS grid 固定三列**：`150px minmax(160px,1fr) auto`，血条列宽度恒定；
- 名字超长按省略号截断，不再影响条长。

### 新增：5 种血条样式（可现场切换）
额度窗口工具栏多了「血条 1|2|3|4|5」选择器，选择记忆在 localStorage：
1. **classic** 斜角外框 + 每 10% 一格刻痕 + 顶部高光（Dota2 风）
2. **pip** 20 格离散血条，按剩余比例点亮
3. **sharp** 左右斜切端（chevron，LoL 风）
4. **glow** 平滑横向渐变 + 外发光
5. **flat** 极简扁平细条

### 分档收敛（绿 → 红）
剩余 ≤10% 暗红 / ≤25% 橙 / ≤50% 琥珀 / ≤75% 黄绿 / 其余灰绿。
触顶在任何样式下都是**空血**（pip 版本点亮 0 格）。

### 附：对照图
仓库内 `bars-5-styles.svg` 是五种样式的对照图（真实数据渲染）。


## 3.9.1 —— 修复「读取失败 403」

### 根因
我自己写的来源校验对**非回环访问**过于严格：
即使宿主的栅栏（`connection.requestRejection`，认识 `--trusted-host` / `--allow-lan`）
已经放行，插件仍**额外要求**命中内部白名单 —— 于是通过局域网 IP / 反代访问时回 403。

### 修复
1. **栅栏是权威**：宿主说放行就放行（不再二次要求白名单）。
2. **同机兜底**：栅栏不可用时，若请求来源地址与 Host 相同（或回环，含 IPv6 映射
   `::ffff:x.x.x.x`）则放行 —— 浏览器访问本机的局域网 IP 属正常形态，来源地址不可伪造。
3. **跨机仍 fail-closed**：来源不同 + 无白名单 ⇒ 403；跨站（Origin 与 Host 不一致）⇒ 403；
   缺 Host ⇒ 403。
4. **403 自带诊断**：响应体包含 `host / origin / site / hint`，
   不再只显示"读取失败403"而无从判断。

验证矩阵（6 种形态）：回环 200、同机 LAN 200、同机 IPv6 映射 200、
跨机 LAN 403、跨站 403、缺 Host 403。


## 3.9.0 —— 新增渠道 / 新增模型的自适应

### 修复：设置页渠道清单是硬编码的
之前「每日软上限」只列了 9 个写死的渠道 id，新增渠道不会出现。
现在 `GET /config` 返回 `providers`（jet-hub roster ∪ 账本出现过的 provider），
设置页据此动态渲染 —— 新增渠道自动多出一行。

### 已经自适应、无需改动的部分（已隔离验证）
| 能力 | 数据来源 | 新增渠道 | 新增模型 |
|---|---|---|---|
| 额度窗口 | 账本 `byProviderModel` ∪ 已配置上限 | ✓ | ✓ |
| 积分账单 | 同一账本 | ✓ | ✓ |
| 倍率解析 | 渠道下发的模型展示名（`· xN`） | ✓ | ✓ |
| 渠道显示名 | 内置表 + 首字母大写兜底 | ✓ | — |
| 渠道品牌色 | 内置表 + 名字散列兜底 | ✓ | — |
| 上限记录 | `llm/stream` 钩子给的 provider | ✓ | ✓ |

隔离测试：造一个全新渠道 `newco` + 全新模型 `brand-new-model-2027`（倍率 `· x0.35`），
四项断言全过：设置页出现、额度窗口出现、积分账单出现、倍率解析为 0.35。


## 3.8.1 —— 配色收敛 + 积分账单彻底改用实扣

### 配色（不再大绿大红）
血条与状态色统一换成低饱和、偏灰的沉稳色：
- 健康 `#4a7a58 → #6b9a75`（灰绿）
- 偏黄 `#5f7f4a → #7f9e63`
- 警告 `#9a8340 → #bfa557`
- 危险 `#9a5a33 → #bb7748`
- 触顶 `#8c3b3b → #b05252`
状态文字/边框/底色同步柔化（`#e65a5a`→`#b05252`、`#e6a23c`→`#bfa557`）。

### 积分账单：上一版漏改的真实位置
`CreditBillView` 里**渠道行右侧的数字仍取自 `c.factored`**（估算积分），
所以界面上依旧会看到"几十 M"。现已全部替换：
- 渠道行右侧 → `c.spent`（余额差实扣，绿字）
- 渠道行悬停 → 实扣
- 模型行悬停 → 去掉积分，只给 token / 调用数 / 倍率
- 该视图内 `factored` 引用数：**0**


## 3.7.0 —— 游戏风血条 + 触顶空血 + 卡片间隔

### 血条：外框 + 内槽 + 渐变
- 外框（1px 边框 + 圆角 + 内阴影 + 深色轨道），中间是渐变填充，游戏血条观感。
- 颜色随剩余渐进：>70% 绿 → ≤70% 黄绿 → ≤45% 黄 → ≤20% 橙红 → ≤5% 深红。
- 高度 12px（含框 18px），可见度明显提升。

### 关键逻辑修复：已知触顶必须空血
之前「没设软上限 ⇒ 满血」的规则把**已触顶**的模型也画成满血，自相矛盾。
- 触顶 ⇒ **填充 0%、红框、红光**，并显示「已触顶」徽章。
- 无上限但未触顶 ⇒ 满血。
- 有上限 ⇒ 按剩余比例。

### 文案
- 去掉「无上限（按满血显示）」这类解释性文字。
- 右侧改为 **百分比 · 剩余 token**：`1.5% · 2.83M`、`0% · 0`、`100% · ∞`。
- 小于 10% 保留一位小数（1.5% 不会被四舍五入成 2%）。
- 悬停给出完整注释：`已用 197.17M / 200M tok · 剩余 2% (2.83M tok)`。

### 间隔
- 模型行改为**卡片**：左右缩进、圆角、边框、上下 5px 间隔；
- 渠道块间距 10px → 14px；
- 积分账单的模型行同样卡片化。


## 3.6.0 —— 血条重做 + 积分改用日内实扣

### 血条：改为「剩余血量」语义
之前填充 = 已用比例，且无限上限只画一条几乎看不见的虚线 ⇒ 看起来"没有图"。
- 填充 = **剩余**比例：满血 = 100%（绿），消耗后变短；
- 颜色随剩余：≥60% 绿 / ≤60% 黄 / ≤30% 橙 / ≤15% 红；
- **无上限 → 满血绿条**（按你的要求），文字仍写 `xxx / ∞`；
- 条高 11px、内阴影 + 外发光，游戏血条观感；
- **悬停给出完整注释**：`197.17M / 200M tok · 已用 98.5% · 剩余 2.83M`。

### 积分：以日内实扣为主，倍率降级为参考
你实测 codearts 早上 ~6000 → 现在 5478.45（实扣 ~522），而账单显示"几十 M" ——
根源是**倍率不是 credit/token**，用它乘 token 得到的是无意义的大数。
- 余额采样改为**每次读数都存一条**（原来同日只留最后一条 ⇒ 日内差永远算不出）。
  支持 `今天最早样本 → 现在` 的日内差，正好对应你说的那个数。
- 积分账单首卡改为「**实扣（余额差）**」，其次「1 积分 ≈ N tok（校准）」；
  没有两次以上读数时显示 `—` 并说明原因，而不是给一个错的大数。
- 渠道行：`实扣 521.55 · 152K tok/分`（绿字）。
- 模型行：只显示 token 与 `×倍率`（标注"相对计价系数，不等于积分"）。
- 估算积分不再作为主展示。


## 3.5.0 —— 接入真实限流报文（钩子直捕，不再靠扫日志）

用户实测报障原文：
> 本轮运行失败CodeBuddy (腾讯)：模型 deepseek-v4.1-flash 的可用账号均在限流中，
> 最近一个将于 2026/11/16 13:57:30 解禁。

### 新做法：从 llm/stream 钩子直接捕获
不再事后扫日志（那里混着对话正文，必然误报）。`createStreamMeter` 现在多一个
`onError` 回调，在两处上报错误：**建立流时**同步抛出的、以及**流迭代中**抛出的。
拿到错误对象后解析报文并写入 `caps.json` —— 这是权威信号，零误报。

### 解析能力
- 模型：`模型 <id> 的可用账号均在限流中`
- 解禁时刻：`将于 2026/11/16 13:57:30 解禁`（本地时间，精确到秒）
- 渠道名：报文前缀 `CodeBuddy (腾讯)` → 映射回 provider id（`buddy`），
  只挂到该渠道，不会连累同名的其它渠道。
- 兜底：解析不出时间时保守按 6 小时；日志扫描路径也认这个报文。

### 行为
- 上限写入后**只延长不缩短**（幂等），到期自动失效。
- 额度窗口 20 秒刷新时会把 `capped` + 解禁时刻显示出来。


## 3.4.2 —— 修复「已触顶」误报

3.4.0/3.4.1 的日志扫描把**会话里的普通文本**当成了限流证据：
我打印过的测试样例里含 `{"code":429}`、`"isError":true`、`Error 429: Daily free limit...`，
于是 buddy / trae 的正常模型被误标成「已触顶」。

两处收紧：
1. **结构化门控**：只有 `tool/result` 且 `message.isError === true` 的记录参与判定；
   用 `JSON.parse` 逐行解析，而不是在整段文本里搜 `"isError":true`
   （后者必然命中我们自己打印的样例）。
2. **签名收紧**：只认 `Daily free limit reached` / `INFERENCE_CAP_ERROR` /
   `Error 429:` / `HTTP 429` / `额度已用尽` / `rate limit…retry`；
   删除了松散的 `{"code":429}` 规则。

判定器单测 10/10（含 4 个「不该命中」的反例）。


## 3.4.0 —— 血条式额度 / 余额差校准 / 上限监控

### 额度：始终有横条（血条式）
- **不再"没设上限就不画"**：每个模型都画条。
- 已知上限 → 填 `已用/上限`；**未知上限 → 显示 `xxx / ∞`**，条为虚线轨道（表示没有天花板）。
- 颜色按用度：蓝 → ≥80% 黄 → ≥95% 红。
- 撞到上限时模型行变红并出现「已触顶」徽章。

### 修复：额度窗口全是「今日无用量」
账本按本地日写入，若与 UTC+8 日界错开，严格取"今天"会拿到空数据。
- 改为取**账本里最新的一天**，并把实际使用的日期返回给界面（`dayUsed`）。

### 积分账单：改以余额差为准（校准）
倍率估算会与真实扣减严重不符（实测 buddy 估算 2200 万积分，而余额只有 3.5K）。
- 每个渠道新增 `realConsumed`（余额差）与 `impliedFactor`（真实积分/token）。
- 有 ≥2 天余额样本时，渠道行出现绿色徽章「实扣 X · 折合×Y」。
- 顶部首卡在有校准数据时显示「**实扣合计（校准）**」，否则显示「积分合计（估算）」。
- 结论：**倍率只作参考，余额差才是真值**；校准会随天数累积自动生效。

### 上限监控（日志监控 + 到期恢复）
- 新增 `caps.json` + 日志扫描：解析会话日志里的 429 / `Daily free limit reached` /
  `INFERENCE_CAP_ERROR` / 「额度已用尽」/ `retryAfterSeconds` / `resetsAt`。
- 识别出模型后记录 `until`（解析不出恢复时间时保守取 6 小时）。
- 到期自动失效（无需清理）；额度窗口每 20 秒刷新时顺带扫描（60 秒节流）。


## 3.3.0 —— 按草稿区分：额度有条 / 积分账单无条

### 额度窗口（有横条）
渠道（可折叠）→ 模型行，每行的结构对齐草稿：

    CodeBuddy · 1 号                                     3.5K credits
      deepseek v4.1 flash  ▓▓▓▓▓░░░░░  100M / 200M
      hy4free                            0 tok · 未设上限

- 有上限才画条并显示 `已用 / 上限`；没设上限只显示用量（不写上限）。
- 点模型行展开：近 7 天迷你柱 + 上限来源 + 「设上限/改上限」。
- **所有渠道行与模型行都可点**，且都有悬停提示（完整数字、账号数、余额）。

### 积分账单（无横条，只可点开）
- 按草稿去掉所有条形图，只保留数字：积分、token、倍率徽章。
- **点渠道行展开/收起**看该渠道下的模型；每行悬停显示完整明细
  （积分 / token / 调用数 / 倍率或"无倍率标注"）。
- 顶部四个汇总卡也可悬停。

### 全部可交互
渠道、模型、汇总卡、刷新按钮均可点或有悬停提示；渠道默认全部展开，
点一下收起。额度窗口 20 秒自动刷新。


## 3.2.0 —— 修复布局崩塌（两个真 bug）

### bug 1：样式表版本号从未升级
3.0.0 里我用字符串替换把 `CSS_REV` 从 `uq-2.9.3` 改成 `uq-3.0.0`，
但文件里的真实值是 **`uq-2.9.2`** —— **锚点不匹配，替换静默失败**，而我当时
只验证了"写文件成功"就报告成功。结果浏览器一直用 2.9.2 的旧样式表：

- 3.0.0 新增的 `.uq-mrow2 / .uq-cbar / .uq-qhead / .uq-mbar` 全部未生效
  ⇒ 这就是"图呢？条形图呢？"的真正原因（元素在，样式没有）。
- 现已改为 `uq-3.2.0`，并**断言替换前后的值确实不同**再继续（不再只看写盘）。

### bug 2：一次"补括号"把整块 UI 挤成一行
上一版修语法时凭括号计数补了一个 `)`，全局虽然平衡，但**闭合位置错了**：
`.uq-dlg-top` 把工具栏、标签栏、正文、页脚全吞成了自己的子元素。
它本身是 `display:flex`（横向）⇒ 所有区块横排挤在一起，文字逐字换行。
- 已从完好备份恢复，并用**精确锚点**重做三合一标题，未再改动括号层级。
- 已验证：`uq-dlg` 的直接子元素为 5 个平级区块，`uq-dlg-top` 只有 2 个子元素。

### 保留
- 顶部三合一：`[多平台明细 | 积分账单 | 额度窗口]`，同格式、都可点。
- 积分账单/额度窗口与主表**同一账本**（token 合计完全一致）。
- 模型级额度、7 天迷你趋势、就地设上限。


## 3.1.0 —— 三合一视图 + 图形化 + 数据对齐

### 入口：同一个分段控件
「多平台明细」「积分账单」「额度窗口」现在是**同一个分段控件里的三项**，
格式完全一致，「多平台明细」本身也可点击切回。不再需要单独的返回/关闭按钮。

### 数据源统一（修复数字对不上）
之前「积分当量 176.08M」与「积分合计 31.63M」矛盾：前者读本插件账本、
后者读 jet-hub 账本（且后者磁盘上只有 1 天）。现在**两者都用本插件账本**，
与主表完全一致（实测 2.98B token 对得上）。

### 图形化（关键修复：之前条形图看不见）
之前依赖新增的 CSS 类，实测未生效（布局挤成一团、条不可见）。
现改为**关键布局全部用内联样式**，不依赖样式表注入：
- 额度进度条 8px 粗、带渐变；超 95% 红、80% 黄。
- 积分占比条 6px；渠道与模型各一条，颜色用渠道品牌色。
- 渠道名前有品牌色小方块。

### 每个模型都可点开
点模型行展开：**近 7 天迷你柱状图** + 周用量合计 + 「设上限/改上限」。
额度窗口 20 秒自动刷新。


## 3.0.0 —— 入口上移 + 额度/积分细到模型

### 入口位置
「积分账单」「额度窗口」从底部标签栏**移到标题栏右侧**（与窗口尺寸同一行），
点开替换正文区，再点一次收起。底部标签栏恢复为 5 个数据视图。
打开细项时自动隐藏时间/口径/筛选栏与趋势图，避免干扰。

### 额度窗口：细到每个模型
同一渠道下不同模型的日额度**各自独立**（buddy 的 deepseek-v4.1-flash 撞额度时，
同渠道其它模型照样能用），所以额度改为「渠道 → 模型」两级：
- 每个模型单独一行：今日 token / 请求数、自己的上限、进度条、使用率。
- **没设上限的模型不画条**，只显示用量（按用户要求）。
- 上限来源标注「模型」还是「渠道默认」。
- 触顶变红（≥95%）、80% 变黄；渠道名旁出现「有模型触顶」标记。
- 每行有「设上限 / 改上限」按钮，**就地填写并保存**，回车生效。
- 打开后每 **20 秒自动刷新**，撞额度能自动反映。

### 积分账单：细到每个模型
- 每个渠道分组下逐模型列出：积分、token、倍率徽章、占比条。
- 渠道级倍率：单一倍率显示 ×N，多倍率显示「混合×加权值」。
- 进度条按占比着色，颜色用该渠道的品牌色。

### 配置
`softLimits` 支持两层：
`{ provider: { tokens, requests, models: { modelId: { tokens, requests } } } }`。
模型级覆盖渠道级；设置页的渠道级编辑会保留已有的模型级配置（不会被冲掉）。


## 2.9.2 —— 软上限改为可选 + 设置页可编辑

### 修复：软上限默认值会造成每日误报
2.9.0/2.9.1 预置了「社区参考额度」（cline 50 次、codearts 1000 万 token）。
实测本机 codearts 单日消耗 3785 万 token ⇒ 界面立刻显示 **100% 红警**。
这些数字本就是猜测，各渠道真实日额度**都不公开**（Cline 只在 429 里说
"try again in 19h"），预置错误值比不设更糟。
- 默认 `softLimits` 改为**空**：不设就不判断，不产生噪音。
- 设置页新增「每日软上限（可选）」分组：9 个渠道分别填 token 上限与次数上限，
  留 0 = 该渠道不限制。

### 修复：软上限永远不生效
`normalizeConfig` 里 `out.softLimits = {}` 只读已存配置，从不回退默认值。
旧版 config.json 没有该字段 ⇒ 默认值被整体丢弃。已改为回退到默认。

### 新标签页加刷新按钮
「积分账单」与「额度窗口」都加了刷新按钮，撞到上限后可立即拉最新余额与用量。


## 2.9.0 —— 积分账单 / 额度窗口 / 余额反推

### P0 积分账单（新标签页）
- 复用 jet-hub 落盘的 token 账本（日 × 渠道 × 账号 × 模型），**不重复记账**。
- 积分 = token × 模型倍率；给出「1 积分 ≈ 多少 token」。
- 逐渠道列出：token / 倍率 / 积分消耗 / 每积分 token 数。
- 数据源 `~/.dsh/jet-hub/token-ledger.json`（UTC+8 日键，与各渠道结算口径一致）。

### P1 额度窗口（新标签页，不另建界面）
- 与现有明细页共用同一套工具栏与标签交互，只多一个 tab。
- 每渠道显示：余额、今日 token/请求数、软上限进度条。
- **软上限优先取社区已有值**（cline 50 req/日、codearts 1000 万 token/日），
  可在设置页按渠道改；留空即不启用该渠道的上限。
- 达到 80% 变黄、95% 变红。

### P2 余额快照反推真实扣减
- 每次成功读取渠道余额时记一条快照（同 UTC+8 日同渠道覆盖，保留 120 天）。
- 积分账单里的「余额实扣」列 = 窗口首末余额差，用于**验证倍率是否过期**。
- 需要至少两天读数才出值（不足时显示 —）。

### 说明
上游渠道**不返回单次请求的积分扣减**（已核对 buddy/codearts/trae/qoder/zcode 五个适配器），
因此「逐次积分」无法真实获取；本实现用「倍率估算 + 余额差校准」两条腿逼近。

## 2.8.0 —— 柱高比例尺 / 关闭方式 / 拖动 / 状态栏

### 修复：全部渠道下大量柱子压成一条线
线性比例尺遇到「一个峰值 + 一堆小值」会把小柱压到 1~4%（实测峰值 5.41 亿、其余几千万）。
改为**平方根压缩**：排序不变，小值可见。同样数据下最小值从 4% 提到 6~10%，
20% 量级的柱子从 4% 提到 18%。

### 修复：点一下别处就关闭
遮罩层不再响应点击关闭（误触代价太大）。关闭方式改为：
- 右上角 ×
- **底部状态栏的「关闭」按钮**
- Esc 键

### 新增：窗口可拖动
- 按住**标题栏**拖动窗口位置（按钮/下拉不会误触发）。
- 位置记忆到 localStorage，下次打开沿用。
- 想回到居中：清除 uq-dlg-pos 即可（或点尺寸预设重设）。

### 新增：底部状态栏
左边显示当前摘要（天数 · token · 调用次数），右边放关闭按钮。
拖动窗口时也始终可见，不用滚回顶部找关闭。


## 2.7.0 —— 修复柱子消失 / 高度失真 + 对话框可缩放

### 修复：超过 12 天柱子全部消失
`.uq-bar-stack` 的宽度只靠内联的 `barFlex`（仅 `n<=12` 时给），
超过 12 天时该值是 `undefined` ⇒ 柱子宽度为 0，整张图空白。
- CSS 补默认 `flex:1 1 0; min-width:3px`，任何天数都有宽度。

### 修复：套餐渠道下柱子等高（看起来"高度有问题"）
筛选单一套餐渠道时实付恒为 0，所有柱子都被压到最小高度 4%，
视觉上是一排小横线，看不出趋势。
- 当所选口径的值**全为 0** 时，自动回退用 **token 量**作柱高。
- 坐标轴合计文案同步显示为 `合计 xxx tok`，避免误读。

### 新增：对话框可自由缩放
- 右下角可拖拽（`resize:both`），最小 420×320。
- 标题栏新增 小/中/大 三档预设（0.62 / 0.82 / 1.0）。
- 尺寸记忆到 localStorage，下次打开沿用。
- 内容区改为 `flex:1; min-height:0` 自带滚动，缩小时不会切掉内容。


## 2.6.0 —— 趋势图改为渠道堆叠柱

### 变更
- 柱子**不再用单色**，改为**按渠道分段堆叠**：一根柱子内每一段是一个渠道，
  段高 = 该渠道当天用量占比，颜色 = 该渠道品牌色。
- 悬停柱子显示当天总览；悬停**具体某一段**显示该渠道的 token 与占比。
- 图例列出所有出现过的渠道（按总用量降序）。

### 颜色表
DeepSeek 蓝 / Claude 橙 / OpenAI 绿 / Gemini 紫 / TRAE 红 / WorkBuddy 青 /
CodeBuddy 亮蓝 / CodeArts 暗红 / Qoder 墨绿 等；未收录渠道按名字稳定散列。

### 修复（上一版柱子没变色的真正原因）
- `TrendChart` 的调用处**漏传 `dayProviders`**，导致颜色计算恒为 undefined。
- CSS 基础规则里的 `background` 与 `[data-peak]` 覆盖会盖掉内联色，已移除。
- `buddy`（CodeBuddy）与 `workbuddy`（WorkBuddy）原为同色，已分开。


## 2.5.0 —— 指标释义 + 渠道配色 + 倍率同步时效

### 1. 几乎所有指标都有悬停解释
- 新增 `GLOSSARY`（中英双语，集中维护）：余额 / 汇率 / 实付 / 等值 / token / 占比 /
  调用 / 积分当量 / 倍率 / 未知倍率 / 缓存命中率 / 三种口径 / 子代理 / 时间范围。
- 表头与摘要卡上的指标旁出现 `?` 标记，悬停（或键盘聚焦）显示说明。
- 柱状图柱子、渠道行本来就有原生 title，同时保留了数值细节。

### 2. 柱状图按渠道着色
- 新增 `brandColor()`：DeepSeek 蓝、Claude 橙、OpenAI 绿、Gemini 紫、TRAE 红、
  Qoder 青等；未收录渠道按名字稳定散列到一组可区分色。
- 每天用**该日用量最大的渠道**决定柱色；悬停显示该日**各渠道构成**。
- 趋势图下方出现渠道图例（出现过的渠道才有）。
- 后端新增 `dayProviders`（每日 × 每渠道 token），支撑上面的着色与悬停。

### 3. 倍率同步时效（重要澄清）
- jet-hub 每 **20 分钟**重拉上游模型目录；本插件此前**再缓存 10 分钟** ⇒ 最坏 30 分钟才更新。
- 缓存 TTL 从 10 分钟降为 **3 分钟**，最坏延迟由 30 分钟降到约 23 分钟。
- 明细页「刷新」按钮改为**强制同步**：先调 `account.refresh` 让 jet-hub 立刻重拉上游
  （`catalogAt=0`），再取倍率。
- 新增「倍率同步」卡片，显示倍率数据是多久前拿到的。


## 2.4.0 —— 样式生效修复 + 图表与选中态

### 关键修复：新样式一直被旧样式表挡住
`ensureCss()` 原先只判断「是否存在 `style[data-plugin-css=uq]`」就直接 return。
插件升级后**旧样式表还在页面上**，于是新 CSS 永远不注入 —— 这正是「改了半天
选中态还是没变化」的真正原因（不是 CSS 写错，是根本没生效）。
- 现在样式表带版本戳 `uq-2.4.0`，版本不同就整体替换旧的。

### 柱状图
- **数据稀疏时不再拉满**：每根柱限宽 46px 且居中（社区图表库的 `barMaxWidth` 惯例）。
  之前筛选后只剩 2 天数据，两根柱子被拉伸成两块大色板。
- 入场动画：从底部生长（`uqGrow`，0.42s 缓动），柱多时阶梯延迟。
- 空数据日显示为灰色底柱，与有数据日区分。
- 悬停轻微放大。

### 选中态
- 分段控件选中的那项：**品牌蓝实心 + 白字 + 内阴影**（原来依赖 `--dsw-alias-brand-primary`，
  该变量在某些主题下解析不出，fallback 也没能生效）。
- 主标签选中：淡蓝底 + 底部 2px 蓝线。

### 交互
- 渠道行支持**键盘操作**（Enter/空格展开），带 `aria-expanded` 与焦点环。
- 筛选后趋势图上方出现「已筛选」提示条 + 一键「看全部」。
- 尊重系统「减少动画」偏好（`prefers-reduced-motion`）。


## 2.3.1 —— 修复明细页打不开

### 根因
`ProviderTable` 在 2.3.0 为了记住「哪一行展开了」引入了 `useState`，
但它在 `DetailSheet` 里是以**普通函数调用**的形式使用的（`ProviderTable({...})`）。
React 的 hooks 只能在组件渲染期间调用 —— 内联调用会把它的 hook 记到父组件的
hook 链表上，触发 "Invalid hook call"，整个明细页崩溃成空白。

### 修复
- 所有子视图（ProviderTable / ModelTable / DayTable / SessionTable / CallsView /
  TrendChart / Composition / RankList / 各 Section）一律改为 `h(Component, props)`
  的**组件**渲染方式，共 13 处。
- `DetailSheet` 外面包一层 `try/catch`：万一以后再有渲染异常，弹层里会**直接显示
  错误堆栈**，而不是变成一片空白（空白是最难排查的形态）。
- 兜底不用 class 组件，避免加载器里 react 命名空间差异导致模块级求值失败。


## 2.3.0 —— 积分倍率与等效量 + 交互增强

### 积分倍率（新）
- 白嫖渠道按「积分」计费，且每个模型倍率不同（展示名尾部 `· x3.0`）。
- 新增 `lib/meter/credits.js`：倍率解析**移植自 dsh-providers-hub 的 priceFactorFromName**，
  保留了它踩过的三个坑（名字里带 x 的模型不能误判、促销箭头取右侧、免费为 0）。
- 明细页新增「积分当量」列与汇总（积分当量 / 已知倍率模型数 / 未知数 / 倍率档位）。
- 每行模型标出 `×倍率` 徽章；未知倍率的用量单独计出，不混进合计（否则会低估）。

### 交互增强
- **渠道行可展开**：点一下展开该渠道下每个模型的 token / 费用 / 调用数。
- 趋势图柱子可点（预留筛选钩子），峰值柱高亮，悬停看日期/金额/token/次数/占比。
- 趋势图下方显示区间合计。

### 修复
- **柱状图黑块**：`tip()` 包裹破坏了 flex 布局，改用原生 title。
- **选中态看不清**：分段控件选中改为品牌色实心 + 白字；主标签选中加底部描边。
- 对话框宽度用 `calc(100vw - 48px)`，避免窄视口右侧被裁。


## 2.2.0 —— 一目了然的界面 + 每日实时汇率

### 每日实时汇率（ECB 官方）
- 新增 `lib/meter/rates.js`：从欧洲央行参考价（Frankfurter 公开镜像）取 USD→CNY/EUR，每天一次。
- 拉取失败**沿用上次汇率**并标记 stale，绝不置 0（否则历史金额会瞬间归零）。
- 汇率落盘 `~/.dsh/storages/unified-quota/rates.json`，重启后首屏就有值。
- 设置页汇率栏改为「显示实时值 + 一键刷新」，不再手填。

### 金额口径统一
- 新增 `makeMoney()`：账本金额统一走「USD 基准 × 当前汇率」，切币种/换汇率时历史数字同步更新。
- 修复此前「币种符号变了但数值还是旧汇率」的错配。

### 一目了然
- **弹层重做**：顶部三栏概览（官方余额 / 今日实付 / 渠道额度）+ 概览·渠道·费用三个分段，不再需要长滚动。
- **明细页重做**：标题带汇总、工具栏分「时间 / 口径 / 筛选」三组、加载用骨架屏。
- 分析面板（模型榜 / 渠道榜 / Token 构成）收进「分析」开关，默认不占版面。

### 过渡与观感
- 弹层/对话框淡入上浮（`uqPop`），遮罩淡入，柱条宽度缓动。
- 按钮与 Tab 有 hover/active 反馈，开关滑块位移过渡。
- 刷新时图标旋转，数据加载用微光骨架屏。


## 2.1.0 —— 设置页 + 明细页分析能力

### 新增设置页（设置 → 额度与费用）
- 金额与币种：显示币种、美元汇率、小数位、界面语言
- 计价方式：峰谷开关、未知模型匹配（auto/exact）、默认计价口径
- 显示内容：官方余额 / 渠道积分 / 小鲸鱼 / 侧栏紧凑 / 合并子代理
- 明细页：默认时间范围、趋势图开关、Token 构成开关
- 逐项立即保存，配置落 `~/.dsh/storages/unified-quota/config.json`

### 明细页增强
- **筛选**：渠道下拉、模型下拉（联动清除）、一键清除
- **计价口径**：实付 / 实付+等值 / 仅等值，金额列随口径切换并改表头
- **费用趋势图**：逐日柱状，悬停看日期/金额/token
- **Token 构成**：未缓存输入 / 缓存读取 / 缓存写入 / 输出 占比 + 缓存命中率
- **排行**：模型 Top12、渠道 Top12，点击即筛选
- **逐次调用**：最近 300 次调用，展开看五桶与轮次/步骤
- **CSV 导出**：汇总（按渠道×模型）与调用明细两种


## 2.0.0 —— 自足记账（不再依赖 dsh-cost-meter）

### 接管记账
- 新增 `llm/stream` 观察者：每次模型调用结束后按五桶（输入/输出/缓存读/缓存写/推理）记账。
- 自有账本 `~/.dsh/storages/unified-quota/ledger.json`，temp+rename 原子写入，2s 防抖。
- 首次启动把 `dsh-cost-meter` 的历史账本**一次性导入**（只补缺失日期，幂等），之后不再读写它。
- 保留上游两个关键不变量：包装路由改挂上游 provider；同 (会话, provider, model, 五桶指纹) 10s 窗口去重。

### 移除依赖
- `dsh-cost-meter` 已完全卸载：它的界面、配额查询、历史重算、峰谷提醒都不再需要。
- 之前对它 `client.statistics.js` 打的两处防护补丁已还原为原始文件（包已卸载，补丁无意义）。

## 1.6.0 —— 插槽服务等待 + 兜底入口

### 修复
- 导出 `inject = ["slots"]`，让宿主等 slots 服务就绪后再挂载（此前同步取 `ctx.slots` 恒为 undefined，只能走 DOM 兜底）。
- `ensureCss()` 提到 `apply()` 首行，兜底按钮与明细页各自也注入样式（此前兜底按钮是无样式的原生按钮，点击看似无效）。
- 保留 4 秒兜底：slots 不可用时在右下角挂可点击入口。

## 1.5.0 —— 多平台明细

- 会话标题栏 `多平台明细` 入口（与 cost-meter 的「费用明细」并排，刻意不同名）。
- 全屏明细页：按渠道 / 按模型 / 按日 / 按会话四视图，7/30/90 天切换，实付与等值分列。

## 1.0.0 —— 初版

- 侧栏 `额度中心`：DeepSeek 官方余额、Jet Hub 渠道积分（多账号名册自动跟随）、费用总览、小鲸鱼观测。