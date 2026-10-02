import { describe, expect, test } from "bun:test";
import {
	META_API_BASE_URL,
	META_PROVIDER_ID,
	MUSE_USER_AGENT,
	MUSE_USER_AGENT_ENV_VAR,
} from "../src/meta/constants.ts";
import {
	gateMuseMaxEffort,
	isMuseUserAgentEnabled,
} from "../src/meta/muse-policy.ts";
import {
	applyMetaModelHeaders,
	applyMetaResponsesCacheHints,
	applyMetaUserAgentFingerprint,
	isDirectMetaModelApiUrl,
} from "../src/meta/request-policy.ts";
import type { MetaEnv, MetaProviderModel } from "../src/meta/types.ts";
import { withMuseUserAgent } from "./muse-env.ts";

const enabled: MetaEnv = { [MUSE_USER_AGENT_ENV_VAR]: "yes" };
const contributor = {
	provider: META_PROVIDER_ID,
	id: "muse-spark-1.3-contributor",
	baseUrl: META_API_BASE_URL,
};

function providerModel(id: string, max: string | null): MetaProviderModel {
	return {
		id,
		name: id,
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000,
		maxTokens: 100,
		thinkingLevelMap: { high: "high", max },
	};
}

describe("Muse effort policy", () => {
	test("changes gated max immutably and shares unchanged model objects", () => {
		const original = providerModel(contributor.id, null);
		const optedIn = gateMuseMaxEffort(original, enabled);
		expect(optedIn).not.toBe(original);
		expect(optedIn.thinkingLevelMap).toEqual({ high: "high", max: "max" });
		expect(original.thinkingLevelMap?.max).toBeNull();
		expect(gateMuseMaxEffort(optedIn, enabled)).toBe(optedIn);

		const restored = gateMuseMaxEffort(optedIn, {});
		expect(restored.thinkingLevelMap).toEqual({ high: "high", max: null });
		expect(optedIn.thinkingLevelMap?.max).toBe("max");
		expect(gateMuseMaxEffort(original, {})).toBe(original);
	});

	test("preserves standard models and explicit alternative effort mappings", () => {
		for (const model of [
			providerModel("muse-spark-1.3", "max"),
			providerModel("muse-spark-future", "ultra"),
			providerModel(contributor.id, "ultra"),
			{ ...providerModel(contributor.id, null), thinkingLevelMap: undefined },
		]) {
			expect(gateMuseMaxEffort(model, {})).toBe(model);
			expect(gateMuseMaxEffort(model, enabled)).toBe(model);
		}
	});

	test("reads the default environment through the hermetic Muse helper", async () => {
		await withMuseUserAgent(undefined, () => {
			expect(isMuseUserAgentEnabled()).toBe(false);
			expect(
				gateMuseMaxEffort(providerModel(contributor.id, "max")).thinkingLevelMap
					?.max,
			).toBeNull();
		});
		await withMuseUserAgent(" TRUE ", () => {
			expect(isMuseUserAgentEnabled()).toBe(true);
			expect(
				gateMuseMaxEffort(providerModel(contributor.id, null)).thinkingLevelMap
					?.max,
			).toBe("max");
		});
	});
});

describe("Meta provider header policy", () => {
	test("applies the complete opt-in policy to a direct Contributor request", () => {
		const headers: Record<string, string | null> = {
			Authorization: "Bearer test-key",
		};
		expect(applyMetaModelHeaders(headers, contributor, enabled)).toBe(true);
		expect(headers).toEqual({
			Authorization: "Bearer test-key",
			"User-Agent": MUSE_USER_AGENT,
		});
	});

	test("requires the provider, model, endpoint, and explicit opt-in together", () => {
		for (const model of [
			undefined,
			null,
			[],
			"meta",
			{},
			{ ...contributor, provider: "openai" },
			{ ...contributor, id: "muse-spark-1.3" },
			{ ...contributor, id: "muse-spark-1.2-contributor" },
			{ ...contributor, id: null },
			{ ...contributor, baseUrl: undefined },
			{ ...contributor, baseUrl: "https://proxy.example/v1" },
		]) {
			const headers = { "X-Request-ID": "test" };
			expect(applyMetaModelHeaders(headers, model, enabled)).toBe(false);
			expect(headers).toEqual({ "X-Request-ID": "test" });
		}
		for (const optIn of [undefined, "", "0", "false", "on"]) {
			const headers = {};
			expect(
				applyMetaModelHeaders(headers, contributor, {
					[MUSE_USER_AGENT_ENV_VAR]: optIn,
				}),
			).toBe(false);
			expect(headers).toEqual({});
		}
	});

	test("preserves explicit custom and suppressed User-Agent headers in any casing", () => {
		for (const name of [
			"User-Agent",
			"user-agent",
			"USER-AGENT",
			"uSeR-aGeNt",
		]) {
			for (const value of ["custom/1.0", "", null]) {
				const headers = { [name]: value };
				expect(applyMetaModelHeaders(headers, contributor, enabled)).toBe(
					false,
				);
				expect(headers).toEqual({ [name]: value });
			}
		}
	});

	test("rejects credential-bearing, queried, and fragmented base URLs", () => {
		for (const baseUrl of [
			"https://user:password@api.meta.ai/v1",
			"https://user@api.meta.ai/v1",
			"https://api.meta.ai/v1?route=other",
			"https://api.meta.ai/v1?",
			"https://api.meta.ai/v1#fragment",
			"https://api.meta.ai/v1#",
			"https://api.meta.ai:8443/v1",
			"https://api.meta.ai.evil.com/v1",
			"https://api.meta.ai/v1/responses",
			"http://api.meta.ai/v1",
		]) {
			expect(isDirectMetaModelApiUrl(baseUrl)).toBe(false);
			const headers = {};
			expect(
				applyMetaModelHeaders(headers, { ...contributor, baseUrl }, enabled),
			).toBe(false);
			expect(headers).toEqual({});
		}
	});

	test("keeps the public low-level fingerprint helper independent of opt-in", async () => {
		await withMuseUserAgent(undefined, () => {
			const headers = {};
			expect(applyMetaUserAgentFingerprint(headers, META_API_BASE_URL)).toBe(
				true,
			);
			expect(headers).toEqual({ "User-Agent": MUSE_USER_AGENT });
		});
	});
});

describe("Meta Responses payload policy", () => {
	test("ignores malformed payloads without throwing", () => {
		for (const payload of [undefined, null, [], "text", 42, false]) {
			expect(applyMetaResponsesCacheHints(payload)).toBeUndefined();
		}
	});

	test("mutates the existing payload while preserving explicit cache values", () => {
		for (const retention of [null, "in_memory", "24h", "", false, 0]) {
			const payload = {
				prompt_cache_retention: retention,
				reasoning: { effort: "high", summary: "auto" },
			};
			expect(applyMetaResponsesCacheHints(payload)).toBe(payload);
			expect(payload).toEqual({
				prompt_cache_retention: retention,
				reasoning: { effort: "high", summary: "auto" },
			});
		}
	});

	test("drops unsupported absent, null, and none reasoning efforts", () => {
		for (const reasoning of [
			{},
			{ summary: "auto" },
			{ effort: undefined },
			{ effort: null },
			{ effort: "none" },
		]) {
			const payload: Record<string, unknown> = { reasoning, input: "test" };
			expect(applyMetaResponsesCacheHints(payload)).toBe(payload);
			expect(payload).toEqual({ input: "test", prompt_cache_retention: "24h" });
		}
	});
});
