/**
 * Smoke test for the native @local/dsh-live-tps client half.
 *
 * The browser bundle calls `window.__ModuleLoader__.load(...)`; this test shims
 * that loader, evaluates the bundle, then exercises the pure measurement
 * helpers and the slot/locale registration with test doubles. Run with:
 *
 *   node test/client-smoke.mjs
 */
import nodeAssert from "node:assert/strict";
/** Counted assert facade so the summary line can never drift from the assertions. */
let assertionCount = 0;
const countCall = (name) => (...args) => { assertionCount += 1; return nodeAssert[name](...args); };
const assert = new Proxy({}, { get: (_target, name) => countCall(name) });

/** Captured module-loader spec from the bundle. */
let captured = null;
globalThis.window = {
	__ModuleLoader__: {
		load(spec) {
			captured = spec;
		}
	}
};

await import("../lib/client.js");
assert.ok(captured !== null, "bundle calls window.__ModuleLoader__.load");
assert.equal(captured.id, "@local/dsh-live-tps");
assert.equal(typeof captured.factory, "function");

const reactStub = {
	memo: (component) => component,
	useMemo: (compute) => compute(),
	useRef: (value) => ({ current: value }),
	useState: (value) => [value, () => {}],
	useEffect: () => {},
	useLayoutEffect: () => {}
};
const jsxStub = {
	jsx: (type, props) => ({ type, props }),
	jsxs: (type, props) => ({ type, props })
};
const reactDomStub = {
	createPortal: (children, container, key) => ({ __portal: true, children, container, key })
};
const requireShim = (id) => {
	if (id === "react") return reactStub;
	if (id === "react/jsx-runtime") return jsxStub;
	if (id === "react-dom") return reactDomStub;
	throw new Error(`unexpected require("${id}")`);
};

const face = captured.factory(requireShim);
const { NS, blockChars, ratioOf, buildCalibration, measureRate, settledRate, isTokenDelta, firstTokenTimeOf, durableRateFromEntries, chooseReading, isStatsRowText, smooth, formatTps, displayValue, LiveTpsPill } = face.__internals;

/* ---------------- block character accounting ---------------- */
assert.deepEqual(blockChars([
	{ kind: "reasoning", text: "abcd" },
	{ kind: "text", text: "hello" },
	{ kind: "tool-call", argsRaw: '{"x":1}' },
	{ kind: "text", text: 42 },
	{ kind: "other", text: "ignored" }
]), { r: 4, o: 12 });
assert.deepEqual(blockChars(null), { r: 0, o: 0 });

/* ---------------- ratio plausibility gate ---------------- */
assert.equal(ratioOf([[10, 2]]), 5);
assert.ok(Number.isNaN(ratioOf([[100, 1]])));
assert.ok(Number.isNaN(ratioOf([])));

