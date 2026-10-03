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
		 * `conversation.composer.dock` entry, exactly like the shipped stats
		 * entry used to be. The pill is placed inline immediately after the
		 * average tok/s pill inside the shipped stats row and is always visible.
		 * (2026-10-03, DSH v0.2.1-alpha.1: that single `stats` entry split into
		 * `activity` + `usage`; both markers are supported — see findStatsRow.)
		 * No host-side
		 * bundle patching and no host-side code — the host half of this package
		 * is an empty mount point whose only job is to publish the client face.
		 *
		 * Every reading is a *measured* number. The whole-session average served
		 * by the `sessionStats` projection is deliberately NOT a source: showing
		 * it made this pill a duplicate of the shipped average readout (the
		 * 2026-09-26 regression). Three sources feed the pill instead:
		 *
		 *   - `window` — the in-flight step's character stream, sampled every
		 *     {@link TICK_MS} over a {@link WINDOW_MS} tail and converted through
		 *     the calibrated chars/token ratios. This is the live reading while a
		 *     step decodes.
		 *   - `settled` — the newest settled step's real `usage.outputTokens`
		 *     divided by its decode span (`completedTime - firstTokenTime`), both
		 *     observed on `legacy.nodes` while the client watched the stream.
		 *   - `durable` — the same real measurement recomputed from the session's
		 *     own durable event window (`assistant/message.data.stream` carries
		 *     the provider's per-chunk timeline). This is the source that survives
		 *     a page reload, a session switch, and any non-chat view, where the
		 *     transient live chunks — and therefore `timing.firstTokenTime` — are
		 *     gone. Everything else the pill needs (`usage.outputTokens`, the
		 *     message time) is durable, so the session log itself is the truth.
		 *
		 * Placement and rendering are hardened against the two real defects seen
		 * in the desktop app:
		 *
		 *   - the stats row is located by its shipped marker
		 *     (`data-composer-stats` before DSH v0.2.1-alpha.1, the per-row
		 *     `data-composer-stat="activity"` / `="usage"` after); the old
		 *     `/\btok\/s\b/` text probe silently failed whenever
		 *     the average pill was followed by another pill (`122 tok/s4.2K tok`
		 *     has no word boundary after `s`), leaving the pill in the dock;
		 *   - the pill opts out of DOM-translating plugins (`data-imt-skip`,
		 *     `translate="no"`, `.notranslate`) because those rewrite React's text
		 *     node with `replaceChildren`, after which every React update lands in
		 *     a detached node and the visible label freezes (the 2026-09-26
		 *     "hover shows the number, the label does not" report). A layout-effect
		 *     assertion repairs the visible text if anything else clobbers it.
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
		/** A decode span below this is timer noise, not a rate. */
		const MIN_DECODE_MS = 200;
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
		 * This is the client-observed half of the settled reading: it only exists when
		 * this page watched the step stream, because `timing.firstTokenTime` is stamped
		 * from the transient live chunks. When it is null, {@link durableRate} reads the
		 * same quantity from the session log instead.
		 *
		 * The scan takes the newest qualifying node, which after a model switch is by
		 * construction the new model's own last step — the reading follows the switch
		 * instead of lagging behind the stale calibration.
		 * @param nodes - settled conversation nodes (`legacy.nodes`).
		 * @returns `{ tps, seq, at }` where `at` is the step's `completedTime` in
		 * epoch ms, or null when no settled step carries usable timing.
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
				if (!(decodeMs >= MIN_DECODE_MS)) continue;
				const seq = typeof node.seq === "number" ? node.seq : i;
				return { via: "settled", tps: outputTokens / (decodeMs / 1e3), seq, at: completed };
			}
			return null;
		}
		/**
		 * Whether one stream chunk is the model's first output token.
		 *
		 * Mirrors `@deepseek-ai/dsh-llm`'s `isTokenDelta` (the client bundle cannot
		 * import the host package): non-empty text/reasoning deltas, any non-empty
		 * tool-argument fragment, and every name-bearing tool-call delta.
		 * @param chunk - stream chunk.
		 * @returns true when the chunk carries model output.
		 */
		function isTokenDelta(chunk) {
			if (chunk === null || typeof chunk !== "object") return false;
			switch (chunk.type) {
				case "text-delta":
				case "reasoning-delta": return typeof chunk.text === "string" && chunk.text !== "";
				case "tool-call-delta": return (typeof chunk.argumentsDelta === "string" && chunk.argumentsDelta !== "") || chunk.name !== void 0;
				default: return false;
			}
		}
		/**
		 * Timestamp of the first output token inside one durable assistant stream.
		 *
		 * Mirrors `@deepseek-ai/dsh-llm`'s `assistantStreamFirstTokenTime`: the host
		 * persists each attempt's stream as raw `{ type: 'chunk', time, chunk }`
		 * records plus packed `text-chunks`/`reasoning-chunks`/`tool-call-chunks`
		 * runs whose per-member times are `time0` + cumulative `dt`. This is the
		 * durable replacement for the transient first-token observation.
		 * @param stream - `assistant/message.data.stream`.
		 * @returns epoch ms of the first output token, or null.
		 */
		function firstTokenTimeOf(stream) {
			if (!Array.isArray(stream)) return null;
			for (const record of stream) {
				if (record === null || typeof record !== "object") continue;
				if (record.type === "chunk") {
					if (isTokenDelta(record.chunk) && typeof record.time === "number") return record.time;
					continue;
				}
				const packed = record.type === "text-chunks" || record.type === "reasoning-chunks" ? record.texts : record.type === "tool-call-chunks" ? record.args : null;
				if (!Array.isArray(packed) || typeof record.time0 !== "number") continue;
				let time = record.time0;
				for (let index = 0; index < packed.length; index += 1) {
					if (index > 0) time += Array.isArray(record.dt) && typeof record.dt[index - 1] === "number" ? record.dt[index - 1] : 0;
					const member = packed[index];
					const chunk = record.type === "text-chunks" ? {
						type: "text-delta",
						text: member
					} : record.type === "reasoning-chunks" ? {
						type: "reasoning-delta",
						text: member
					} : {
						type: "tool-call-delta",
						argumentsDelta: member,
						name: typeof record.name === "string" ? record.name : void 0
					};
					if (isTokenDelta(chunk)) return time;
				}
			}
			return null;
		}
		/**
		 * Newest settled step's real rate, recomputed from the session's durable event
		 * window (`binding.eventSource`).
		 *
		 * The window is what the client already holds for the displayed session, so
		 * this costs one reverse scan of a handful of tail entries and no Host RPC.
		 * It is the source that answers after a reload / session switch / on a
		 * non-chat view, where the transient live chunks (and with them
		 * `legacy.nodes[].timing.firstTokenTime`) never reached this page.
		 * @param entries - durable window entries (`{ event }` records).
		 * @returns `{ via, tps, at, seq }`, or null when no settled step is measurable.
		 */
		function durableRateFromEntries(entries) {
			if (!Array.isArray(entries)) return null;
			for (let i = entries.length - 1; i >= 0; i -= 1) {
				const entry = entries[i];
				const event = entry === null || typeof entry !== "object" ? null : entry.event;
				if (event === null || typeof event !== "object" || event.type !== "assistant/message") continue;
				const data = event.data;
				const outputTokens = typeof data?.usage?.outputTokens === "number" ? data.usage.outputTokens : 0;
				if (!(outputTokens > 0)) continue;
				const first = firstTokenTimeOf(data?.stream);
				if (first === null || typeof event.time !== "number") continue;
				const decodeMs = event.time - first;
				if (!(decodeMs >= MIN_DECODE_MS)) continue;
				return {
					via: "durable",
					tps: outputTokens / (decodeMs / 1e3),
					at: event.time,
					seq: typeof event.seq === "number" ? event.seq : i
				};
			}
			return null;
		}
		/**
		 * Read {@link durableRateFromEntries} off the displayed session's live binding.
		 *
		 * `ctx.sessions.binding(sessionId)` is the shipped accessor for the session
		 * generation this dock entry belongs to; an unmaterialized session (or an old
		 * host without the accessor) answers undefined and the reading simply stays
		 * absent — every step in this file is guarded so a host drift can never throw.
		 * @param sessions - the client `sessions` service.
		 * @param sessionId - the dock's session.
		 * @returns `{ via, tps, at, seq }`, or null.
		 */
		function durableRate(sessions, sessionId) {
			if (sessions === null || sessions === void 0 || typeof sessions.binding !== "function" || sessionId === void 0) return null;
			let binding = null;
			try {
				binding = sessions.binding(sessionId);
			} catch {
				return null;
			}
			const source = binding?.eventSource;
			if (source === void 0 || source === null || typeof source.getSnapshot !== "function") return null;
			let snapshot = null;
			try {
				snapshot = source.getSnapshot();
			} catch {
				return null;
			}
			return durableRateFromEntries(snapshot?.entries ?? snapshot?.change?.entries);
		}
		/**
		 * Choose what the pill displays. Only *measured* readings are eligible: the
		 * in-flight window estimate while a step decodes, otherwise the newest settled
		 * step's real rate (client-observed, else durable). When neither exists, the
		 * last window reading — and finally the last reading ever displayed — is kept
		 * rather than zeroed (the 2026-09-26 "keep a visible speed" request); a session
		 * remount starts over. The whole-session average is never substituted, because
		 * that number is the shipped average readout, not this pill's measurement.
		 * @param active - whether a step is streaming right now.
		 * @param windowReading - newest window estimate, or null.
		 * @param exact - newest settled-step measurement (client or durable), or null.
		 * @param previous - last reading this pill displayed, or null.
		 * @returns the reading to display, or null for the em dash.
		 */
		function chooseReading(active, windowReading, exact, previous = null) {
			const windowLive = windowReading !== null && windowReading !== void 0 && windowReading.tps > 0 ? windowReading : null;
			const held = previous !== null && previous !== void 0 && previous.tps > 0 ? previous : null;
			if (active && windowLive !== null) return {
				via: "window",
				tps: windowLive.tps,
				at: windowLive.at
			};
			if (exact !== null && exact !== void 0) return exact;
			if (windowLive !== null) return {
				via: "window",
				tps: windowLive.tps,
				at: windowLive.at
			};
			return held;
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
		 * em dash before the first reading and while no step is measurable.
		 * @param tps - current rate, or null.
		 * @returns display text for the `{throughput}` placeholder.
		 */
		function displayValue(tps) {
			return tps === null || !(tps > 0) ? "\u2014" : formatTps(tps);
		}
		/**
		 * Whether one dock child is the shipped stats row by its text, for hosts
		 * that predate the shipped row marker (`data-composer-stat`, or the older
		 * boolean `data-composer-stats`).
		 *
		 * A plain substring probe is deliberate: the old `/\btok\/s\b/` anchor
		 * missed the real row `… · 122 tok/s4.2K tok · 缓存命中 0%` because there is
		 * no word boundary between `tok/s` and the following `4`, so the pill never
		 * moved inline and the console warning fired on every session.
		 * @param child - one direct dock child.
		 * @returns true when the element carries the average tok/s readout.
		 */
		function isStatsRowText(child) {
			const text = child === null || child === void 0 ? null : child.textContent;
			return typeof text === "string" && text.includes("tok/s");
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
		/** Rebuild the pill's visible content (dot + expected label) after a foreign DOM rewrite. */
		function assertPillLabel(pill, label) {
			if (pill === null || pill === void 0) return;
			if (pill.textContent === label) return;
			pill.textContent = "";
			const dot = document.createElement("span");
			dot.className = "live-tps-dot";
			dot.setAttribute("aria-hidden", "true");
			pill.append(dot, document.createTextNode(label));
		}
		/**
		 * Always-visible live-rate pill for the composer stats row.
		 *
		 * The shipped `StatsPills` row exposes no child slot, so the pill is
		 * rendered through `createPortal` into the row element found among the
		 * dock's direct children (the one carrying the shipped marker — the
		 * activity/usage/legacy order lives in `findStatsRow` — or the average
		 * tok/s text), which puts it right after that pill.
		 * The pill's DOM is owned by React end to end — no manual node moves — so a
		 * session switch (the host deleting the dock or the row in its own commit)
		 * can never hit a commit-phase NotFoundError: React always removes the
		 * portal children from the container it actually placed them in. A
		 * MutationObserver watches the dock only to switch the portal container
		 * when the row appears or disappears; until then (new session, decodeMs=0,
		 * host anchor drift) the portal targets the dock itself as the fallback.
		 * @param props - standard seats: chat hook, projection, session scope,
		 * locale translate, and this entry's own inject (the `sessions` service).
		 * @returns the hidden dock anchor plus the portal that carries the pill.
		 */
		function LiveTpsPill({ useChat, useProjection, t, sessionId, liveTpsSessions }) {
			const partial = useChat((s) => s.legacy.partial);
			const settledNodes = useChat((s) => s.legacy.nodes);
			const sessionStats = typeof useProjection === "function" ? useProjection("sessionStats") : void 0;
			const active = partial !== null && partial !== void 0;
			const counts = active ? blockChars(partial.blocks) : {
				r: -1,
				o: -1
			};
			const ratios = react.useMemo(() => buildCalibration(settledNodes), [settledNodes]);
			const settled = react.useMemo(() => settledRate(settledNodes), [settledNodes]);
			// 日志末步实测：换会话/刷新/非聊天页时，页面上没有任何流式 chunk，
			// timing.firstTokenTime 必为 null；此时只有会话自己的 durable 事件窗口
			// 还带着 assistant/message.data.stream 里的真实首 token 时刻。
			// settledNodes 是"某个 step 已结算"的失效信号：它一变就重扫一次窗口。
			const durable = react.useMemo(() => durableRate(liveTpsSessions, sessionId), [
				liveTpsSessions,
				sessionId,
				settledNodes
			]);
			const ratiosRef = react.useRef(ratios);
			// 已经有过已结算步：stats 行在此时才必然存在。锚点告警用它做门槛，
			// 避免新会话（decodeMs=0、官方行还没渲染）一挂载就报"找不到行"的假警。
			const hasSettledRef = react.useRef(false);
			hasSettledRef.current = settledNodes.some((node) => node !== null && typeof node === "object" && node.kind === "assistant");
			// 最近一次窗口估算（流式中每 tick 更新）；换 step 时清空，避免把上一步
			// 的尾速当成当前步的读数。
			const windowRef = react.useRef(null);
			const samplesRef = react.useRef([]);
			// 已展示过的窗口读数（EMA 平滑的基准）。
			const shownTpsRef = react.useRef(null);
			// 最后一次展示出来的读数：回落源全部消失时留在屏上的就是它（用户诉求
			// "速度要一直看得见"），换会话重挂时随组件一起归零。
			const lastReadingRef = react.useRef(null);
			// 组件自己的稳定立足点：本 entry 的输出直接是 dock（slot outlet 容器）
			// 的子元素，锚点永不搬动，anchor.parentElement 永远是 dock 本身。
			const anchorRef = react.useRef(null);
			// portal 容器（stats 行元素或 dock 元素）保存在 state 里：容器变化时
			// React 自动把 pill 迁移到新容器，迁移过程同样由 React 自己完成。
			const [portalTarget, setPortalTarget] = react.useState(null);
			// 流式 tick 的重渲染计数器：读数本身从 ref + 座位快照现算，不需要额外 state。
			const [, setTick] = react.useState(0);
			const pillRef = react.useRef(null);
			react.useEffect(() => {
				ratiosRef.current = ratios;
			}, [ratios]);
			const stepKey = active ? `${partial.turn}:${partial.step}` : null;
			// 新 step 开始：清掉上一步的窗口样本与读数（数字改由 recent settled 实测供数）。
			react.useEffect(() => {
				windowRef.current = null;
				shownTpsRef.current = null;
				samplesRef.current = [];
			}, [stepKey]);
			react.useEffect(() => {
				if (!active) {
					samplesRef.current = [];
					return;
				}
				const samples = samplesRef.current;
				const last = samples.length > 0 ? samples[samples.length - 1] : null;
				if (last !== null && last.r === counts.r && last.o === counts.o) return;
				samples.push({
					t: Date.now(),
					r: counts.r,
					o: counts.o
				});
				const newest = samples[samples.length - 1].t;
				while (samples.length > 2 && newest - samples[0].t > SAMPLE_TAIL_MS) samples.shift();
			}, [active, counts.r, counts.o]);
			// 只在流式期间挂表：窗口读数按 tick 现算，追平/空闲即停，不在空闲期留 5Hz 空转。
			react.useEffect(() => {
				if (!active) return void 0;
				const timer = setInterval(() => {
					const samples = samplesRef.current;
					if (samples.length === 0) return;
					const now = Date.now();
					const newest = samples[samples.length - 1];
					if (now - newest.t > DEAD_MS) {
						setTick((value) => value + 1);
						return;
					}
					const next = measureRate(samples, ratiosRef.current, now);
					if (next === null) return;
					const smoothed = smooth(shownTpsRef.current, next);
					shownTpsRef.current = smoothed;
					windowRef.current = {
						tps: smoothed,
						at: now
					};
					setTick((value) => value + 1);
				}, TICK_MS);
				return () => clearInterval(timer);
			}, [active]);
			react.useEffect(() => {
				const anchor = anchorRef.current;
				const dock = anchor !== null && anchor.parentElement !== null ? anchor.parentElement : null;
				if (dock === null) return void 0;
				let warned = false;
				/**
				 * 平均 tok/s 所在的宿主统计行。
				 *
				 * 2026-10-03（DSH v0.2.1-alpha.1 破坏性变更）：输入区统计从一整行
				 * `id: "stats"`（布尔标记 `data-composer-stats`）拆成
				 * `id: "activity"`（步数 + 平均 tok/s）与 `id: "usage"`（缓存命中 /
				 * 用量），行标记改成 `data-composer-stat="<id>"`。查找顺序：
				 * activity（平均 tok/s 所在行，本 pill 的落点）→ usage（compact
				 * 模式下 activity 可能整行返回 null，仍要落进可见的统计行）→ 旧布尔
				 * 标记（< 0.2.1 宿主）→ 文本兜底。
				 */
				const findStatsRow = () => {
					let marked = null;
					if (typeof dock.querySelector === "function") {
						marked = dock.querySelector('[data-composer-stat="activity"]')
							?? dock.querySelector('[data-composer-stat="usage"]')
							?? dock.querySelector("[data-composer-stats]");
					}
					if (marked !== null) return marked;
					for (const child of dock.children) {
						// 跳过锚点与 pill 自己：pill 文案里也含 "tok/s"，兜底状态下它是
						// dock 的子元素，不跳过会把 portal 容器解析成 pill 自己（自嵌套）。
						if (child === anchor) continue;
						if (typeof child.getAttribute === "function" && child.getAttribute("data-composer-live-tps") !== null) continue;
						if (isStatsRowText(child)) return child;
					}
					return null;
				};
				const sync = () => {
					if (!dock.isConnected) return; // dock 已被移除（会话切换），组件即将卸载
					const row = findStatsRow();
					// 找不到行时兜底 portal 进 dock 原位（保持 pill 永远可见）。
					const next = row !== null ? row : dock;
					setPortalTarget((prev) => prev === next ? prev : next);
					if (row === null && !warned && hasSettledRef.current && typeof console !== "undefined") {
						// 宿主锚点漂移：明确告警而不是静默退化成"永远留在 dock 里"。
						// 新会话尚无已结算步时官方行本来就不存在（decodeMs=0），
						// 那不是漂移，所以用 hasSettledRef 当门槛。
						warned = true;
						console.warn("[live-tps] 已有已结算步却找不到 composer stats 行（宿主锚点可能已变更），pill 暂留在 dock 中。");
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
			const reading = chooseReading(active, windowRef.current, settled ?? durable, lastReadingRef.current);
			const tps = reading === null ? null : reading.tps;
			const source = reading === null ? "none" : reading.via;
			react.useEffect(() => {
				if (reading !== null && reading !== void 0) lastReadingRef.current = reading;
			}, [reading]);
			const live = active && windowRef.current !== null && Date.now() - windowRef.current.at <= DEAD_MS;
			const label = t("liveTokensPerSecond", { throughput: displayValue(tps) });
			// 外来 DOM 改写的自愈：翻译类插件会整段 replaceChildren 掉 pill 的文本
			// 节点，React 记录的旧文本节点从此脱离文档，之后每次 state 更新都写进
			// 幽灵节点、可见文案永远停在第一次扫描时的样子（实测 689/792 个采样里
			// 文案与 data-tps 不一致）。每次渲染后核对一次可见文案，不符就重建。
			// eslint-disable-next-line react-hooks/exhaustive-deps -- 每次渲染都要核对
			react.useLayoutEffect(() => {
				assertPillLabel(pillRef.current, label);
			});
			// 悬停提示带上读数来源与原始数值：读数与官方平均不一致时，一眼能看出
			// 是窗口瞬时、最近一步实测、还是日志末步实测；读不出数时直接告出数据源实况。
			const sourceLabel = source === "window" ? t("liveSource.window") : source === "durable" ? t("liveSource.durable") : source === "settled" ? t("liveSource.settled") : "";
			const hint = tps === null ? t("liveNoReading", {
				projection: sessionStats === void 0 ? t("liveProjection.absent") : `${String(sessionStats.steps ?? 0)} ${t("liveSteps")}`,
				nodes: String(settledNodes.length),
				active: active ? t("liveActive.yes") : t("liveActive.no")
			}) : t("liveWithSource", {
				base: label,
				value: formatTps(tps),
				source: sourceLabel
			});
			const pill = jsxRuntime.jsxs("span", {
				ref: pillRef,
				className: "live-tps-pill notranslate",
				"data-composer-live-tps": true,
				// 机器生成的读数不该被翻译插件改写：data-imt-skip 是本机沉浸式
				// 翻译插件的跳过契约，translate/notranslate 是通用约定，三者都写。
				"data-imt-skip": "",
				translate: "no",
				"data-live": live ? "true" : "false",
				"data-source": source,
				"data-tps": tps === null ? "" : formatTps(tps),
				"data-nodes": String(settledNodes.length),
				"data-projection": sessionStats === void 0 ? "absent" : "present",
				"data-durable": durable === null ? "absent" : "present",
				title: hint,
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
		/**
		 * Required client services: the slot registry, the locale registry, and the
		 * session controller's `sessions` accessor (durable per-step timing).
		 */
		const inject = [
			"slots",
			"locale",
			"sessions"
		];
		/**
		 * Register the dictionaries and the composer-dock entry.
		 * @param ctx - client root context.
		 */
		function apply(ctx) {
			// 会话作用域的标准座位之外，本 entry 需要 sessions（日志末步实测）：
			// 通过 inject 面传给组件，避免组件去猜服务位置。
			const sessions = ctx.sessions;
			ctx.effect(() => ctx.locale.register(NS, {
				zh: {
					"liveTokensPerSecond": "实时 {throughput} tok/s",
					"liveWithSource": "{base}（{value} tok/s · {source}）",
					"liveSource.window": "3s 窗口估算",
					"liveSource.settled": "最近一步实测",
					"liveSource.durable": "日志末步实测",
					"liveNoReading": "实时 tok/s：本会话尚无可读数（会话投影：{projection} · 已结算步骤：{nodes} · 流式中：{active}）",
					"liveProjection.absent": "未提供",
					"liveSteps": "步",
					"liveActive.yes": "是",
					"liveActive.no": "否"
				},
				en: {
					"liveTokensPerSecond": "live {throughput} tok/s",
					"liveWithSource": "{base} ({value} tok/s · {source})",
					"liveSource.window": "3s window estimate",
					"liveSource.settled": "latest settled step (observed)",
					"liveSource.durable": "latest settled step (session log)",
					"liveNoReading": "live tok/s: no reading yet (session stats: {projection} · settled steps: {nodes} · streaming: {active})",
					"liveProjection.absent": "not served",
					"liveSteps": "steps",
					"liveActive.yes": "yes",
					"liveActive.no": "no"
				}
			}), "live-tps: dictionaries");
			ctx.effect(() => ctx.slots.inject("conversation.composer.dock", () => ctx.slots.register({
				name: "conversation.composer.dock",
				id: "live-tps",
				// 2026-10-03：宿主统计行拆成 activity(order 0) 与 usage(order 1) 两个
				// 入口，本入口排在两者之后，避免与 usage 撞 order 导致落点顺序不定。
				order: 2,
				locale: NS,
				inject: () => ({ liveTpsSessions: sessions })
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
			MIN_DECODE_MS,
			CAL_LIMIT,
			FALLBACK_REASONING,
			FALLBACK_OUTPUT,
			blockChars,
			ratioOf,
			buildCalibration,
			measureRate,
			isTokenDelta,
			firstTokenTimeOf,
			durableRateFromEntries,
			durableRate,
			chooseReading,
			settledRate,
			isStatsRowText,
			smooth,
			formatTps,
			displayValue,
			assertPillLabel,
			LiveTpsPill
		};
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});