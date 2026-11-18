# 第三方代码声明（Third-Party Notices）

本插件包含来自以下开源项目的代码，按各自许可证使用与致谢：

## 1. dsh-cost-meter — MIT

- Copyright (c) 2026 dsh-cost-meter contributors
- 来源：https://github.com/Han-1413141/dsh-cost-meter
- 位置：`lib/meter/` 目录（计费路径移植，仅计费所必需的最小闭包）

移植的文件：

| 文件 | 用途 |
| --- | --- |
| `pricing.js` | 模型价目匹配、峰谷档位、成本计算 |
| `provider-prices*.js` / `stepfun-prices.js` | 各家价目快照 |
| `peak-schedule.js` / `price-multiplier.js` | 峰谷时段与价格倍率 |
| `opendesign.js` / `opendesign-prices.js` / `net.js` | OpenDesign 价目与受限网络底座 |
| `usage-dedup.js` | 包装路由重复计费的去重（10s 指纹窗口）|
| `ledger.js` / `stream-meter.js` / `config.js` / `rates.js` / `credits.js` / `credit-bill.js` | 账本、流计量、配置、汇率、倍率解析、积分账单 |

本插件的改动：物化为自有账本（`storages/unified-quota/`）、接管 `llm/stream` 观察者、
去掉 worker 线程与跨进程锁（唯一写入者不需要），并新增历史一次性导入、
容量学习（`learned-caps.json`）、严格模型名匹配、以及与积分/官方价/缓存加权的两口径计价。

## 2. dsh-whale-widget (tuweizhi) — MIT

- 来源：https://github.com/tuweizhi/dsh-whale-widget（v0.4.2，经 DSH 插件市场分发）
- 插件页：https://dsh-plugin.org/plugins/tuweizhi/dsh-whale-widget
- 位置：
  - `assets/whale-widget.js` —— 小鲸鱼挂件本体（角色立绘、余额气泡、每轮消耗提示、
    系统提醒队列、峰谷显示、菜单与设置面板）
  - `lib/whale-compat.js` —— 本插件数据 → 挂件响应格式的适配层（契约来自其
    `balancePayload()` / `usageRecordsPayload()` / `lastTurnPayload()` / `apiModelsPayload()`）
  - `lib/index.js` 内的鲸鱼路由（`/dsh-whale/*` 24 条）—— 挂件宿主 API 的兼容实现
  - `assets/` 内的音效（`*.wav` / `*.mp3`）与图片（`rua.gif` / `bubble-*.gif` / `*.png`）

> ⚠️ 按原仓库 PROVENANCE 声明，`assets/**` 中的部分素材（立绘/音效）不是 MIT 许可，
> 经原作者（用户本人）明确同意后仅限**个人使用**移植，不对外再分发。若需分发本插件包，
> 请先移除 `assets/` 下的立绘与音效，或取得相应素材授权。

本插件的改动：挂件与 unified-quota 账本打通（余额/今日消耗/峰谷/last-turn 都来自自有账本）、
余额与今日消耗按目标币种换算、消耗泡泡期间仍允许币种切换刷新金额行、
新增触发限流时的容量学习与上游解禁时间解析。

## 3. 其它运行时依赖

- React（`react` / `react-dom`）— Meta Platforms / React contributors — MIT
- deepseek-ai DSH（宿主平台）— 版权归其作者，按宿主插件规范调用

以上依赖通过 DSH 运行时提供，不打进本包。

---

如上文声明与本仓库 LICENSE（MIT）冲突，以上游原仓库的许可证条款为准。