/* ---------------- per-bucket calibration ---------------- */
const calibrated = buildCalibration([
	{ kind: "user", blocks: [] },
	{
		kind: "assistant",
		usage: { outputTokens: 12, reasoningTokens: 4 },
		blocks: [
			{ kind: "reasoning", text: "aaaaaaaa" },
			{ kind: "text", text: "bbbb" }
		]
	}
]);
assert.equal(calibrated.r, 2);
assert.equal(calibrated.o, 0.5);
const generalOnly = buildCalibration([
	{
		kind: "assistant",
		usage: { outputTokens: 10 },
		blocks: [{ kind: "text", text: "abcdefghij" }]
	}
]);
assert.equal(generalOnly.r, 1);
assert.equal(generalOnly.o, 1);
assert.deepEqual(buildCalibration([]), { r: 4.5, o: 2.5 });
// 回看深度上限（0.4.0 语义）：桶只收最近 CAL_LIMIT=3 个可校准节点，
// 300 个同质节点里只取最新 3 个（比值不变，但扫描有界）。
const manyGeneral = buildCalibration(Array.from({ length: 300 }, () => ({
	kind: "assistant",
	usage: { outputTokens: 2 },
	blocks: [{ kind: "text", text: "abcdef" }]
})));
assert.deepEqual(manyGeneral, { r: 3, o: 3 });
// 新鲜度语义：唯一可校准节点即使位于 249 个不可校准节点（无字符）之后，
// 也作为"最新测量"参与校准（它是当前唯一的真实比值来源），不再因扫描
// 上限被跳过；访问上限 CAL_SCAN_LIMIT 只防病态历史的全量扫描成本。
const deepNode = { kind: "assistant", usage: { outputTokens: 1 }, blocks: [{ kind: "text", text: "x" }] };
const onlyEligible = buildCalibration([deepNode, ...Array.from({ length: 300 }, () => ({
	kind: "assistant",
	usage: { outputTokens: 3 },
	blocks: []
}))]);
assert.deepEqual(onlyEligible, { r: 1, o: 1 }, "the only eligible node is the freshest measurement and is used");
// 访问上限兜底：可校准节点被 400+ 个不可校准节点掩埋时放弃（回落 fallback）。
const buried = buildCalibration([deepNode, ...Array.from({ length: 700 }, () => ({
	kind: "assistant",
	usage: { outputTokens: 3 },
	blocks: []
}))]);
assert.deepEqual(buried, { r: 4.5, o: 2.5 }, "eligible nodes beyond the visit budget fall back");
// 模型切换收敛：旧模型（有 reasoningTokens，ratio r=2/o=0.5）之后来 3 个
// 新模型节点（无 reasoningTokens，general ratio=1）→ r/o 桶被深度过期，
// 全部落到 general=1，不再被旧模型比值污染。
const oldModel = {
	kind: "assistant",
	usage: { outputTokens: 12, reasoningTokens: 4 },
	blocks: [{ kind: "reasoning", text: "aaaaaaaa" }, { kind: "text", text: "bbbb" }]
};
const newModel = { kind: "assistant", usage: { outputTokens: 6 }, blocks: [{ kind: "text", text: "abcdef" }] };
const switched = buildCalibration([oldModel, newModel, newModel, newModel]);
assert.deepEqual(switched, { r: 1, o: 1 }, "old-model buckets expire once CAL_LIMIT newer nodes exist");

/* ---------------- windowed rate + EMA ---------------- */
const ratios = { r: 2, o: 2 };
assert.equal(measureRate([], ratios, 10_000), null);
assert.equal(measureRate([{ t: 1_000, r: 0, o: 0 }], ratios, 10_000), null, "dead tail yields null");
const samples = [
	{ t: 0, r: 0, o: 0 },
	{ t: 1_000, r: 20, o: 20 },
	{ t: 2_000, r: 40, o: 40 }
];
assert.equal(measureRate(samples, ratios, 2_000), 20, "40 tokens over 2s");
assert.ok(Math.abs(measureRate(samples, ratios, 3_000) - 40 / 3) < 1e-9, "a 1s stall inside the window lowers the rate");
assert.equal(smooth(null, 30), 30);
assert.ok(Math.abs(smooth(30, 32) - 30.8) < 1e-9, "EMA moves 40% toward the new reading");
assert.equal(smooth(30, 31), 30, "sub-epsilon moves keep the old value");

