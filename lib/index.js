/**
 * @local/dsh-live-tps - host half.
 *
 * The live throughput readout is a native web-client contribution: the client
 * face (`./client.js`) registers one extra `conversation.composer.dock` entry
 * beside the shipped `stats` entry, so the pill lives in the same dock as the
 * average tok/s row and needs no shipped-bundle patching.
 *
 * This host half therefore owns no services and no patch state. It exists
 * because the client module graph is composed from mounted host plugins
 * declaring `dsh.client`; mounting this package is what publishes the client
 * face.
 */

/** Stable cordis plugin name. */
export const name = "live-tps";

/** No host services required. */
export const inject = [];

/**
 * No host-side work: rendering lives entirely in the client face.
 * @param {import("@deepseek-ai/cordis").Context} _ctx - host root context (unused).
 */
export function apply(_ctx) {}
