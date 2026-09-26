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
		/** Settled steps kept per bucket for calibration. */
		const CAL_LIMIT = 8;
		/**
		 * 最深回看多少个节点参与校准：桶未满也到此为止，避免长会话下
		 * 对全历史做 O(N) 扫描（纯输出会话旧阈值 24 永远达不到，见下）。
		 */
		const CAL_SCAN_LIMIT = 200;
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
		 * @param nodes - settled conversation nodes.
		 * @returns `{ r, o }` reasoning/output chars per token.
		 */
		function buildCalibration(nodes) {
			const r = [];
			const o = [];
			const g = [];
			if (Array.isArray(nodes)) {
				// 两个停机条件：回看深度到顶（CAL_SCAN_LIMIT），或三个桶都不可能
				// 再增长（全部到 CAL_LIMIT）。旧条件 `r+o+g < CAL_LIMIT*3` 在纯输出
				// 会话里永远达不到（r/o 恒空，总数卡在 8），等于全历史 O(N) 扫描。
				for (let i = nodes.length - 1, scanned = 0; i >= 0 && scanned < CAL_SCAN_LIMIT && (r.length < CAL_LIMIT || o.length < CAL_LIMIT || g.length < CAL_LIMIT); i -= 1, scanned += 1) {
					const node = nodes[i];
					if (node === null || typeof node !== "object" || node.kind !== "assistant" || node.usage === void 0 || node.usage === null) continue;
					const out = typeof node.usage.outputTokens === "number" ? node.usage.outputTokens : 0;
					if (!(out > 0)) continue;
					const counts = blockChars(node.blocks);
					if (counts.r + counts.o === 0) continue;
					const reasoningTokens = typeof node.usage.reasoningTokens === "number" ? node.usage.reasoningTokens : 0;
					if (reasoningTokens > 0 && counts.r > 0 && out > reasoningTokens) {
						if (r.length < CAL_LIMIT) r.push([counts.r, reasoningTokens]);
						// output 桶必须要求 counts.o > 0：纯 reasoning 的 step（只有思考、
						// 没有正文）会 push [0, N]，ratioOf 累加时 chars 加 0 而 tokens 加 N，
						// 比值被稀释且仍落在 [0.3,12] 合法区间（不触发 fallback）。实测
						// 7 个纯 reasoning step 让 chars/token 从 4.0 掉到 2.78，tok/s 偏高
						// 约 1.44 倍。reasoning 桶已有 counts.r > 0 门槛，这里补对称的。
						if (counts.o > 0 && o.length < CAL_LIMIT) o.push([counts.o, out - reasoningTokens]);
					} else if (g.length < CAL_LIMIT) {
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
			const ratiosRef = react.useRef(ratios);
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
			react.useEffect(() => {
				ratiosRef.current = ratios;
			}, [ratios]);
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
			react.useEffect(() => {
				if (!active) return void 0;
				const timer = setInterval(() => {
					const samples = samplesRef.current;
					if (samples.length === 0) return;
					const now = Date.now();
					const newest = samples[samples.length - 1];
					if (now - newest.t > DEAD_MS) {
						// 停顿（工具执行/步间空档）：保留读数，只把状态切到非活跃。
						setLive(false);
						return;
					}
					const next = measureRate(samples, ratiosRef.current, now);
					if (next === null) return;
					setLive(true);
					setTps((prev) => smooth(prev, next));
				}, TICK_MS);
				return () => clearInterval(timer);
			}, [active]);
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
