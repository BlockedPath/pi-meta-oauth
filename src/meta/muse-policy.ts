import { MUSE_USER_AGENT_ENV_VAR } from "./constants.ts";
import type { MetaEnv, MetaProviderModel } from "./types.ts";

/** Models whose max effort requires the captured Muse client fingerprint. */
export const MUSE_USER_AGENT_MODEL_IDS: ReadonlySet<string> = new Set([
	"muse-spark-1.3-contributor",
]);

/** Recognize the documented, explicit Muse fingerprint opt-in values. */
export function isMuseUserAgentEnabled(env: MetaEnv = process.env): boolean {
	const configured = env[MUSE_USER_AGENT_ENV_VAR];
	if (typeof configured !== "string") return false;
	const value = configured.trim().toLowerCase();
	return value === "1" || value === "true" || value === "yes";
}

/**
 * Gate the literal max effort on known fingerprint-dependent models. A future
 * server-advertised mapping to a different effort remains authoritative.
 */
export function gateMuseMaxEffort(
	model: MetaProviderModel,
	env: MetaEnv = process.env,
): MetaProviderModel {
	const map = model.thinkingLevelMap;
	if (!map || !MUSE_USER_AGENT_MODEL_IDS.has(model.id)) return model;
	if (map.max != null && map.max !== "max") return model;

	const max = isMuseUserAgentEnabled(env) ? "max" : null;
	if (map.max === max) return model;
	return { ...model, thinkingLevelMap: { ...map, max } };
}
