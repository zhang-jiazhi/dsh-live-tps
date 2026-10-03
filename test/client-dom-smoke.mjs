/**
 * DOM placement smoke test for the @local/dsh-live-tps composer-dock pill.
 *
 * This is the regression fence for the round-2 P0: the pill must be rendered
 * through `createPortal` (React-owned DOM end to end) so that a session
 * switch — the host deleting the stats row / dock entry subtree in its own
 * commit — can never hit a commit-phase NotFoundError, and unmounting must
 * leave no residue. It also pins the portal-container switching (row → dock
 * fallback → row) and the P1 rule that the lookup base is always the dock
 * element reached from the component's own anchor, never the pill position.
 *
 * Structure replicated from the host: a `display: contents` slot outlet div
 * (`data-slot="conversation.composer.dock"`) whose React children are the
 * host-owned stats row (span.anchor > button.pill with the average tok/s
 * readout) and this entry's output — so session switches remount exactly the
 * way StrictSessionEntry does: the outlet keeps its identity, its children
 * are deleted and recreated in one commit.
 *
 * Dependencies (react + react-dom + jsdom) are resolved from, in order: the
 * plugin's own node_modules, $LIVE_TPS_DOM_DEPS, /tmp/live-tps-fix-verify and
 * the host install. If they are missing, install once:
 *
 *   npm install --prefix /tmp/live-tps-fix-verify react@18.3.1 react-dom@18.3.1 jsdom
 *
 * Run with:  node test/client-dom-smoke.mjs
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(here, "..");
const candidateRoots = [
	pluginRoot,
	process.env.LIVE_TPS_DOM_DEPS,
	"/tmp/live-tps-fix-verify",
	"/Users/zhangjiazhi/.dsh/dsh-v0.1.6-alpha.1"
].filter(Boolean);
const req = createRequire(path.join(here, "resolve.js"));
const resolveDep = (id) => {
	for (const root of candidateRoots) {
		try {
			return req.resolve(id, { paths: [path.join(root, "node_modules"), root] });
		} catch { /* try next root */ }
	}
	throw new Error(
		`缺少 ${id}。请先安装依赖：npm install --prefix /tmp/live-tps-fix-verify react@18.3.1 react-dom@18.3.1 jsdom，` +
		`或设置 LIVE_TPS_DOM_DEPS 指向包含它们的目录。`
	);
};

const react = req(resolveDep("react"));
const reactDomClient = req(resolveDep("react-dom/client"));
const { JSDOM } = req(resolveDep("jsdom"));

/* ---------------- jsdom globals (react-dom needs document/window) ---------------- */
const dom = new JSDOM("<!doctype html><html><body></body></html>");
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
globalThis.MutationObserver = dom.window.MutationObserver;

/** Load the plugin bundle through a shim of the host module loader. */
let captured = null;
globalThis.window.__ModuleLoader__ = {
	load(spec) {
		captured = spec;
	}
};
await import(pathToFileURL(path.join(pluginRoot, "lib/client.js")).href);
assert.ok(captured !== null && typeof captured.factory === "function", "bundle registers via __ModuleLoader__");
const requireShim = (id) => {
	if (id === "react") return react;
	if (id === "react/jsx-runtime") return req(resolveDep("react/jsx-runtime"));
	if (id === "react-dom") return req(resolveDep("react-dom"));
	throw new Error(`unexpected require("${id}")`);
};
const face = captured.factory(requireShim);
const { LiveTpsPill } = face.__internals;
assert.equal(typeof face.__internals.buildCalibration, "function");

let passed = 0;
const ok = (condition, message) => {
	assert.ok(condition, message);
	passed += 1;
};
const eq = (actual, expected, message) => {
	assert.equal(actual, expected, message);
	passed += 1;
};

