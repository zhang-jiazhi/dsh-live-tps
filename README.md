# dsh-live-tps — 实时 tok/s 指示器

在 dsh web 的 composer 统计行里，紧邻官方的平均 tok/s 胶囊之后，内联显示一个**始终可见**的实时 token 吞吐胶囊（em dash 占位，直到第一次读数）。不 patch 任何已发布的 bundle。

## 它解决什么

官方统计行只给**整轮平均**速度，长回答里看不出"现在快不快"。本插件给一个 **3 秒时间锚定窗口**的实时读数：卡顿立刻掉、恢复立刻回，适合判断流式输出是否还在推进。

## 行为细节

| 参数 | 值 | 说明 |
|---|---|---|
| 窗口 | 3 s | 时间锚定（不是固定条数），空闲久则样本自然淘汰 |
| 采样间隔 | 200 ms | tick 频率 |
| 平滑 | EMA α=0.4 | 抑制抖动，同时保留趋势响应 |
| 死区 | 3000 ms | 超过该时长无新样本则视为已停，读数归零 |
| 校准 | 分桶测 chars/token | reasoning / output / general 三桶各自统计，取最近 8 个样本 |

**校准为什么要分桶**：reasoning 与正文的 chars/token 差异很大（思考文本更密）。混在一个比值里会让读数系统性偏移。三桶各自测量后按当前 step 的类型取用；样本不足时回落到 general 比值，再不足则用内置 fallback。

**放置策略**：胶囊优先内联进官方的 composer stats 行（紧跟平均 tok/s 胶囊之后）；找不到锚点时回落到 `conversation.composer.dock`。会话切换与卸载都有清理路径，不留残留节点。

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
test/client-smoke.mjs    51 条断言：校准/放置/摘要纯函数
test/client-dom-smoke.mjs 35 项检查：portal 放置、回退链、会话切换不抛
```

```bash
npm test    # 跑两套测试
```

## 注意

DOM 锚点依赖官方 composer 的 stats 行结构。宿主改版导致锚点失效时，胶囊会**回落到 dock**（不消失、不报错），并在控制台留一条 warn。若发现胶囊不在 stats 行内，就是该回落生效了。

## License

MIT
