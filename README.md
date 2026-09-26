# dsh-live-tps — 实时 tok/s 指示器

在 dsh web 的 composer 统计行里，紧邻官方的平均 tok/s 胶囊之后，内联显示一个**始终可见**的实时 token 吞吐胶囊（em dash 占位，直到第一次读数）。不 patch 任何已发布的 bundle。

## 它解决什么

官方统计行只给**整轮平均**速度，长回答里看不出"现在快不快"。本插件给一个 **3 秒时间锚定窗口**的实时读数：卡顿立刻掉、恢复立刻回，适合判断流式输出是否还在推进。

## 行为细节

| 参数 | 值 | 说明 |
|---|---|---|
| 活跃语义 | 0.3.0 | 读数跨 step/停顿保留：活跃时呼吸点+正常亮度；工具执行/停顿切换为暗态（保留数字）；em dash 仅在本会话尚无任何读数时出现。旧版行为（每 step 重置、停顿归零）被用户视为"时有时无"，故改。 |
| 窗口 | 3 s | 时间锚定（不是固定条数），空闲久则样本自然淘汰 |
| 采样间隔 | 200 ms | tick 频率 |
| 平滑 | EMA α=0.4 | 抑制抖动，同时保留趋势响应 |
| 死区 | 3000 ms | 超过该时长无新样本则视为已停，读数归零 |
| 校准 | 分桶测 chars/token | reasoning / output / general 三桶各自统计，只取最近 3 个可校准步骤（0.4.0：换模型 1~3 步内收敛，陈旧桶按深度过期回退 general） |

**校准为什么要分桶**：reasoning 与正文的 chars/token 差异很大（思考文本更密）。混在一个比值里会让读数系统性偏移。三桶各自测量后按当前 step 的类型取用；样本不足时回落到 general 比值，再不足则用内置 fallback。

**放置策略**：胶囊优先内联进官方的 composer stats 行（紧跟平均 tok/s 胶囊之后）；找不到锚点时回落到 `conversation.composer.dock`。会话切换与卸载都有清理路径，不留残留节点。

**读数的三个来源（0.6.1 起）**：

| 来源 | 何时生效 | 依据 | 跨视图 |
|---|---|---|---|
| 3s 窗口瞬时速率 | 流式中，且有新鲜字符增量 | 采样 + 分桶校准换算 | 否（要 `legacy.partial`） |
| 最近已结算步的实测速率 | 步间歇、短步、换模型后首步 | `legacy.nodes` 上的 `usage.outputTokens` 与 `firstTokenTime`/`completedTime` | 否 |
| 宿主 `sessionStats` 投影 | **仅当连一个实测值都没有时** | `decodeTokens / decodeMs`，宿主侧折整本日志 | **是** |

两个客户端源和一个兜底源的分工，按**新鲜度**而不是固定优先级排：窗口采样在流式结束时比该步的 `completedTime` 更新，所以刚结束的一步继续显示刚测到的瞬时值；下一步一落地，它的 `completedTime` 又比旧窗口采样更新，读数随之换到新步——换模型后自然就跟上新模型。

宿主投影降为最后兜底，是 0.6.1 修的一个回归：0.6.0 把它设成了**首选**回落，结果同一会话里只要投影有值，读数就永远是 `decodeTokens/decodeMs`——那正是官方 `StatsPills` 自己显示的数，于是胶囊变成第二份"平均速度"。投影只保留一个不可替代的场景：`legacy` 切片没被材料化时（轨迹页/记忆页 dock 照样渲染，但聊天视图的节点不喂给它），否则那种视图下读数会整个消失。

- 工作步骤非详细（官方 stats 行整行不渲染）时读数仍在；
- 切换模型后读数跟随新模型最近一步，不停留在旧模型速率；
- 流式结束不跳回均值，保留刚测到的瞬时值；
- 只在既没流式过、也没结算过任何可测步的视图里，才显示整日志均值（tooltip 会标注"非实时"）；
- em dash 只出现在本会话挂载后**一个步都还没结算、且还没开始流式**时。

**诊断**：胶囊带 `data-source`（`window` / `settled` / `projection` / `none`）、`data-tps`、`data-nodes`、`data-projection` 四个属性，悬停提示里还带原始数值与来源名。读数看着不对时，先看 `data-source` 就知道是哪个源在供数；显示成均值时那一定是 `projection`，说明客户端两个源都没数据。
定时器只在"还有读数要更新"时挂表：流式中持续跑，追平后自行停止，空闲期不常驻。

## 安装

```bash
dsh plugin --profile web add github:zhang-jiazhi/dsh-live-tps
```

或在 profile 的 `package.json` 里加入 `"@local/dsh-live-tps": "link:<本地目录>"` 后，把包名写进 `dsh.profile.bundles`。

改动生效需要重启 dsh（插件模块在内存中）。

## 结构

```
lib/index.js             宿主半：空 apply + inject[]（仅用于发布 client face）
lib/client.js            客户端半：注册 conversation.composer.dock，内联到 stats 行
cordis.patch.yml         insert 行（不 patch 任何已发布 bundle）
test/client-smoke.mjs    73 条断言：校准/放置/回落/摘要纯函数
test/client-dom-smoke.mjs 64 项检查：portal 放置、回退链、会话切换不抛、三场景读数、空闲不挂表
```

```bash
npm test    # 跑两套测试
```

## 注意

DOM 锚点依赖官方 composer 的 stats 行结构。宿主改版导致锚点失效时，胶囊会**回落到 dock**（不消失、不报错），并在控制台留一条 warn。若发现胶囊不在 stats 行内，就是该回落生效了。

## License

MIT
