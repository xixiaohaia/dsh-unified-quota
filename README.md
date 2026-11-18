# dsh-unified-quota 统一额度中心

一个**自足**的额度与费用面板：不依赖 `dsh-cost-meter`，自己记账。

## 数据来源

| 区块 | 来源 |
| --- | --- |
| DeepSeek 官方余额 | 宿主 `deepseekAccount` 服务（设置→账号与余额同一来源）；回退 API key `/user/balance`；再回退账本快照 |
| 渠道积分（白嫖） | Jet Hub（`dsh-providers-hub`）的 `credits.balances` RPC，走 connection 进程内 owner-peer 桥，凭据不出宿主；名册读 `~/.dsh/jet-hub/state.json` |
| 费用与用量 | **自有账本** `~/.dsh/storages/unified-quota/ledger.json`，由本插件观察 `llm/stream` 自行记账 |
| 小鲸鱼挂件 | **已整合**：挂件本体随本插件分发，余额/消耗/峰谷/last-turn 全部来自自有账本（见 THIRD_PARTY_NOTICES.md） |

## 记账（2.0.0 起）

- 观察宿主 `llm/stream`，每次调用结束按五桶（输入 / 输出 / 缓存读 / 缓存写 / 推理）入账。
- 价格表内置官方价目；峰谷档位按**请求发起时刻**判定。
- 两个关键不变量（移植自 dsh-cost-meter，见 THIRD_PARTY_NOTICES.md）：包装路由的 provider 改挂上游、同指纹 10s 窗口去重。
- 原子写入（temp + rename），读侧永远看到完整 JSON。
- 首次启动把 `dsh-cost-meter` 的历史账本一次性导入，之后不再读写它。

## 费用明细（1.5.0 起，2.0.0 数据源改为自有账本）

会话标题栏 `多平台明细` 打开全屏详细页，可切 7 / 30 / 90 天，四个视图：

| 视图 | 内容 |
| --- | --- |
| 按渠道 | 每渠道 token 与占比、实付 / 等值分列（套餐渠道标「套餐」且等值记 —）、调用数，附逐日 token 柱状条 |
| 按模型 | 跨渠道合并的模型用量与费用，并列出该模型出现在哪些渠道 |
| 按日 | 逐日 token / 实付 / 等值 / 调用 |
| 按会话 | 最近 40 个会话的 token 与费用 |

所有金额区分 **实付**（真金白银）与 **等值**（套餐额度按目录价折算的参考值）。

侧栏底部 `额度中心` 是同一份数据的速览版本。

## 许可

## 致谢与第三方代码

本插件整合/移植了以下开源项目的代码，感谢原作者：

- **[dsh-cost-meter](https://github.com/Han-1413141/dsh-cost-meter)**（MIT）— `lib/meter/` 计费路径的移植来源
- **[dsh-whale-widget](https://github.com/tuweizhi/dsh-whale-widget)**（MIT，by tuweizhi）— `assets/whale-widget.js` 小鲸鱼挂件本体、`lib/whale-compat.js` 数据适配层、`/dsh-whale/*` 路由契约

详细清单见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。
其中 `assets/` 下的部分素材（立绘/音效）按原仓库声明非 MIT 许可，仅限个人使用。