/* ---------------- settled-step fallback rate ---------------- */
const settledNode = (seq, outputTokens, decodeMs) => ({
	kind: "assistant",
	seq,
	messageId: `m${seq}`,
	time: 5_000 + decodeMs,
	turn: 1,
	step: seq,
	blocks: [{ kind: "text", text: "x".repeat(outputTokens * 3) }],
	usage: { inputTokens: 100, outputTokens, totalTokens: 100 + outputTokens },
	timing: { stepStartTime: 5_000, firstTokenTime: 5_000, completedTime: 5_000 + decodeMs }
});
assert.equal(settledRate([]), null, "no settled steps means no fallback reading");
assert.equal(settledRate(null), null, "a missing node list means no fallback reading");
assert.equal(settledRate([{ kind: "assistant", seq: 1, usage: { outputTokens: 10 } }]), null, "no per-step timing means no reading");
assert.equal(settledRate([settledNode(1, 10, 60)]), null, "a sub-200ms decode span is timer noise");
assert.deepEqual(settledRate([settledNode(7, 300, 3_000)]), { via: "settled", tps: 100, seq: 7, at: 8_000 }, "outputTokens over the decode span is the measured rate, timestamped by completedTime");
assert.deepEqual(settledRate([settledNode(7, 600, 1_000), settledNode(8, 100, 1_000)]), { via: "settled", tps: 100, seq: 8, at: 6_000 }, "the newest measurable step wins");
assert.deepEqual(settledRate([settledNode(7, 600, 1_000), settledNode(8, 5, 60)]), { via: "settled", tps: 600, seq: 7, at: 6_000 }, "an unmeasurable newest step falls through to the older one");
assert.equal(settledRate([{ kind: "tool-result", callId: "x" }]), null, "non-assistant nodes carry no rate");
assert.equal(settledRate([{ kind: "assistant", seq: 1, usage: { outputTokens: 0 }, timing: { firstTokenTime: 0, completedTime: 1_000 } }]), null, "zero output tokens carry no rate");

/* ---------------- durable stream timeline → first-token time ---------------- */
assert.equal(isTokenDelta({ type: "text-delta", text: "" }), false, "an empty text delta is not output");
assert.equal(isTokenDelta({ type: "reasoning-delta", text: "x" }), true);
assert.equal(isTokenDelta({ type: "tool-call-delta", argumentsDelta: "" }), false);
assert.equal(isTokenDelta({ type: "tool-call-delta", argumentsDelta: "", name: "bash" }), true, "a name-bearing tool delta is output");
assert.equal(isTokenDelta({ type: "usage", usage: {} }), false, "bookkeeping chunks are not output");
assert.equal(firstTokenTimeOf(null), null, "a missing stream has no first token");
assert.equal(firstTokenTimeOf([{ type: "chunk", time: 100, chunk: { type: "block-start", index: 0, blockType: "reasoning" } }]), null, "block markers are not output");
assert.equal(firstTokenTimeOf([
	{ type: "chunk", time: 100, chunk: { type: "block-start", index: 0, blockType: "text" } },
	{ type: "chunk", time: 250, chunk: { type: "text-delta", index: 0, text: "hi" } }
]), 250, "the first non-empty delta carries the first-token time");
// packed runs: time0 + cumulative dt, empty members skipped
assert.equal(firstTokenTimeOf([
	{ type: "chunk", time: 100, chunk: { type: "block-start", index: 0, blockType: "reasoning" } },
	{ type: "reasoning-chunks", time0: 400, index: 0, dt: [10, 5, 7], texts: ["", "The", " model"] }
]), 410, "packed reasoning runs walk time0 + dt and skip empty members");
assert.equal(firstTokenTimeOf([
	{ type: "text-chunks", time0: 900, index: 0, dt: [20], texts: ["", "answer"] }
]), 920, "packed text runs work the same way");
assert.equal(firstTokenTimeOf([
	{ type: "tool-call-chunks", time0: 1_000, index: 0, dt: [3], id: "c1", name: "bash", args: ['{"x"', ":1}"] }
]), 1_000, "a name-bearing packed tool run starts at time0");
assert.equal(firstTokenTimeOf([{ type: "usage-chunks", time0: 1_000, dt: [], texts: [] }]), null, "an unknown packed record is ignored");

