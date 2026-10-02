import {
	META_PROMPT_CACHE_RETENTION,
	META_PROVIDER_ID,
	MUSE_USER_AGENT,
} from "./constants.ts";
import { asRecord } from "./http.ts";
import {
	isMuseUserAgentEnabled,
	MUSE_USER_AGENT_MODEL_IDS,
} from "./muse-policy.ts";
import type { MetaEnv } from "./types.ts";

type ProviderHeaders = Record<string, string | null>;

/**
 * Match the direct HTTPS Meta /v1 endpoint, allowing URL-normalized equivalent
 * hostnames, the default port, and trailing slashes. Other hosts, paths, schemes,
 * and ports never receive the Muse client fingerprint.
 */
export function isDirectMetaModelApiUrl(baseUrl: unknown): boolean {
	if (typeof baseUrl !== "string" || !baseUrl) return false;
	// URL.search/hash omit empty delimiters, which still break path appending.
	if (baseUrl.includes("?") || baseUrl.includes("#")) return false;
	try {
		const parsed = new URL(baseUrl);
		return (
			parsed.protocol === "https:" &&
			parsed.hostname.toLowerCase() === "api.meta.ai" &&
			parsed.port === "" &&
			parsed.username === "" &&
			parsed.password === "" &&
			parsed.pathname.replace(/\/+$/, "") === "/v1"
		);
	} catch {
		return false;
	}
}

/**
 * Set the fingerprint only on direct endpoints without an explicit User-Agent.
 * Header names are case-insensitive; null is an explicit suppression and wins.
 * The caller owns provider, model, and opt-in checks; use applyMetaModelHeaders
 * when handling provider events.
 */
export function applyMetaUserAgentFingerprint(
	headers: ProviderHeaders,
	baseUrl: unknown,
): boolean {
	if (!isDirectMetaModelApiUrl(baseUrl) || !asRecord(headers)) return false;
	if (
		Object.keys(headers).some((name) => name.toLowerCase() === "user-agent")
	) {
		return false;
	}
	headers["User-Agent"] = MUSE_USER_AGENT;
	return true;
}

/** Apply every fingerprint guard in one place for the provider headers hook. */
export function applyMetaModelHeaders(
	headers: ProviderHeaders,
	model: unknown,
	env: MetaEnv = process.env,
): boolean {
	const requestModel = asRecord(model);
	if (
		requestModel?.provider !== META_PROVIDER_ID ||
		typeof requestModel.id !== "string" ||
		!MUSE_USER_AGENT_MODEL_IDS.has(requestModel.id) ||
		!isMuseUserAgentEnabled(env)
	) {
		return false;
	}
	return applyMetaUserAgentFingerprint(headers, requestModel.baseUrl);
}

/** Set the Responses cache default and remove unsupported empty/none reasoning. */
export function applyMetaResponsesCacheHints(
	payload: unknown,
): Record<string, unknown> | undefined {
	const body = asRecord(payload);
	if (!body) return undefined;
	if (body.prompt_cache_retention === undefined) {
		body.prompt_cache_retention = META_PROMPT_CACHE_RETENTION;
	}
	const reasoning = asRecord(body.reasoning);
	if (
		reasoning &&
		(reasoning.effort === "none" ||
			reasoning.effort === undefined ||
			reasoning.effort === null)
	) {
		delete body.reasoning;
	}
	return body;
}
