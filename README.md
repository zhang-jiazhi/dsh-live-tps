# dsh-live-tps — 实时 tok/s 指示器

在 dsh web 的 composer 统计行里，紧邻官方的平均 tok/s 胶囊之后，内联显示一个**始终可见**的实时 token 吞吐胶囊（em dash 占位，直到第一次读数）。不 patch 任何已发布的 bundle，宿主半保持空 apply。

## 它解决什么

官方统计行只给**整轮平均**速度，长回答里看不出"现在快不快"。本插件显示**实测**读数：流式期间给 3 秒窗口估算，每一步结算后立即换成该步的真实速率（`usage.outputTokens / decodeMs`）。整会话平均**永远不作为读数**——那是官方胶囊自己的数，抄过来只会变成第二份"平均速度"。

## 三个读数来源（0.7.0）

| 来源 (`data-source`) | 何时生效 | 依据 | 跨视图/刷新 |
|---|---|---|---|
| `window` | 流式中，且有新鲜字符增量 | 客户端采样 + 分桶校准换算（3 s 锚定窗口） | 否（要 `legacy.partial`） |
| `settled` | 步结算后（本页看过流） | `legacy.nodes` 的 `usage.outputTokens` ÷ (`completedTime` − `firstTokenTime`) | 否（`firstTokenTime` 来自转瞬即逝的 live chunk） |
| `durable` | 步结算后（本页没看过流：刷新 / 换会话 / 非聊天页） | 会话自己的 durable 事件窗口里 `assistant/message.data.stream` 的首 token 时刻 | **是** |

选择规则：流式中优先 `window`；否则用最近的结算实测（`settled` 优先，缺失时 `durable`）；再没有就保留上一次读数；都没有才 em dash。绝不回落到整会话平均。

- **`durable` 为什么存在**：`timing.firstTokenTime` 由客户端在流式时从 live chunk 上打戳，页面刷新 / 切换会话 / 打开非聊天视图后必然为 null——0.6.x 此时会退到 `sessionStats` 投影，也就是官方均值。宿主把每个 attempt 的完整回放流（`stream`，含每 chunk 时间戳）都持久化在 `assistant/message` 里，客户端的事件窗口本来就带着它；插件从 `ctx.sessions.binding(sessionId).eventSource` 反向扫出最后一条可测消息，即可用**同一条**公式还原真实速率，不需要任何宿主改动、额外 RPC 或新投影。
- **`window` 是估算**：chars/token 比值按最近 3 个可校准步自校准（换模型 1~3 步内收敛）；会话第一步没有样本时用内置 fallback，误差可达 ±30%，该步结算后读数立刻跳到实测值，下一步起校准生效。
- **短步不算速率**：decode 跨度 < 200 ms 视为计时噪声，继续向前找可测步。

## 行为细节

| 参数 | 值 | 说明 |
|---|---|---|
| 活跃语义 | 0.3.0 | 读数跨 step/停顿保留：活跃时呼吸点+正常亮度；工具执行/停顿切换为暗态（保留数字）；em dash 仅在本会话尚无任何读数时出现。 |
| 窗口 | 3 s | 时间锚定（不是固定条数），窗口右沿是 `now`，窗口内空闲同样计入分母 |
| 采样间隔 | 200 ms | tick 频率；只在流式期间挂表，空闲不常驻 |
| 平滑 | EMA α=0.4 | 抑制抖动，同时保留趋势响应 |
| 死区 | 3000 ms | 超过该时长无新样本则视为已停（读数保留、切暗态） |
| 校准 | 分桶测 chars/token | reasoning / output / general 三桶各自统计，只取最近 3 个可校准步骤（换模型 1~3 步内收敛，陈旧桶按深度过期回退 general） |

**校准为什么要分桶**：reasoning 与正文的 chars/token 差异很大（思考文本更密）。混在一个比值里会让读数系统性偏移。三桶各自测量后按当前 step 的类型取用；样本不足时回落到 general 比值，再不足则用内置 fallback。

## 两个真实故障的根因（2026-09-26）