/* ---------------- host doubles ---------------- */
/** Seat stubs: idle chat snapshot, locale formatter that keeps the tok/s wording. */
const useChat = (selector) => selector({ legacy: { partial: null, nodes: [] } });
/**
 * Real locale dictionary, captured from the plugin's own `apply()` so every
 * assertion below is checked against the shipped copy instead of a hand-written
 * guess. `{name}` placeholders are filled from opts; an unregistered key fails loud.
 */
let registeredDicts = null;
face.apply({
	locale: { register(_ns, dicts) { registeredDicts = dicts; return () => {} } },
	effect: (factory) => { if (typeof factory === "function") factory(); return () => {} },
	slots: {
		inject: () => () => {},
		register: () => ({})
	}
});
assert.ok(registeredDicts !== null && typeof registeredDicts.zh === "object", "apply registers the dictionaries");
const zhDict = registeredDicts.zh;
const t = (key, opts = {}) => {
	const template = zhDict[key];
	if (typeof template !== "string") throw new Error(`locale key ${JSON.stringify(key)} is not registered`);
	return String(template).replace(/\{(\w+)\}/gu, (_, name) => String(opts[name] ?? `{${name}}`));
};
/**
 * Replica of the shipped composer dock: the display-contents slot outlet div
 * whose React children are the host-owned stats row and our entry. Session
 * switches swap the children wholesale (stable per-session keys), exactly the
 * StrictSessionEntry remount the real host performs.
 */
function Dock({ showRow = true, showTps = true, tps = "3.4 tok/s", entryKey = "entry" }) {
	const rowChildren = [
		react.createElement("span", { key: "icon", "aria-hidden": true }, "◉"),
		"12 steps",
		...(showTps
			? [react.createElement("span", { key: "sep", "aria-hidden": true }, "·"), react.createElement("span", { key: "tps" }, tps)]
			: [])
	];
	const row = react.createElement("span", { "data-stats-row": true, key: "row" },
		react.createElement("button", { key: "btn" }, rowChildren));
	return react.createElement("div", { "data-slot": "conversation.composer.dock", style: { display: "contents" } },
		showRow ? row : null,
		react.createElement(LiveTpsPill, { key: entryKey, useChat, t }));
}

/** Fresh scene: a dedicated React root per scenario (an unmounted root cannot render again). */
const freshScene = () => {
	const scene = document.createElement("div");
	document.body.appendChild(scene);
	return { scene, root: reactDomClient.createRoot(scene) };
};