/* ---------------- durable event-window rate (reload / session switch) ---------------- */
const durableEvent = (seq, time, firstTokenTime, outputTokens, stream) => ({
	event: {
		type: "assistant/message",
		seq,
		time,
		data: {
			usage: { outputTokens },
			stream: stream ?? [
				{ type: "chunk", time: firstTokenTime, chunk: { type: "text-delta", index: 0, text: "hi" } }
			]
		}
	}
});
assert.equal(durableRateFromEntries(null), null, "a missing event window has no reading");
assert.equal(durableRateFromEntries([]), null, "an empty window has no reading");
assert.equal(durableRateFromEntries([{ event: { type: "step/end", seq: 1, time: 10, data: {} } }]), null, "non-message events carry no rate");
assert.equal(durableRateFromEntries([durableEvent(4, 5_000, 4_000, 0)]), null, "zero output tokens carry no rate");
assert.equal(durableRateFromEntries([durableEvent(4, 5_100, 5_000, 50)]), null, "a sub-200ms decode span is timer noise");
assert.deepEqual(durableRateFromEntries([durableEvent(4, 8_000, 5_000, 300)]), { via: "durable", tps: 100, at: 8_000, seq: 4 }, "outputTokens over the durable decode span is the measured rate");
assert.deepEqual(
	durableRateFromEntries([durableEvent(4, 8_000, 5_000, 300), { event: { type: "step/end", seq: 5, time: 9_000, data: {} } }]),
	{ via: "durable", tps: 100, at: 8_000, seq: 4 },
	"trailing non-message entries are skipped"
);
assert.deepEqual(
	durableRateFromEntries([durableEvent(4, 8_000, 5_000, 300), durableEvent(9, 12_000, 10_000, 100)]),
	{ via: "durable", tps: 50, at: 12_000, seq: 9 },
	"the newest measurable message wins"
);
assert.deepEqual(
	durableRateFromEntries([durableEvent(4, 8_000, 5_000, 300), durableEvent(9, 12_000, 11_990, 100)]),
	{ via: "durable", tps: 100, at: 8_000, seq: 4 },
	"an unmeasurable newest message falls through to the older one"
);
assert.deepEqual(
	durableRateFromEntries([durableEvent(9, 12_000, 10_000, 100, [{ type: "usage-chunks", time0: 1, dt: [], texts: [] }])]),
	null,
	"a message whose stream carries no output token is skipped"
);

/* ---------------- chooseReading: measured readings only, never the average ---------------- */
const w = (tps, at) => ({ tps, at });
const settledReading = (tps, at) => ({ via: "settled", tps, seq: 9, at });
const durableReading = (tps, at) => ({ via: "durable", tps, seq: 9, at });
assert.equal(chooseReading(false, null, null), null, "no source at all means the em dash");
assert.equal(chooseReading(true, null, null), null, "an unmeasurable first step still shows the em dash");
assert.deepEqual(chooseReading(false, null, settledReading(100, 8_000)), settledReading(100, 8_000), "the settled measurement is shown while idle");
assert.deepEqual(chooseReading(true, w(300, 9_000), settledReading(100, 8_000)), { via: "window", tps: 300, at: 9_000 }, "while streaming the live window estimate wins");
assert.deepEqual(chooseReading(false, w(300, 9_000), durableReading(100, 8_000)), durableReading(100, 8_000), "once the step settles the real step rate replaces the estimate");
assert.deepEqual(chooseReading(false, w(300, 9_000), null), { via: "window", tps: 300, at: 9_000 }, "with no settled measurement the last window estimate is kept");
assert.deepEqual(chooseReading(true, w(0, 9_000), settledReading(100, 8_000)), settledReading(100, 8_000), "a zero-valued window reading is not a measurement");
assert.deepEqual(chooseReading(true, null, durableReading(88, 7_000)), durableReading(88, 7_000), "the durable reading bridges the gap between steps");
assert.deepEqual(chooseReading(false, null, null, settledReading(100, 8_000)), settledReading(100, 8_000), "the last displayed reading is held when every source disappears");
assert.equal(chooseReading(false, null, null, null), null, "a remount with no reading shows the em dash");
assert.deepEqual(chooseReading(true, null, null, { via: "settled", tps: 0, seq: 1, at: 1 }), null, "a zero-valued held reading is not a measurement");