1. **胶囊永远内联不进去 + 每次会话都告警**：锚点用 `/\btok\/s\b/` 匹配官方 stats 行文案，而真实文案是 `1 轮 1 步·122 tok/s4.2K tok·缓存命中 0%`——`tok/s` 的 `s` 紧跟 token 数的 `4`，没有词边界，正则永远不匹配，pill 就留在 dock 里。现在优先用宿主自带的标记（2026-10-03 起：`data-composer-stat="activity"` → `="usage"` → 旧布尔 `data-composer-stats`），文本兜底改成子串匹配；告警也只在"已经有已结算步却仍找不到行"（真的锚点漂移）时打印一次，新会话不再误报。

2. **标签数字冻死、只有悬停才看到**（用户原话："有时鼠标放上面下面会显示速度"）：沉浸式翻译等插件把 pill 当成可翻译块，整段 `replaceChildren` 掉子节点，React 记录的文本节点从此脱离文档——之后每次状态更新都写进幽灵节点，可见文案永远停在第一次扫描时的样子（实测 792 个采样里 689 个与 `data-tps` 不一致）。现在 pill 显式退出翻译（`data-imt-skip` / `translate="no"` / `.notranslate`），并在每次渲染后核验可见文案、不符就按状态重建（对任何第三方 DOM 改写都自愈）。

**放置策略**：胶囊优先内联进官方的 composer stats 行（紧跟平均 tok/s 胶囊之后）；找不到锚点时回落到 `conversation.composer.dock`。
**2026-10-03（DSH v0.2.1-alpha.1 破坏性变更）**：输入区统计从一整行 `id: "stats"` 拆成 `id: "activity"`（步数 + 平均 tok/s）与 `id: "usage"`（缓存命中 / 用量），行标记由布尔 `data-composer-stats` 改为 `data-composer-stat="<id>"`。本插件按 activity → usage → 旧布尔标记 的顺序锚定，旧宿主行为不变；自身 dock 入口 order 从 1 调到 2，避免与新的 `usage` 撞号。会话切换与卸载都有清理路径，不留残留节点。

## 诊断

胶囊属性：`data-source`（`window` / `settled` / `durable` / `none`）、`data-tps`、`data-live`、`data-nodes`、`data-projection`、`data-durable`、`data-imt-skip`；悬停提示带原始数值与来源名（"3s 窗口估算" / "最近一步实测" / "日志末步实测"），读不出数时直接列出数据源实况。

## 安装

```bash
dsh plugin --profile web add github:zhang-jiazhi/dsh-live-tps
```

或在 profile 的 `package.json` 里加入 `"@local/dsh-live-tps": "link:<本地目录>"` 后，把包名写进 `dsh.profile.bundles`。

客户端半改动在页面刷新后即生效（bundle 带 rev 哈希）；宿主半（空 apply）不变。

## 结构

```
lib/index.js               宿主半：空 apply + inject[]（仅用于发布 client face）
lib/client.js              客户端半：注册 conversation.composer.dock，内联到 stats 行
cordis.patch.yml           insert 行（不 patch 任何已发布 bundle）
test/client-smoke.mjs      99 条断言：校准/窗口/实测/日志源/锚点/选择纯函数
test/client-dom-smoke.mjs  80 项检查：portal 放置、锚点迁移、翻译自愈、三源读数、空闲不挂表
```

```bash
npm test    # 跑两套测试
```

### 真实桌面版复测配方

```bash
# 1. 用宿主自己的浏览器会话凭据开一个无头副本（与桌面窗口同一 host、同一 client bundle）
#    cookie 由 .credentials.yaml 里的 client-connection/browser-session secret 按授权域名签出
# 2. 新建会话 → 发一条会流式输出的消息
# 3. 采样 [data-composer-live-tps] 的 text/data-*，与官方 [data-composer-stat] 对比（旧宿主为 [data-composer-stats]）
# 4. 真值：解码该会话的 session.v4.jsonl.zstd，对每条 assistant/message 算
#    usage.outputTokens ÷ (event.time − assistantStreamFirstTokenTime(stream))
```

## 注意

DOM 锚点依赖官方 composer 的 stats 行结构。宿主改版导致锚点失效时，胶囊会**回落到 dock**（不消失、不报错），并在控制台留一条 warn。若发现胶囊不在 stats 行内，就是该回落生效了。

当前支持两代标记：DSH <= v0.2.0-rc.2 的布尔 `data-composer-stats`（单行 `id: "stats"`），与 v0.2.1-alpha.1 起拆分后的 `data-composer-stat="activity"` / `="usage"`。

## License

MIT