import { MUSE_USER_AGENT_ENV_VAR } from "./constants.ts";
import type { MetaEnv, MetaProviderModel } from "./types.ts";

/** Models whose max effort requires the captured Muse client fingerprint. */
export const MUSE_USER_AGENT_MODEL_IDS: ReadonlySet<string> = new Set([
	"muse-spark-1.3-contributor",
	"muse-wonder-1.0-contributor",
	"muse-wonder-full-1.0-contributor",
]);

/**
 * Models known to accept literal max effort with any User-Agent. The Wonder
 * models have no bundled definition in models.ts, so max originates here;
 * muse-spark-1.3 has one, but is listed so the gate — which runs on every
 * model list — is the single authority and a stale cached `max: null`
 * cannot mask its fallback-declared support.
 */
export const MAX_EFFORT_MODEL_IDS: ReadonlySet<string> = new Set([
	"muse-spark-1.3",
	"muse-wonder-1.0",
	"muse-wonder-full-1.0",
]);

/** Recognize the documented, explicit Muse fingerprint opt-in values. */
export function isMuseUserAgentEnabled(env: MetaEnv = process.env): boolean {
	const configured = env[MUSE_USER_AGENT_ENV_VAR];
	if (typeof configured !== "string") return false;
	const value = configured.trim().toLowerCase();
	return value === "1" || value === "true" || value === "yes";
}

/**
 * Apply known literal-max support: always on MAX_EFFORT_MODEL_IDS, and on
 * fingerprint-dependent models only when opted in. A future server-advertised
 * mapping to a different effort remains authoritative. Runs on every model
 * list (fallbacks, catalog, cached restore) so a stale cached `max: null`
 * cannot mask known support.
 */
export function gateMuseMaxEffort(
	model: MetaProviderModel,
	env: MetaEnv = process.env,
): MetaProviderModel {
	const map = model.thinkingLevelMap;
	if (!map) return model;
	if (map.max != null && map.max !== "max") return model;

	let max: string | null;
	if (MAX_EFFORT_MODEL_IDS.has(model.id)) max = "max";
	else if (MUSE_USER_AGENT_MODEL_IDS.has(model.id))
		max = isMuseUserAgentEnabled(env) ? "max" : null;
	else return model;

	if (map.max === max) return model;
	return { ...model, thinkingLevelMap: { ...map, max } };
}
