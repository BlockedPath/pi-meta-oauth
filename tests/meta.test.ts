/// <reference types="bun-types" />
import { describe, expect, test } from "bun:test";
import {
	createMetaProviderConfig,
	loginMeta,
	META_MODEL_CATALOG_URL,
	mintMetaApiKey,
	toProviderModels,
} from "../extensions/meta.ts";

const LIVE_CATALOG_SNAPSHOT_2026_08_10 = [
	"muse-spark-1.2",
	"muse-spark-1.2-contributor",
	"muse-spark-1.1",
];
const liveApiKey = process.env.PI_META_LIVE_API_KEY;
const liveCatalogTest = liveApiKey ? test : test.skip;

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

describe("Meta OAuth provider", () => {
	test("maps the Muse catalog into Pi model metadata", () => {
		const models = toProviderModels({
			data: [
				{
					id: "muse-spark-test",
					metadata: {
						"muse-code": {
							name: "Muse Spark Test",
							reasoning: true,
							modalities: { input: ["text", "image"] },
							limit: { context: 123_000, output: 45_000 },
							variants: { high: { reasoningEffort: "deep" } },
							cost: { input: "1.25", output: "4.25", cached: "0.15" },
						},
					},
				},
				{ id: "hidden", metadata: { "muse-code": { is_hidden: true } } },
			],
		});

		expect(models).toHaveLength(1);
		expect(models[0]).toMatchObject({
			id: "muse-spark-test",
			name: "Muse Spark Test",
			input: ["text", "image"],
			contextWindow: 123_000,
			maxTokens: 45_000,
			cost: { input: 1.25, output: 4.25, cacheRead: 0.15, cacheWrite: 0 },
			thinkingLevelMap: { off: null, high: "deep", max: null },
			compat: { supportsReasoningEffort: true, supportsToolSearch: true },
		});
	});

	// Live-endpoint drift, observed 2026-08-10: GET /v1/models returned bare
	// OpenAI-style objects -- {id, object, created, owned_by} -- without a
	// metadata["muse-code"] block. Known IDs map entirely from FALLBACK_MODELS;
	// unknown IDs now also map with fallback defaults (relaxed gate) so future
	// models appear without code changes — missing limits/costs fall back to
	// defaults via finitePositive()/numericCost() (empty/whitespace cost strings
	// treated as missing).
	test("maps known bare catalog entries to complete bundled metadata", () => {
		const models = toProviderModels({
			data: LIVE_CATALOG_SNAPSHOT_2026_08_10.map((id) => ({ id })),
		});

		expect(models).toEqual(createMetaProviderConfig().models ?? []);
	});

	test("maps unknown IDs with incomplete metadata to fallback defaults", () => {
		const models = toProviderModels({
			data: [
				{ id: "muse-bare-unknown" },
				{ id: "muse-empty-metadata", metadata: { "muse-code": {} } },
				{
					id: "muse-missing-limits",
					metadata: {
						"muse-code": { cost: { input: "1", output: "2" } },
					},
				},
				{
					id: "muse-missing-output-cost",
					metadata: {
						"muse-code": {
							limit: { context: 123_000, output: 45_000 },
							cost: { input: "1" },
						},
					},
				},
				{
					id: "muse-blank-input-cost",
					metadata: {
						"muse-code": {
							limit: { context: 123_000, output: 45_000 },
							cost: { input: " ", output: "2" },
						},
					},
				},
				{
					id: "muse-metadata-unknown",
					metadata: {
						"muse-code": {
							name: "Muse Metadata Unknown",
							modalities: { input: ["text"] },
							limit: { context: 123_000, output: 45_000 },
							cost: { input: "1", output: "2", cached: "0.1" },
						},
					},
				},
			],
		});

		// Relaxed gate: every non-hidden id is emitted; missing fields fall back.
		expect(models).toHaveLength(6);
		const byId = Object.fromEntries(models.map((m) => [m.id, m]));
		expect(byId["muse-bare-unknown"]).toMatchObject({
			contextWindow: 1_048_576,
			maxTokens: 256_000,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		});
		expect(byId["muse-empty-metadata"]).toMatchObject({
			contextWindow: 1_048_576,
			maxTokens: 256_000,
		});
		expect(byId["muse-missing-limits"]).toMatchObject({
			contextWindow: 1_048_576,
			maxTokens: 256_000,
			cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
		});
		expect(byId["muse-missing-output-cost"]).toMatchObject({
			contextWindow: 123_000,
			maxTokens: 45_000,
			cost: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 },
		});
		// Blank/whitespace cost strings are treated as missing → fallback, not 0-as-free.
		expect(byId["muse-blank-input-cost"]).toMatchObject({
			contextWindow: 123_000,
			maxTokens: 45_000,
			cost: { input: 0, output: 2, cacheRead: 0, cacheWrite: 0 },
		});
		expect(byId["muse-metadata-unknown"]).toMatchObject({
			id: "muse-metadata-unknown",
			name: "Muse Metadata Unknown",
			contextWindow: 123_000,
			maxTokens: 45_000,
			cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 },
		});
	});

	test("bundled fallbacks cover the 2026-08-10 live catalog snapshot", () => {
		const fallbackIDs = new Set(
			(createMetaProviderConfig().models ?? []).map((model) => model.id),
		);

		for (const id of LIVE_CATALOG_SNAPSHOT_2026_08_10) {
			expect(fallbackIDs.has(id)).toBe(true);
		}
	});

	liveCatalogTest("live catalog IDs have bundled fallbacks", async () => {
		if (!liveApiKey) throw new Error("PI_META_LIVE_API_KEY is required");
		const response = await fetch(META_MODEL_CATALOG_URL, {
			headers: {
				Accept: "application/json",
				Authorization: `Bearer ${liveApiKey}`,
				"x-api-version": "1.0.0",
			},
		});
		if (!response.ok) {
			throw new Error(`Meta model catalog failed (HTTP ${response.status})`);
		}
		const body = (await response.json()) as {
			data?: Array<{ id?: unknown }>;
		};
		const liveIDs = (body.data ?? []).flatMap((entry) =>
			typeof entry.id === "string" && entry.id ? [entry.id] : [],
		);
		const fallbackIDs = new Set(
			(createMetaProviderConfig().models ?? []).map((model) => model.id),
		);

		expect(liveIDs).not.toHaveLength(0);
		expect(liveIDs.filter((id) => !fallbackIDs.has(id))).toEqual([]);
	});

	test("enables tool search for fallback models", () => {
		const models = createMetaProviderConfig().models ?? [];

		expect(models).not.toHaveLength(0);
		expect(
			models.every((model) => {
				const compat = model.compat;
				return (
					compat !== undefined &&
					"supportsToolSearch" in compat &&
					compat.supportsToolSearch === true
				);
			}),
		).toBe(true);
	});

	test("runs device login, polls, and mints a Model API key", async () => {
		const requests: Array<{ url: string; authorization?: string }> = [];
		const responses = [
			jsonResponse({
				device_code: "device-token",
				user_code: "ABCD-1234",
				verification_uri: "https://auth.meta.com/device",
				verification_uri_complete: "https://auth.meta.com/device?code=ABCD-1234",
				expires_in: 900,
				interval: 1,
			}),
			jsonResponse({ error: "authorization_pending" }, 400),
			jsonResponse({ access_token: "identity-token" }),
			jsonResponse({
				api_key: "model-api-key",
				base_url: "https://api.meta.ai/v1",
			}),
		];
		const fetchMock = (async (
			input: string | URL | Request,
			init?: RequestInit,
		) => {
			const headers = new Headers(init?.headers);
			requests.push({
				url: String(input),
				authorization: headers.get("Authorization") ?? undefined,
			});
			const response = responses.shift();
			if (!response) throw new Error("Unexpected request");
			return response;
		}) as unknown as typeof fetch;
		const deviceCodes: unknown[] = [];
		const credentials = await loginMeta(
			{
				onAuth() {},
				onDeviceCode(value: unknown) {
					deviceCodes.push(value);
				},
				onPrompt: async () => "",
				onSelect: async () => undefined,
			},
			fetchMock,
			async () => {},
		);

		expect(deviceCodes).toEqual([
			{
				userCode: "ABCD-1234",
				verificationUri: "https://auth.meta.com/device?code=ABCD-1234",
				intervalSeconds: 1,
				expiresInSeconds: 900,
			},
		]);
		expect(credentials.refresh).toBe("identity-token");
		expect(credentials.access).toBe("model-api-key");
		expect(requests.at(-1)?.authorization).toBe("Bearer identity-token");
	});

	test("reports account setup when minting yields no API key", async () => {
		const fetchMock = (async () =>
			jsonResponse({
				require_payment: true,
				action_url: "https://dev.meta.ai/billing",
			})) as unknown as typeof fetch;
		await expect(mintMetaApiKey("identity-token", fetchMock)).rejects.toThrow(
			"Complete setup at https://dev.meta.ai/billing",
		);
	});
});
