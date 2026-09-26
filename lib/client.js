window.__ModuleLoader__.load({
	id: "@local/dsh-live-tps",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const react = require("react");
		const jsxRuntime = require("react/jsx-runtime");
		const reactDom = require("react-dom");
		/**
		 * Live token throughput (tok/s) for the web composer dock.
		 *
		 * Native 0.1.5 implementation: a client plugin registering one extra
		 * `conversation.composer.dock` entry, exactly like the shipped `stats`
		 * entry. The pill is then placed inline immediately after the average
		 * tok/s pill inside the shipped stats row and is always visible. No
		 * host-side bundle patching — the host half of this package is an empty
		 * mount point whose only job is to publish the client face.
		 *
		 * Data comes from the session-standard seats the renderer materializes
		 * for every session-scoped slot component:
		 *
		 *   - `useChat((s) => s.legacy.partial)` — the in-flight assistant step
		 *     (`{ turn, step, blocks }`), null between steps;
		 *   - `useChat((s) => s.legacy.nodes)` — settled nodes used to calibrate
		 *     chars/token per content bucket (reasoning vs. output);
		 *   - `t` — the locale seat, because the registration declares a locale
		 *     namespace.
		 *
		 * Algorithm (carried over from the retired StatsLine patch v7):
		 *
		 *   1. Calibrate chars/token from the most recent settled assistant nodes
		 *      whose `usage.outputTokens` describes the same step as its blocks:
		 *      a separate reasoning ratio when `reasoningTokens` is present, and a
		 *      shared general ratio otherwise. Values outside [0.3, 12] fall back.
		 *   2. Sample the partial's reasoning/output character counts whenever they
		 *      change, keep a 3.5s tail, and tick every 200ms over a 3s window whose
		 *      right edge is NOW — so an intra-step stall lowers the reading.
		 *   3. Convert the window delta through the calibrated ratios and smooth the
		 *      result with a 0.4 EMA; drop changes below 0.5 tok/s.
		 *   4. Reset the readout to an em dash the moment a new streaming step
		 *      starts, so the previous step's tail rate is never shown as current;
		 *      the pill itself is always visible and keeps the final reading after
		 *      the step settles.
		 */
		const NS = "live-tps";
		/** Averaging window (ms): long enough to ignore one hiccup, short enough to move. */
		const WINDOW_MS = 3000;
		/** Tick period (ms) while decoding. */
		const TICK_MS = 200;
		/** No character delta for this long means the stream is gone, not slow. */
		const DEAD_MS = 3000;
		/** Samples are pruned to this tail; the tick window is the real average span. */
		const SAMPLE_TAIL_MS = 3500;
		/** EMA smoothing factor for the displayed rate. */
		const EMA_ALPHA = 0.4;
		/** Minimum change (tok/s) that moves the displayed number. */
		const EMA_EPSILON = 0.5;
		/**
		 * Settled steps kept for calibration — 既是每桶样本上限，也是"新鲜度"：
		 * 桶内样本必须来自最近 CAL_LIMIT 个可校准节点（按深度过期）。
		 * 2026-09-26 由 8 改 3：用户频繁切换模型（glm/grok/step/deepseek…），
		 * 各家 tokenizer 密度与 usage 词表（是否报 reasoningTokens）都不同，
		 * 8 样本深桶会让旧模型比值长期污染新模型的换算，且不报 reasoningTokens
		 * 的模型永远不会刷新 r/o 桶。限 3 + 深度过期后，换模型 1~3 步内收敛。
		 */
		const CAL_LIMIT = 3;
		/**
		 * 最深回看多少个"可校准节点"（0.1.x 语义：节点访问数上限，防病态历史
		 * 全量扫描；新鲜度规则由 CAL_LIMIT 单独约束）。
		 */
		const CAL_SCAN_LIMIT = 500;
		/** Fallback chars/token before any settled step has been measured. */
		const FALLBACK_REASONING = 4.5;
		const FALLBACK_OUTPUT = 2.5;
		/**
		 * Count the partial's reasoning and output characters by block kind.
		 * @param blocks - assistant content blocks of the in-flight step.
		 * @returns `{ r, o }` character counts (reasoning, output).
		 */
		function blockChars(blocks) {
			let r = 0;
			let o = 0;
			if (!Array.isArray(blocks)) return { r, o };
			for (const b of blocks) {
				if (b === null || typeof b !== "object") continue;
				if (b.kind === "reasoning" && typeof b.text === "string") r += b.text.length;
				else if (b.kind === "text" && typeof b.text === "string") o += b.text.length;
				else if (b.kind === "tool-call" && typeof b.argsRaw === "string") o += b.argsRaw.length;
			}
			return { r, o };
		}
		/**
		 * Sum `[chars, tokens]` pairs into a plausible chars/token ratio.
		 * @param pairs - calibration pairs.
		 * @returns the ratio, or NaN when unusable.
		 */
		function ratioOf(pairs) {
			let chars = 0;
			let tokens = 0;
			for (const pair of pairs) {
				chars += pair[0];
				tokens += pair[1];
			}
			const value = tokens > 0 ? chars / tokens : NaN;
			return Number.isFinite(value) && value >= 0.3 && value <= 12 ? value : NaN;
		}
		/**
		 * Build chars/token ratios from the most recent settled assistant nodes.
		 *
		 * 2026-09-26 起按"新鲜度"收敛：只有最近 CAL_LIMIT 个可校准节点参与
		 * （深度 depth = 已扫过的可校准节点数-1 ≥ CAL_LIMIT 即停止）。这使校准
		 * 比值始终反映当前模型——换模型后最多 CAL_LIMIT 步即收敛，且不同家
		 * usage 词表差异（是否报 reasoningTokens）造成的陈旧桶会自动过期回退
		 * 到 general，不会被旧模型样本永久占据。
		 * @param nodes - settled conversation nodes.
		 * @returns `{ r, o }` reasoning/output chars per token.
		 */
		function buildCalibration(nodes) {
			const r = [];
			const o = [];
			const g = [];
			if (Array.isArray(nodes)) {
				// 停机条件：回看深度到 CAL_LIMIT（更老的节点按新鲜度规则不允许
				// 进桶），或访问节点数到 CAL_SCAN_LIMIT（防"几乎没有可校准节点"的
				// 病态历史做全量扫描）。深度只数"可校准节点"，无 usage/无字符的
				// 节点跳过不占深度，但计入访问数。
				for (let i = nodes.length - 1, depth = 0, visits = 0; i >= 0 && depth < CAL_LIMIT && visits < CAL_SCAN_LIMIT; i -= 1, visits += 1) {
					const node = nodes[i];
					if (node === null || typeof node !== "object" || node.kind !== "assistant" || node.usage === void 0 || node.usage === null) continue;
					const out = typeof node.usage.outputTokens === "number" ? node.usage.outputTokens : 0;
					if (!(out > 0)) continue;
					const counts = blockChars(node.blocks);
					if (counts.r + counts.o === 0) continue;
					depth += 1;
					const reasoningTokens = typeof node.usage.reasoningTokens === "number" ? node.usage.reasoningTokens : 0;
					if (reasoningTokens > 0 && counts.r > 0 && out > reasoningTokens) {
						r.push([counts.r, reasoningTokens]);
						// output 桶必须要求 counts.o > 0：纯 reasoning 的 step（只有思考、
						// 没有正文）会 push [0, N]，ratioOf 累加时 chars 加 0 而 tokens 加 N，
						// 比值被稀释且仍落在 [0.3,12] 合法区间（不触发 fallback）。实测
						// 7 个纯 reasoning step 让 chars/token 从 4.0 掉到 2.78，tok/s 偏高
						// 约 1.44 倍。reasoning 桶已有 counts.r > 0 门槛，这里补对称的。
						if (counts.o > 0) o.push([counts.o, out - reasoningTokens]);
					} else {
						g.push([counts.r + counts.o, out]);
					}
				}
			}
			const general = ratioOf(g);
			const reasoning = ratioOf(r);
			const output = ratioOf(o);
			const fallbackReasoning = Number.isFinite(general) ? general : FALLBACK_REASONING;
			const fallbackOutput = Number.isFinite(general) ? general : FALLBACK_OUTPUT;
			return {
				r: Number.isFinite(reasoning) ? reasoning : fallbackReasoning,
				o: Number.isFinite(output) ? output : fallbackOutput
			};
		}
		/**
		 * Measure the windowed rate over a character-count sample tail.
		 *
		 * The window's right edge is `now`, so idle time inside the window counts
		 * against the rate exactly as it counts against the step average. A tail
		 * whose newest sample is older than {@link DEAD_MS} yields null.
		 * @param samples - `{ t, r, o }` samples in ascending time order.
		 * @param ratios - `{ r, o }` chars per token.
		 * @param now - measurement instant (epoch ms).
		 * @returns tokens per second, or null when no stable reading exists.
		 */
		function measureRate(samples, ratios, now) {
			if (!Array.isArray(samples) || samples.length === 0) return null;
			const newest = samples[samples.length - 1];
			if (now - newest.t > DEAD_MS) return null;
			let firstIndex = 0;
			const cutoff = now - WINDOW_MS;
			while (firstIndex < samples.length - 1 && samples[firstIndex].t < cutoff) firstIndex += 1;
			const first = samples[firstIndex];
			const dt = (now - first.t) / 1000;
			if (!(dt >= 0.5)) return null;
			const tokens = (newest.r - first.r) / ratios.r + (newest.o - first.o) / ratios.o;
			if (!(tokens > 0)) return null;
			return tokens / dt;
		}
		/**
		 * Real throughput of the newest settled assistant step, read off the durable
		 * per-step timing the host already publishes on `legacy.nodes`.
		 *
		 * Why this exists: the windowed character estimate only ever answers while a
		 * step is in flight, and it needs `dt >= 0.5` plus a fresh character delta
		 * before it will produce a number. Three real windows therefore stayed on the
		 * em dash forever — (a) a step shorter than the 0.5s floor, (b) a step whose
		 * provider reports no streamed characters at all, and (c) the first steps
		 * after a model switch, whose old-model calibration makes the estimate
		 * unreliable until three of the new model's steps have settled. Every one of
		 * those is a step the host *has* already settled with real
		 * `usage.outputTokens` and real `firstTokenTime`/`completedTime`, so the
		 * measured rate is available even when the live estimate is not.
		 *
		 * The scan takes the newest qualifying node, which after a model switch is by
		 * construction the new model's own last step — the reading follows the switch
		 * instead of lagging behind the stale calibration.
		 * @param nodes - settled conversation nodes (`legacy.nodes`).
		 * @returns `{ tps, seq }`, or null when no settled step carries usable timing.
		 */
		function settledRate(nodes) {
			if (!Array.isArray(nodes)) return null;
			for (let i = nodes.length - 1; i >= 0; i -= 1) {
				const node = nodes[i];
				if (node === null || typeof node !== "object" || node.kind !== "assistant") continue;
				const usage = node.usage;
				const outputTokens = typeof usage?.outputTokens === "number" ? usage.outputTokens : 0;
				if (!(outputTokens > 0)) continue;
				const timing = node.timing;
				const first = typeof timing?.firstTokenTime === "number" ? timing.firstTokenTime : null;
				const completed = typeof timing?.completedTime === "number" ? timing.completedTime : null;
				if (first === null || completed === null) continue;
				const decodeMs = completed - first;
				// A sub-200ms decode span is timer noise, not a rate; keep scanning
				// for an older step with a measurable one instead of showing a spike.
				if (!(decodeMs >= 200)) continue;
				const seq = typeof node.seq === "number" ? node.seq : i;
				return { tps: outputTokens / (decodeMs / 1e3), seq };
			}
			return null;
		}
		/**
		 * Smooth a new reading into the displayed value; tiny moves keep the old one.
		 * @param previous - displayed value, or null before the first reading.
		 * @param next - fresh reading.
		 * @returns the value to display.
		 */
		function smooth(previous, next) {
			if (previous === null) return next;
			const ema = previous + (next - previous) * EMA_ALPHA;
			return Math.abs(ema - previous) < EMA_EPSILON ? previous : ema;
		}
		/**
		 * Compact throughput text: integers from 10 up, one decimal below.
		 * @param tps - tokens per second.
		 * @returns display string.
		 */
		function formatTps(tps) {
			const clamped = Math.max(0, tps);
			return clamped >= 10 ? String(Math.round(clamped)) : String(Math.round(clamped * 10) / 10);
		}
		/**
		 * Display text for the always-visible pill: the formatted rate, or an
		 * em dash before the first reading and while a step is being re-measured.
		 * @param tps - current rate, or null.
		 * @returns display text for the `{throughput}` placeholder.
		 */
		function displayValue(tps) {
			return tps === null || !(tps > 0) ? "\u2014" : formatTps(tps);
		}
		/** Composer-dock pill copy for the live readout. */
		const css = ".live-tps-pill{box-sizing:border-box;max-width:100%;color:var(--dsw-alias-label-tertiary);font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));font-variant-numeric:tabular-nums;white-space:nowrap;align-items:center;align-self:center;gap:6px;padding:1px 8px;display:inline-flex;border-radius:24px}.live-tps-pill:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}.live-tps-dot{flex:none;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-business-primary);animation:live-tps-pulse 1.2s ease-in-out infinite}@keyframes live-tps-pulse{0%,100%{opacity:1}50%{opacity:.25}}.live-tps-pill[data-live=\"false\"]{opacity:.55}.live-tps-pill[data-live=\"false\"] .live-tps-dot{animation:none;opacity:.4}";
		const cssTagId = "@local/dsh-live-tps/composer-dock.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(cssTagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@local/dsh-live-tps";
			tag.dataset.pluginCss = cssTagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		/**
		 * Always-visible live-rate pill for the composer stats row.
		 *
		 * The shipped `StatsPills` row exposes no child slot, so the pill is
		 * rendered through `createPortal` into the row element found among the
		 * dock's direct children (the one carrying the average tok/s readout),
		 * which puts it right after that pill. The pill's DOM is owned by React
		 * end to end — no manual node moves — so a session switch (the host
		 * deleting the dock or the row in its own commit) can never hit a
		 * commit-phase NotFoundError: React always removes the portal children
		 * from the container it actually placed them in. A MutationObserver
		 * watches the dock only to switch the portal container when the row
		 * appears or disappears; until then (new session, decodeMs=0, host
		 * anchor drift) the portal targets the dock itself as the fallback.
		 * @param props - standard seats: chat hook, locale translate.
		 * @returns the hidden dock anchor plus the portal that carries the pill.
		 */
		function LiveTpsPill({ useChat, t }) {
			const partial = useChat((s) => s.legacy.partial);
			const settledNodes = useChat((s) => s.legacy.nodes);
			const active = partial !== null && partial !== void 0;
			const counts = active ? blockChars(partial.blocks) : { r: -1, o: -1 };
			const ratios = react.useMemo(() => buildCalibration(settledNodes), [settledNodes]);
			// 最近一个已结算步的实测速率：流式读数不可得时的回落源。它与
			// transcriptView / performanceUsage 档位无关，因此"工作步骤非详细"
			// （官方 stats 行整行 return null）时读数依然有来源。
			const settled = react.useMemo(() => settledRate(settledNodes), [settledNodes]);
			const ratiosRef = react.useRef(ratios);
			const settledRef = react.useRef(settled);
			const samplesRef = react.useRef([]);
			// 组件自己的稳定立足点：本 entry 的输出直接是 dock（slot outlet 容器）
			// 的子元素，锚点永不搬动，anchor.parentElement 永远是 dock 本身。
			const anchorRef = react.useRef(null);
			// portal 容器（stats 行元素或 dock 元素）保存在 state 里：容器变化时
			// React 自动把 pill 迁移到新容器，迁移过程同样由 React 自己完成。
			const [portalTarget, setPortalTarget] = react.useState(null);
			const [tps, setTps] = react.useState(null);
			// 2026-09-26：读数不再随新 step/停顿归零（用户预期"持续可见的速度"）。
			// live 仅表示"此刻正在产出 token"：驱动呼吸点与文字明暗；数字保留最近
			// 一次测量值，em dash 只出现在本会话挂载后尚无任何读数时。
			const [live, setLive] = react.useState(false);
			// 已经展示的读数（与 tps state 同步的 ref）：用来判断"是否还有事可做"，
			// 无事可做时不挂定时器，也不触发多余重渲染。
			const shownTpsRef = react.useRef(null);
			// 最新已结算步的标识：变化即唤醒轮询去更新回落读数。
			const settledKey = settled === null ? -1 : settled.seq;
			react.useEffect(() => {
				ratiosRef.current = ratios;
			}, [ratios]);
			react.useEffect(() => {
				settledRef.current = settled;
			}, [settled]);
			react.useEffect(() => {
				if (!active) {
					samplesRef.current = [];
					setLive(false);
					return;
				}
				const samples = samplesRef.current;
				const last = samples.length > 0 ? samples[samples.length - 1] : null;
				if (last !== null && last.r === counts.r && last.o === counts.o) return;
				samples.push({ t: Date.now(), r: counts.r, o: counts.o });
				const newest = samples[samples.length - 1].t;
				while (samples.length > 2 && newest - samples[0].t > SAMPLE_TAIL_MS) samples.shift();
			}, [active, counts.r, counts.o]);
			// 轮询不止在流式中跑：步结算后流式样本被清空，但"回落读数"要随之更新。
			// 依赖 settledKey 保证新步落地时重新挂一次表；追平后自行停止，不在
			// 空闲期留 5Hz 空转（v1 的教训：空闲 setInterval 常驻烧 CPU）。
			react.useEffect(() => {
				const needsWork = () => active || settledRef.current !== null && shownTpsRef.current !== settledRef.current.tps;
				// 没有读数可更新（流式未开始、且已展示的正是最新结算步读数）
				// 时干脆不挂表：本会话首个步落地会因 settledKey 变化重新进来。
				if (!needsWork()) return void 0;
				let timer = setInterval(() => {
					const now = Date.now();
					const samples = samplesRef.current;
					if (active && samples.length > 0) {
						const newest = samples[samples.length - 1];
						if (now - newest.t <= DEAD_MS) {
							const next = measureRate(samples, ratiosRef.current, now);
							if (next !== null) {
								shownTpsRef.current = smooth(shownTpsRef.current, next);
								setTps(shownTpsRef.current);
								setLive(true);
								return;
							}
						}
						// 流式中即使这一刻量不出（3s 窗未满、起步 dt<0.5）也要继续
						// 跑：样本还在逐帧累积，停表等于整个流式期再也出不了数。
						return;
					}
					// 非流式（步间歇、停顿过 DEAD_MS、短步、换模型后首步）：把数字
					// 换成最近一个已结算步的实测速率，保留读数不归零。
					const reading = settledRef.current;
					if (reading !== null) {
						setLive(false);
						if (shownTpsRef.current !== reading.tps) {
							shownTpsRef.current = reading.tps;
							setTps(reading.tps);
						}
					}
					// 空闲态追平即停表；下一次有新步落地时由 settledKey 变化唤醒。
					if (!active) {
						clearInterval(timer);
						timer = null;
					}
				}, TICK_MS);
				return () => {
					if (timer !== null) clearInterval(timer);
				};
			}, [active, settledKey]);
			react.useEffect(() => {
				const anchor = anchorRef.current;
				const dock = anchor !== null && anchor.parentElement !== null ? anchor.parentElement : null;
				if (dock === null) return void 0;
				let warned = false;
				/** 平均 tok/s pill 所在的那一行：dock 直接子元素里含 "tok/s" 文本的元素。 */
				const findStatsRow = () => {
					for (const child of dock.children) {
						// 跳过锚点与 pill 自己：pill 文案里也含 "tok/s"，兜底状态下它是
						// dock 的子元素，不跳过会把 portal 容器解析成 pill 自己（自嵌套）。
						if (child === anchor) continue;
						if (typeof child.getAttribute === "function" && child.getAttribute("data-composer-live-tps") !== null) continue;
						if (/\btok\/s\b/.test(child.textContent || "")) return child;
					}
					return null;
				};
				const sync = () => {
					if (!dock.isConnected) return; // dock 已被移除（会话切换），组件即将卸载
					const row = findStatsRow();
					// 找不到行时兜底 portal 进 dock 原位（保持 pill 永远可见）。
					const next = row !== null ? row : dock;
					setPortalTarget((prev) => (prev === next ? prev : next));
					if (row === null && !warned && typeof console !== "undefined") {
						// 宿主锚点漂移：明确告警而不是静默退化成"永远留在 dock 里"。
						// 注意 stats 行存在但内部没有 "tok/s" 文本（decodeMs=0 的会话
						// 连平均速度都不渲染）时同样不内联，走 pill 暂留 dock 的兜底。
						warned = true;
						console.warn("[live-tps] 找不到含 tok/s 文本的 composer stats 行（宿主锚点可能已变更，或该会话 decodeMs=0 尚无平均速度），pill 暂留在 dock 中。");
					}
				};
				sync();
				// observer 只负责发现"行出现/消失/被替换"来切换 portal 容器；
				// pill 的 DOM 完全由 React 通过 portal 管理，这里不做任何手动搬动。
				const observer = new MutationObserver(sync);
				observer.observe(dock, {
					childList: true,
					subtree: true
				});
				return () => observer.disconnect();
			}, []);
			const label = t("liveTokensPerSecond", { throughput: displayValue(tps) });
			const pill = jsxRuntime.jsxs("span", {
				className: "live-tps-pill",
				"data-composer-live-tps": true,
				"data-live": live ? "true" : "false",
				title: label,
				children: [jsxRuntime.jsx("span", {
					className: "live-tps-dot",
					"aria-hidden": true
				}), label]
			});
			return [jsxRuntime.jsx("span", {
				ref: anchorRef,
				hidden: true,
				"aria-hidden": true
			}, "live-tps-anchor"), portalTarget === null ? null : reactDom.createPortal(pill, portalTarget, "live-tps-pill")];
		}
		/** Required client services: the slot registry and the locale registry. */
		const inject = ["slots", "locale"];
		/**
		 * Register the dictionaries and the composer-dock entry.
		 * @param ctx - client root context.
		 */
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, {
				zh: { "liveTokensPerSecond": "\u5b9e\u65f6 {throughput} tok/s" },
				en: { "liveTokensPerSecond": "live {throughput} tok/s" }
			}), "live-tps: dictionaries");
			ctx.effect(() => ctx.slots.inject("conversation.composer.dock", () => ctx.slots.register({
				name: "conversation.composer.dock",
				id: "live-tps",
				order: 1,
				locale: NS
			}, LiveTpsPill)), "live-tps: composer dock");
		}
		/** Pure helpers exposed for the package smoke test. */
		exports.__internals = {
			NS,
			WINDOW_MS,
			TICK_MS,
			DEAD_MS,
			SAMPLE_TAIL_MS,
			EMA_ALPHA,
			EMA_EPSILON,
			CAL_LIMIT,
			FALLBACK_REASONING,
			FALLBACK_OUTPUT,
			blockChars,
			ratioOf,
			buildCalibration,
			measureRate,
			settledRate,
			smooth,
			formatTps,
			displayValue,
			LiveTpsPill
		};
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
