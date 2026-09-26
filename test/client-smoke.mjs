/**
 * Smoke test for the native @local/dsh-live-tps client half.
 *
 * The browser bundle calls `window.__ModuleLoader__.load(...)`; this test shims
 * that loader, evaluates the bundle, then exercises the pure measurement
 * helpers and the slot/locale registration with test doubles. Run with:
 *
 *   node test/client-smoke.mjs
 */
import assert from "node:assert/strict";

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
	useEffect: () => {}
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
const { NS, blockChars, ratioOf, buildCalibration, measureRate, smooth, formatTps, displayValue, LiveTpsPill } = face.__internals;

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

/* ---------------- display formatting ---------------- */
assert.equal(formatTps(9.84), "9.8");
assert.equal(formatTps(10.4), "10");
assert.equal(formatTps(-3), "0");
assert.equal(displayValue(null), "\u2014", "no reading yet shows an em dash");
assert.equal(displayValue(0), "\u2014", "zero reading shows an em dash");
assert.equal(displayValue(9.84), "9.8");
assert.equal(displayValue(12.3), "12");

/* ---------------- pill render shape (portal + hidden anchor) ---------------- */
const rendered = LiveTpsPill({
	useChat: (selector) => selector({ legacy: { partial: null, nodes: [] } }),
	t: (key, opts) => `live ${opts.throughput} tok/s`
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
const ctx = {
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
assert.deepEqual(face.inject, ["slots", "locale"]);
assert.equal(dictionaries.length, 1);
assert.equal(dictionaries[0].ns, NS);
assert.deepEqual(Object.keys(dictionaries[0].dicts).sort(), ["en", "zh"]);
assert.equal(typeof dictionaries[0].dicts.zh.liveTokensPerSecond, "string");
assert.equal(registrations.length, 1);
assert.equal(registrations[0].name, "conversation.composer.dock");
assert.equal(registrations[0].entry.options.name, "conversation.composer.dock");
assert.equal(registrations[0].entry.options.id, "live-tps");
assert.equal(registrations[0].entry.options.order, 1);
assert.equal(registrations[0].entry.options.locale, NS);
assert.equal(registrations[0].entry.component, LiveTpsPill);
assert.equal(effects.length, 2);
assert.deepEqual(effects.map((e) => e.label), ["live-tps: dictionaries", "live-tps: composer dock"]);

console.log("live-tps client smoke: 51 assertions passed");
