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
const t = (key, opts) => `实时 ${opts.throughput} tok/s`;
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

/* ---------------- ④ decodeMs=0 → dock fallback + one warn; tok/s appearing → migrate ---------------- */
{
	const { scene, root } = freshScene();
	const warns = [];
	const originalWarn = console.warn;
	console.warn = (...parts) => warns.push(parts.join(" "));
	try {
		root.render(react.createElement(Dock, { entryKey: "e1", showTps: false })); // decodeMs=0：行内没有 tok/s 文本
		await settle();
		const dock = scene.querySelector("[data-slot]");
		const row = statsRowOf(scene);
		eq(pillIn(dock).parentElement, dock, "row without tok/s text keeps the pill in the dock");
		eq(warns.length, 1, "warned once for the missing anchor");
		ok(warns[0].includes("decodeMs=0"), "warn text states the decodeMs=0 condition");

		// 平均速度出现：宿主在按钮 label 里插入 tok/s 文本节点（结构性 childList 突变）
		root.render(react.createElement(Dock, { entryKey: "e1", showTps: true }));
		await settle();
		eq(pillIn(dock).parentElement, row, "pill migrates into the row once tok/s appears");
		eq(warns.length, 1, "still only one warn");
	} finally {
		console.warn = originalWarn;
	}
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
async function mountScene({ nodes = [], partial = null, showRow = true, rowText = "3 轮 12 步 · 42.0 tok/s" }) {
	const scene = document.createElement("div");
	document.body.appendChild(scene);
	const root = reactDomClient.createRoot(scene);
	const chat = statefulChat();
	chat.set({ legacy: { partial, nodes } });
	const render = () => root.render(react.createElement("div", { className: "dock" },
		react.createElement("div", { "data-slot": "conversation.composer.dock", style: { display: "contents" } },
			showRow ? react.createElement("div", { key: "row", "data-composer-stats": true },
				react.createElement("span", null, rowText)) : null,
			react.createElement(LiveTpsPill, { key: "e1", useChat: chat.useChat, t }))));
	render();
	await settle();
	return {
		scene,
		pill: () => pillIn(scene),
		async update({ nodes: n, partial: p }) {
			chat.set({ legacy: { partial: p ?? null, nodes: n ?? [] } });
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
	eq(scene.scene.querySelector("[data-composer-stats]"), null, "precondition: the host row is gone in compact work-details");
	const pill = scene.pill();
	ok(pill !== null, "the pill survives the missing host row");
	eq(pill.parentElement.hasAttribute("data-slot"), true, "it stays in the dock as the fallback container");
	eq(pill.textContent, "实时 125 tok/s", "and it still reports a rate");
	await scene.unmount();
}

// ⑧-5 本会话尚无任何已结算步：em dash 仍是唯一正确显示。
{
	const scene = await mountScene({ nodes: [] });
	await new Promise((resolve) => setTimeout(resolve, 300));
	await settle();
	eq(scene.pill().textContent, "实时 \u2014 tok/s", "before any settled step the em dash is correct");
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