/** Let MutationObserver callbacks, React renders and passive effects flush. */
const settle = async () => {
	for (let i = 0; i < 8; i += 1) {
		await Promise.resolve();
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
};

const pillIn = (scope) => scope.querySelector("[data-composer-live-tps]");
const statsRowOf = (scene) => scene.querySelector("[data-stats-row]");

/* ---------------- ① initial placement: portal into the stats row ---------------- */
{
	const { scene, root } = freshScene();
	root.render(react.createElement(Dock, { entryKey: "e1" }));
	await settle();

	const dock = scene.querySelector("[data-slot]");
	ok(dock !== null, "dock outlet rendered");
	const anchor = [...dock.children].find((child) => child.hidden === true);
	ok(anchor !== undefined, "hidden anchor rendered as a direct dock child");
	ok(anchor.parentElement === dock, "anchor stays put — the stable dock foothold");
	const pill = pillIn(dock);
	ok(pill !== null, "pill rendered");
	eq(pill.parentElement, statsRowOf(scene), "pill portaled into the stats row");
	eq(pill.parentElement.lastElementChild, pill, "pill appended after the average tok/s pill");
	eq(pill.textContent, "实时 \u2014 tok/s", "pill shows the em dash before any reading");

	root.unmount();
	scene.remove();
	await settle();
}

/* ---------------- ② row disappears → portal falls back to the dock ---------------- */
{
	const { scene, root } = freshScene();
	root.render(react.createElement(Dock, { entryKey: "e1" }));
	await settle();
	const dock = scene.querySelector("[data-slot]");
	eq(pillIn(dock).parentElement, statsRowOf(scene), "precondition: pill in row");

	root.render(react.createElement(Dock, { entryKey: "e1", showRow: false })); // 宿主把 stats 行撤掉
	await settle();
	const pill = pillIn(dock);
	ok(pill !== null, "pill survives the row removal");
	eq(pill.parentElement, dock, "portal falls back to the dock container");
	ok(pill.isConnected, "pill stays attached to the document");

	root.render(react.createElement(Dock, { entryKey: "e1", showRow: false, showTps: false })); // 宿主重渲染 dock 子节点
	await settle();
	const pillAfter = pillIn(dock);
	ok(pillAfter !== null, "pill survives host re-renders of the dock children");
	eq(pillAfter.parentElement, dock, "portal children are invisible to the host diff");

	root.unmount();
	scene.remove();
	await settle();
	eq(document.querySelectorAll("[data-composer-live-tps]").length, 0, "unmount leaves no pill residue");
}

/* ---------------- ③ lookup base stays the dock (P1: no deeper nesting) ---------------- */
{
	const { scene, root } = freshScene();
	root.render(react.createElement(Dock, { entryKey: "e1" }));
	await settle();
	const dock = scene.querySelector("[data-slot]");
	const row = statsRowOf(scene);
	const button = row.querySelector("button");
	eq(pillIn(dock).parentElement, row, "precondition: pill in row");

	// 触发一轮 observer 回调（文字替换 = childList 突变）：旧行为会把 pill
	// 越嵌越深（最终嵌进按钮内部），新行为必须原地不动。
	button.textContent = "12 steps · 5.6 tok/s";
	await settle();
	eq(pillIn(dock).parentElement, row, "pill stays a direct child of the row");
	eq(button.querySelector("[data-composer-live-tps]"), null, "pill never nests into the button");

	// dock 里再出现一个宿主自有节点也不影响容器判定
	dock.appendChild(document.createElement("i"));
	await settle();
	eq(pillIn(dock).parentElement, row, "container decision unchanged after extra dock mutations");
	eq(document.querySelectorAll("[data-composer-live-tps]").length, 1, "exactly one pill exists");

	root.unmount();
	scene.remove();
	await settle();
}

/* ---------------- ③b 宿主真实行文案：tok/s 后面紧跟另一个胶囊，无词边界 ---------------- */
// 桌面版实测行文案是 `1 轮 1 步·122 tok/s4.2K tok·缓存命中 0%`：`tok/s` 的 `s` 后面
// 紧跟 token 数的 `4`，没有词边界。旧锚点 /\btok\/s\b/ 因此判定失败 → pill 永远留在
// dock 里、每次会话都打印"找不到 stats 行"的告警（2026-09-26 真实 DOM 证据）。
{
	const { scene, root } = freshScene();
	root.render(react.createElement(Dock, { entryKey: "e1", tps: "1 轮 1 步·122 tok/s4.2K tok·缓存命中 0%" }));
	await settle();
	const dock = scene.querySelector("[data-slot]");
	eq(pillIn(dock).parentElement, statsRowOf(scene), "a token-count pill glued to tok/s does not hide the stats row");
	eq(pillIn(dock).parentElement.lastElementChild, pillIn(dock), "and the pill still follows the shipped readout");

	root.unmount();
	scene.remove();
	await settle();
}
/* ---------------- ⑤ unmount with row present: no throw, no residue ---------------- */
{
	const { scene, root } = freshScene();
	root.render(react.createElement(Dock, { entryKey: "e1" }));
	await settle();
	const dock = scene.querySelector("[data-slot]");
	eq(pillIn(dock).parentElement, statsRowOf(scene), "precondition: pill in row");

	root.unmount();
	await settle();
	eq(document.querySelectorAll("[data-composer-live-tps]").length, 0, "no pill left anywhere");
	eq(scene.querySelectorAll("[data-slot]").length, 0, "entry tree (anchor included) removed");
	eq(document.querySelectorAll("[data-composer-live-tps]").length, 0, "and no detached pill residue either");
	scene.remove();
	await settle();
}

/* ---------------- ⑥ session switch: row + entry deleted in one host commit (round-2 P0) ---------------- */
{
	const { scene, root } = freshScene();
	// 两个"会话"：子节点 key 不同 → 切换时宿主在同一次 commit 里删除旧行 +
	// 旧 entry 子树、插入新行 + 新 entry 子树（StrictSessionEntry 语义）。
	root.render(react.createElement(Dock, { entryKey: "session-a" }));
	await settle();
	const dock = scene.querySelector("[data-slot]");
	const pillA = pillIn(dock);
	ok(pillA !== null, "pill rendered for session A");
	ok(pillA.parentElement === statsRowOf(scene), "pill portaled into the host-rendered row");

	let threw = null;
	try {
		// 会话切换：宿主 React 在同一次 commit 里删掉 stats 行与本 entry 子树。
		// 旧实现：pill 已被手动搬进行内，React 按它记忆的父节点执行
		// removeChild(dock, pill) → DOMException NotFoundError，错误边界拦不住。
		root.render(react.createElement(Dock, { entryKey: "session-b", tps: "8.8 tok/s" }));
		await settle();
	} catch (error) {
		threw = error;
	}
	eq(threw, null, `session-switch commit must not throw (got ${threw?.constructor?.name}: ${threw?.message})`);
	eq(document.querySelectorAll("[data-composer-live-tps]").length, 1, "exactly the new session's pill remains");
	const pillB = pillIn(dock);
	ok(pillB !== pillA, "session B got a fresh pill");
	ok(pillB.parentElement === statsRowOf(scene), "new pill portaled into the new stats row");

	root.unmount();
	scene.remove();
	await settle();
}

/* ---------------- ⑦ calibration helpers still exported for the pure smoke ---------------- */
eq(face.__internals.buildCalibration([]).r, 4.5, "calibration helpers still exported");

/* ---------------- ⑧ settled-step fallback: a rate is always shown once a step settles ---------------- */
/**
 * A settled assistant node as the host shapes it on `legacy.nodes`: the step's
 * `finalNode` with provider usage and the durable per-step timing the chat
 * builder stamps from `step/start`, the first token, and `assistant/message`.
 * @param seq - node ordering key.
 * @param outputTokens - provider-reported completion tokens.
 * @param decodeMs - first-token → assembled-message span.
 * @returns one settled assistant node.
 */
const settledNode = (seq, outputTokens, decodeMs) => ({
	kind: "assistant",
	seq,
	messageId: `m${seq}`,
	time: 5000 + decodeMs,
	turn: 1,
	step: seq,
	blocks: [{ kind: "text", text: "x".repeat(outputTokens * 3) }],
	usage: { inputTokens: 100, outputTokens, totalTokens: 100 + outputTokens },
	timing: { stepStartTime: 5000, firstTokenTime: 5000, completedTime: 5000 + decodeMs }
});

/** Seat stub whose snapshot the test replaces between renders. */
const statefulChat = () => {
	let snapshot = { legacy: { partial: null, nodes: [] } };
	return {
		useChat: (selector) => selector(snapshot),
		set(next) {
			snapshot = next;
		}
	};
};

/** Mount one pill with a controllable chat seat and a settable host row. */
async function mountScene({ nodes = [], partial = null, showRow = true, rowText = "3 轮 12 步 · 42.0 tok/s", projection, entryKey = "e1", durableEntries, sessionId = "session-1", rowMarker = "activity" }) {
	const scene = document.createElement("div");
	document.body.appendChild(scene);
	const root = reactDomClient.createRoot(scene);
	const chat = statefulChat();
	chat.set({ legacy: { partial, nodes } });
	const projectionValue = { current: projection };
	const rowState = { show: showRow };
	const sessions = durableEntries === undefined ? null : {
		binding: (id) => (id === sessionId ? { eventSource: { getSnapshot: () => ({ entries: typeof durableEntries === "function" ? durableEntries() : durableEntries }) } } : void 0)
	};
	const render = () => root.render(react.createElement("div", { className: "dock" },
		react.createElement("div", { "data-slot": "conversation.composer.dock", style: { display: "contents" } },
			rowState.show ? react.createElement("div", { key: "row", ...(rowMarker === true ? { "data-composer-stats": true } : rowMarker ? { "data-composer-stat": rowMarker } : {}) },
				react.createElement("span", null, rowText)) : null,
			react.createElement(LiveTpsPill, { key: entryKey, useChat: chat.useChat, useProjection: (key) => (key === "sessionStats" ? projectionValue.current : undefined), t, sessionId, liveTpsSessions: sessions }))));
	render();
	await settle();
	return {
		scene,
		pill: () => pillIn(scene),
		async update({ nodes: n, partial: p, projection: pr }) {
			chat.set({ legacy: { partial: p ?? null, nodes: n ?? [] } });
			if (pr !== undefined) projectionValue.current = pr;
			render();
			await settle();
		},
		async setRow(show) {
			rowState.show = show;
			render();
			await settle();
		},
		async unmount() {
			root.unmount();
			scene.remove();
			await settle();
		}
	};
}

/* ---------------- ④ 行缺失/出现：容器跟随，且只在"本该有行"时告警 ---------------- */
{
	const warns = [];
	const originalWarn = console.warn;
	console.warn = (...parts) => warns.push(parts.join(" "));
	try {
		// 新会话：还没有已结算步，官方行本来就不渲染（decodeMs=0）→ 不是漂移，不告警
		const fresh = await mountScene({ nodes: [], showRow: false });
		eq(fresh.pill().parentElement.hasAttribute("data-slot"), true, "no row keeps the pill in the dock");
		eq(warns.length, 0, "a session with no settled step must not warn about the missing row");

		// 已有已结算步却没有 stats 行 → 宿主锚点漂移，必须告警一次
		const broken = await mountScene({ nodes: [settledNode(7, 300, 3_000)], showRow: false });
		eq(warns.length, 1, "a settled session without a stats row warns once");
		ok(warns[0].includes("锚点"), "warn text names the anchor drift");

		// 宿主把行渲染出来（结构性 childList 突变）→ pill 迁移进 stats 行
		await broken.setRow(true);
		eq(broken.pill().parentElement.getAttribute("data-composer-stat"), "activity", "pill migrates into the activity row once it appears");
		eq(warns.length, 1, "still only one warn");

		await fresh.unmount();
		await broken.unmount();
	} finally {
		console.warn = originalWarn;
	}
}

// ⑧-1 步间歇 / 活跃步但零字符：回落读数来自最近一个已结算步的实测速率，不再是 em dash。
{
	const scene = await mountScene({ nodes: [settledNode(7, 300, 3000)] });
	await new Promise((resolve) => setTimeout(resolve, 300));
	await settle();
	eq(scene.pill().textContent, "实时 100 tok/s", "between steps the readout keeps a real rate");
	eq(scene.pill().getAttribute("data-live"), "false", "idle steps dim the pill but keep the number");

	// 活跃步但没有任何字符增量（provider 不逐字输出）——同样不得停在 em dash。
	await scene.update({ partial: { turn: 1, step: 8, blocks: [] } });
	await new Promise((resolve) => setTimeout(resolve, 300));
	await settle();
	eq(scene.pill().textContent, "实时 100 tok/s", "an active step with no character delta still reads the settled rate");
	await scene.unmount();
}

// ⑧-2 短步（decode span < 200ms）不得当成速率，回落到上一个可测步。
{
	const scene = await mountScene({ nodes: [settledNode(9, 400, 4000), settledNode(10, 5, 60)] });
	await new Promise((resolve) => setTimeout(resolve, 300));
	await settle();
	eq(scene.pill().textContent, "实时 100 tok/s", "a sub-200ms step is noise; the older measurable step wins");
	await scene.unmount();
}

// ⑧-3 换模型后读数跟随新模型的最近一步，而不是消失或停留在旧模型速率。
{
	const scene = await mountScene({ nodes: [settledNode(7, 300, 3000)] });
	await new Promise((resolve) => setTimeout(resolve, 300));
	await settle();
	eq(scene.pill().textContent, "实时 100 tok/s", "precondition: old-model reading on screen");

	await scene.update({ nodes: [settledNode(7, 300, 3000), settledNode(12, 100, 3000)] });
	await new Promise((resolve) => setTimeout(resolve, 300));
	await settle();
	const after = scene.pill().textContent;
	ok(after !== null && after.includes("tok/s"), "after a model switch the pill still reports a rate");
	eq(after, "实时 33 tok/s", "the reading follows the newest step rather than lagging behind stale calibration");
	await scene.unmount();
}

// ⑧-4 工作步骤非详细：官方 stats 行整行 return null（speed 与 cacheHit 都缺），读数仍在。
{
	const scene = await mountScene({ nodes: [settledNode(3, 250, 2000)], showRow: false });
	await new Promise((resolve) => setTimeout(resolve, 300));
	await settle();
	eq(scene.scene.querySelector("[data-composer-stat],[data-composer-stats]"), null, "precondition: the host row is gone in compact work-details");
	const pill = scene.pill();
	ok(pill !== null, "the pill survives the missing host row");
	eq(pill.parentElement.hasAttribute("data-slot"), true, "it stays in the dock as the fallback container");
	eq(pill.textContent, "实时 125 tok/s", "and it still reports a rate");
	await scene.unmount();
}

// ⑧-4b 2026-10-03：宿主把输入区统计拆成 activity / usage 两行（新标记
// `data-composer-stat="<id>"`），旧宿主只有布尔 `data-composer-stats`。三种都要锚定。
{
	const cases = [
		{ rowMarker: "activity", label: "new activity marker", check: (el) => el.getAttribute("data-composer-stat") === "activity" },
		{ rowMarker: "usage", label: "new usage marker", check: (el) => el.getAttribute("data-composer-stat") === "usage" },
		{ rowMarker: true, label: "legacy boolean marker", check: (el) => el.hasAttribute("data-composer-stats") }
	];
	for (const c of cases) {
		const scene = await mountScene({ nodes: [settledNode(2, 200, 1500)], rowMarker: c.rowMarker });
		ok(c.check(scene.pill().parentElement), `pill anchors into the host row via the ${c.label}`);
		await scene.unmount();
	}
}

// ⑧-5 本会话尚无任何已结算步：em dash 仍是唯一正确显示。
{
	const scene = await mountScene({ nodes: [] });
	await new Promise((resolve) => setTimeout(resolve, 300));
	await settle();
	eq(scene.pill().textContent, "实时 \u2014 tok/s", "before any settled step the em dash is correct");
	await scene.unmount();
}

// ⑧-6 同一个会话里既有已结算步、又有宿主投影时，必须显示实测值而不是整日志均值。
//      这正是用户 2026-09-26 反馈的回归：投影一旦被设为首选回落，读数就和官方
//      StatsPills 的 decodeTokens/decodeMs 一模一样，成了"平均速度"。
{
	const scene = await mountScene({
		nodes: [settledNode(7, 600, 1000), settledNode(8, 100, 1000)],
		projection: { turns: 3, steps: 40, llmMs: 9000, toolMs: 4000, ttftMs: 900, ttftSteps: 3, decodeMs: 4000, decodeTokens: 800 }
	});
	await new Promise((resolve) => setTimeout(resolve, 300));
	await settle();
	const pill = scene.pill();
	eq(pill.textContent, "实时 100 tok/s", "the newest measured step is displayed, not the 200 tok/s whole-session average");
	eq(pill.getAttribute("data-source"), "settled", "and the measured source is reported");
	ok(!pill.textContent.includes("200"), "the average must not be shown while a measurement exists");
	await scene.unmount();
}

// ⑧-7 宿主投影不再供数：没有客户端实测时（轨迹/记忆页 legacy 为空且本页没看过流）
//      必须停在 em dash，而不是把官方整日志均值当作"实时速度"显示。
{
	const scene = await mountScene({
		nodes: [],
		projection: { turns: 3, steps: 40, llmMs: 9_000, toolMs: 4_000, ttftMs: 900, ttftSteps: 3, decodeMs: 4_000, decodeTokens: 800 }
	});
	await new Promise((resolve) => setTimeout(resolve, 300));
	await settle();
	const pill = scene.pill();
	eq(pill.textContent, "实时 \u2014 tok/s", "the whole-session average is never shown as the live rate");
	eq(pill.getAttribute("data-source"), "none", "no measured source means no reading");
	eq(pill.getAttribute("data-nodes"), "0", "precondition: no settled nodes in this view");
	await scene.unmount();
}

// ⑧-8 没有投影（老宿主）时退回已结算步实测；两者都没有才回到 em dash。
{
	const scene = await mountScene({ nodes: [settledNode(7, 300, 3_000)], projection: undefined });
	await new Promise((resolve) => setTimeout(resolve, 300));
	await settle();
	eq(scene.pill().textContent, "实时 100 tok/s", "without the projection the settled step still feeds the rate");
	eq(scene.pill().getAttribute("data-source"), "settled", "and reports the settled-step source");

	await scene.update({ nodes: [], projection: null });
	await new Promise((resolve) => setTimeout(resolve, 300));
	await settle();
	// 读数刻意保留（2026-09-26 的用户诉求）：回落源消失不清零，只在换会话重挂时归零。
	eq(scene.pill().textContent, "实时 100 tok/s", "a vanished fallback source keeps the last reading by design");
	await scene.unmount();
}

// ⑧-8b 换会话 = entry 重挂（scope: session），新会话无数据时回到 em dash。
{
	const scene = await mountScene({ nodes: [], projection: undefined, entryKey: "session-b" });
	await new Promise((resolve) => setTimeout(resolve, 300));
	await settle();
	eq(scene.pill().textContent, "实时 \u2014 tok/s", "a remount for a new session starts from the em dash again");
	eq(scene.pill().getAttribute("data-source"), "none", "and the source reads none");
	await scene.unmount();
}

// ⑧-9 悬停提示带读数来源；读不出数时直接告出数据源实况（用户就是靠悬停发现的）。
{
	const scene = await mountScene({ nodes: [settledNode(7, 300, 3_000)], projection: { steps: 40, decodeMs: 4_000, decodeTokens: 800 } });
	await new Promise((resolve) => setTimeout(resolve, 300));
	await settle();
	ok(/100/.test(scene.pill().getAttribute("title")), "the tooltip carries the raw number");
	ok(/最近一步实测/.test(scene.pill().getAttribute("title")), "and names the measured source");

	const blind = await mountScene({ nodes: [], projection: undefined });
	await new Promise((resolve) => setTimeout(resolve, 300));
	await settle();
	const hint = blind.pill().getAttribute("title");
	ok(/会话投影：未提供/.test(hint), "a blind pill reports the projection as not served");
	ok(/已结算步骤：0/.test(hint), "and the settled-step count");
	await scene.unmount();
	await blind.unmount();
}

// ⑧-10 durable 日志源：本页没看过流（刷新 / 换会话 / 非聊天页）时，
//       从会话自己的事件窗口算出真实末步速率，而不是 em dash 或均值。
{
	const entries = [
		{ event: { type: "user/message", seq: 1, time: 1_000, data: { message: { role: "user", content: [] } } } },
		{ event: { type: "step/start", seq: 2, time: 1_100, data: { turn: 1, step: 1 } } },
		{ event: { type: "assistant/message", seq: 3, time: 9_000, data: { turn: 1, step: 1, usage: { outputTokens: 400 }, stream: [{ type: "chunk", time: 5_000, chunk: { type: "reasoning-delta", index: 0, text: "The" } }] } } },
		{ event: { type: "step/end", seq: 4, time: 9_100, data: { turn: 1, step: 1 } } }
	];
	const scene = await mountScene({ nodes: [], durableEntries: entries });
	await new Promise((resolve) => setTimeout(resolve, 300));
	await settle();
	const pill = scene.pill();
	eq(pill.textContent, "实时 100 tok/s", "the durable event window supplies the real last-step rate");
	eq(pill.getAttribute("data-source"), "durable", "and reports the durable source");
	eq(pill.getAttribute("data-durable"), "present", "the diagnostic attribute reflects the durable source");
	ok(/日志末步实测/.test(pill.getAttribute("title")), "the tooltip names the durable source");

	// 客户端自己看过的那一步（settled）优先于日志重算：两者都是实测，用本页原始观测。
	const observed = await mountScene({ nodes: [settledNode(9, 250, 1_000)], durableEntries: entries });
	await new Promise((resolve) => setTimeout(resolve, 300));
	await settle();
	eq(observed.pill().textContent, "实时 250 tok/s", "a client-observed step outranks the log recomputation of the same quantity");
	eq(observed.pill().getAttribute("data-source"), "settled", "and the source is the observed one");

	await scene.unmount();
	await observed.unmount();
}

// ⑧-11 翻译类插件的整段 replaceChildren 之后，可见文案必须自愈（2026-09-26 的
//       "鼠标悬停才看到数字、正文停在 em dash"就是这么来的）。
{
	const scene = await mountScene({ nodes: [settledNode(7, 300, 3_000)] });
	await new Promise((resolve) => setTimeout(resolve, 300));
	await settle();
	const pill = scene.pill();
	eq(pill.textContent, "实时 100 tok/s", "precondition: the measured rate is visible");
	eq(pill.getAttribute("data-imt-skip"), "", "the pill opts out of DOM-translating plugins");
	eq(pill.getAttribute("translate"), "no", "and of the generic translate contract");
	ok(pill.className.includes("notranslate"), "and carries the notranslate class");

	// 模拟沉浸式翻译的写回路径：整段替换 pill 的子节点（React 的文本节点被摘掉）。
	pill.textContent = "";
	pill.appendChild(document.createTextNode("实时 \u2014 tok/s"));
	eq(pill.textContent, "实时 \u2014 tok/s", "precondition: a foreign rewrite froze the visible label");

	// 下一次提交必须修回可见文案（并显示新的真实读数）。
	await scene.update({ nodes: [settledNode(7, 300, 3_000), settledNode(8, 250, 1_000)] });
	const healed = scene.pill();
	eq(healed.textContent, "实时 250 tok/s", "the visible label is repaired after a foreign DOM rewrite");
	eq(healed.getAttribute("data-tps"), "250", "and it matches the live state attributes");
	await scene.unmount();
}

// ⑧-6 空闲期不常驻定时器（v1 的教训：空闲 setInterval 20Hz 常驻烧 CPU）。
{
	let started = 0;
	const original = globalThis.setInterval;
	globalThis.setInterval = (handler, ms) => {
		started += 1;
		return original(handler, ms);
	};
	try {
		const scene = await mountScene({ nodes: [settledNode(7, 300, 3_000)] });
		await new Promise((resolve) => setTimeout(resolve, 300));
		await settle();
		eq(scene.pill().textContent, "实时 100 tok/s", "precondition: the settled reading is already displayed");
		started = 0;
		await new Promise((resolve) => setTimeout(resolve, 400));
		eq(started, 0, "no timer is re-armed while the displayed rate already matches the newest step");
		await scene.unmount();
	} finally {
		globalThis.setInterval = original;
	}
}

console.log(`live-tps client DOM smoke: ${passed} checks passed (portal placement, fallbacks, session-switch unmount, settled-step readout)`);