/* ---------------- shipped-row anchor probe (no word boundary after tok/s) ---------------- */
assert.equal(isStatsRowText({ textContent: "1 轮 1 步·122 tok/s4.2K tok·缓存命中 0%" }), true, "the real shipped row matches even with another pill glued to it");
assert.equal(isStatsRowText({ textContent: "12 steps · 42.0 tok/s" }), true, "the spaced form still matches");
assert.equal(isStatsRowText({ textContent: "4.2K tok·缓存命中 0%" }), false, "a row without the average readout does not match");
assert.equal(isStatsRowText(null), false, "a missing child does not match");

/* ---------------- display formatting ---------------- */
assert.equal(formatTps(9.84), "9.8");
assert.equal(formatTps(10.4), "10");
assert.equal(formatTps(-3), "0");
assert.equal(displayValue(null), "\u2014", "no reading yet shows an em dash");
assert.equal(displayValue(0), "\u2014", "zero reading shows an em dash");
assert.equal(displayValue(9.84), "9.8");
assert.equal(displayValue(12.3), "12");

/* ---------------- pill render shape (portal + hidden anchor) ---------------- */
/** Minimal locale formatter: `{name}` placeholders filled from opts, else the key. */
const t = (key, opts = {}) => key.replace(/\{(\w+)\}/gu, (_, name) => String(opts[name] ?? `{${name}}`));
const rendered = LiveTpsPill({
	useChat: (selector) => selector({ legacy: { partial: null, nodes: [] } }),
	t,
	sessionId: "session-1",
	liveTpsSessions: null
});
assert.ok(Array.isArray(rendered) && rendered.length === 2, "component returns [anchor, portal]");
assert.equal(rendered[0].type, "span");
assert.equal(rendered[0].props.hidden, true, "anchor is hidden and only serves as the dock foothold");
assert.equal(typeof rendered[0].props.ref, "object", "anchor carries the stable dock ref");
assert.equal(rendered[1], null, "no portal before the mount effect picks a container");

/* ---------------- registration shape ---------------- */
const effects = [];
const dictionaries = [];
const registrations = [];
const sessionsStub = {
	binding: () => void 0
};
const ctx = {
	sessions: sessionsStub,
	effect(fn, label) {
		effects.push({ label, dispose: fn() });
	},
	locale: {
		register(ns, dicts) {
			dictionaries.push({ ns, dicts });
			return () => {};
		}
	},
	slots: {
		inject(name, factory) {
			registrations.push({ name, entry: factory() });
			return () => {};
		},
		register(options, component) {
			return { options, component };
		}
	}
};
face.apply(ctx);
assert.deepEqual(face.inject, ["slots", "locale", "sessions"]);
assert.deepEqual(face.__internals.durableRate(sessionsStub, "session-1"), null, "a binding-less session carries no durable reading");
assert.deepEqual(face.__internals.durableRate(null, "session-1"), null, "an absent sessions service carries no durable reading");
assert.equal(dictionaries.length, 1);
assert.equal(dictionaries[0].ns, NS);
assert.deepEqual(Object.keys(dictionaries[0].dicts).sort(), ["en", "zh"]);
assert.equal(typeof dictionaries[0].dicts.zh.liveTokensPerSecond, "string");
assert.equal(registrations.length, 1);
assert.equal(registrations[0].name, "conversation.composer.dock");
assert.equal(registrations[0].entry.options.name, "conversation.composer.dock");
assert.equal(registrations[0].entry.options.id, "live-tps");
assert.equal(registrations[0].entry.options.order, 2);
assert.equal(registrations[0].entry.options.locale, NS);
assert.equal(registrations[0].entry.options.inject().liveTpsSessions, sessionsStub, "the entry inject hands the sessions service to the pill");
assert.equal(registrations[0].entry.component, LiveTpsPill);
assert.equal(effects.length, 2);
assert.deepEqual(effects.map((e) => e.label), ["live-tps: dictionaries", "live-tps: composer dock"]);

console.log(`live-tps client smoke: ${assertionCount} assertions passed`);
