/// <reference types="bun-types" />
import { describe, expect, test } from "bun:test";
import type { Model } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-responses";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	applyMetaResponsesCacheHints,
	createMetaProviderConfig,
	META_API_BASE_URL,
	META_PROMPT_CACHE_RETENTION,
	META_PROVIDER_ID,
	toProviderModels,
} from "../extensions/meta.ts";
import metaOAuthProvider from "../extensions/meta.ts";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const LIVE_CACHE_MODEL = "muse-spark-1.2-contributor";
const LIVE_CACHE_KEY = "pi-meta-oauth-live-cache-probe-v1";

function resolveLiveMetaApiKey(): string | undefined {
	for (const value of [
		process.env.PI_META_LIVE_API_KEY,
		process.env.META_API_KEY,
		process.env.MODEL_API_KEY,
	]) {
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	try {
		const auth = JSON.parse(
			readFileSync(join(homedir(), ".pi/agent/auth.json"), "utf8"),
		) as { meta?: { access?: unknown; expires?: unknown } };
		// auth.meta.expires is epoch milliseconds; an expired token must not turn
		// every test run into a hard 401 — treat it as no credential.
		if (
			typeof auth.meta?.expires === "number" &&
			auth.meta.expires <= Date.now()
		) {
			return undefined;
		}
		return typeof auth.meta?.access === "string" && auth.meta.access.trim()
			? auth.meta.access.trim()
			: undefined;
	} catch {
		return undefined;
	}
}

const liveApiKey = resolveLiveMetaApiKey();
const liveCacheTest = liveApiKey ? test : test.skip;

function fallbackModels() {
	const models = createMetaProviderConfig().models ?? [];
	if (models.length === 0) throw new Error("Meta fallback models are required");
	return models;
}

function museModel(
	id = "muse-spark-1.2-contributor",
): Model<"openai-responses"> {
	const fallback =
		fallbackModels().find((model) => model.id === id) ?? fallbackModels()[0];
	if (!fallback) throw new Error("Meta fallback model is required");
	return {
		...fallback,
		api: "openai-responses",
		provider: META_PROVIDER_ID,
		baseUrl: META_API_BASE_URL,
		input: fallback.input as Model<"openai-responses">["input"],
		compat: fallback.compat as Model<"openai-responses">["compat"],
	};
}

async function captureResponsesRequest(options?: {
	reasoning?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	cacheRetention?: "none" | "short" | "long";
	sessionId?: string;
	applyHints?: boolean;
}): Promise<{ url?: string; payload?: Record<string, unknown> }> {
	let url: string | undefined;
	let payload: Record<string, unknown> | undefined;
	const events = streamSimple(
		museModel(),
		{
			messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
		},
		{
			apiKey: "test-key",
			sessionId: options?.sessionId ?? "sid",
			reasoning: options?.reasoning,
			cacheRetention: options?.cacheRetention,
			fetch: (async (input: RequestInfo | URL) => {
				url = String(input);
				return new Response("not a stream", { status: 400 });
			}) as typeof fetch,
			onPayload: (next) => {
				const hinted = options?.applyHints
					? applyMetaResponsesCacheHints(next)
					: next;
				payload =
					hinted && typeof hinted === "object"
						? (hinted as Record<string, unknown>)
						: undefined;
				return hinted;
			},
		},
	);
	for await (const _event of events) {
		// Drain until the mocked 400 terminates the stream.
	}
	return { url, payload };
}

describe("Meta Responses cache and reasoning contracts", () => {
	test("routes Muse through openai-responses on api.meta.ai", () => {
		const config = createMetaProviderConfig();
		expect(config.api).toBe("openai-responses");
		expect(config.baseUrl).toBe("https://api.meta.ai/v1");
		expect(config.baseUrl).toBe(META_API_BASE_URL);
		expect(new URL(META_API_BASE_URL).hostname).toBe("api.meta.ai");
	});

	test("does not disable long prompt-cache retention on fallback or catalog models", () => {
		for (const model of [
			...fallbackModels(),
			...toProviderModels({ data: [{ id: "muse-spark-1.2" }] }),
		]) {
			const compat = model.compat as
				| { supportsLongCacheRetention?: boolean }
				| undefined;
			expect(compat?.supportsLongCacheRetention).not.toBe(false);
		}
	});

	test("prices contributor cache reads at the measured 50x discount", () => {
		const contributor = fallbackModels().find(
			(model) => model.id === "muse-spark-1.2-contributor",
		);
		expect(contributor?.cost).toMatchObject({
			input: 0.1,
			cacheRead: 0.002,
		});
		expect(
			contributor && contributor.cost.input / contributor.cost.cacheRead,
		).toBe(50);
	});

	test("keeps off unmapped so Meta never receives reasoning.effort none by default", () => {
		for (const model of fallbackModels()) {
			expect(model.thinkingLevelMap?.off).toBeNull();
			// 1.3 standard is the only Spark that maps thinking `max` → `max`.
			expect(model.thinkingLevelMap?.max).toBe(
				model.id === "muse-spark-1.3" ? "max" : null,
			);
		}
		const catalogued = toProviderModels({
			data: [
				{
					id: "muse-spark-1.2",
					metadata: {
						"muse-code": {
							variants: { off: { reasoningEffort: "none" } },
						},
					},
				},
			],
		});
		expect(catalogued[0]?.thinkingLevelMap).toMatchObject({
			off: null,
			max: null,
		});
	});

	test("advertises text/image plus video/audio inputs on fallbacks", () => {
		for (const model of fallbackModels()) {
			expect(model.input).toEqual(["text", "image", "video", "audio"]);
		}
		expect(
			toProviderModels({
				data: [
					{
						id: "muse-spark-test",
						metadata: {
							"muse-code": {
								modalities: {
									input: ["text", "image", "video", "audio", "pdf"],
								},
							},
						},
					},
				],
			})[0]?.input,
		).toEqual(["text", "image"]);
	});

	test("setdefault prompt_cache_retention 24h and preserve an explicit override", () => {
		expect(
			applyMetaResponsesCacheHints({ model: "muse-spark-1.2" }),
		).toMatchObject({
			model: "muse-spark-1.2",
			prompt_cache_retention: META_PROMPT_CACHE_RETENTION,
		});
		expect(
			applyMetaResponsesCacheHints({
				prompt_cache_retention: "in_memory",
			}),
		).toMatchObject({ prompt_cache_retention: "in_memory" });
	});

	test("strips reasoning.effort none because Meta rejects it", () => {
		expect(
			applyMetaResponsesCacheHints({
				reasoning: { effort: "none", summary: "auto" },
			}),
		).toEqual({ prompt_cache_retention: "24h" });
		expect(
			applyMetaResponsesCacheHints({
				reasoning: { effort: "high", summary: "auto" },
			}),
		).toMatchObject({
			reasoning: { effort: "high", summary: "auto" },
		});
	});

	test("pi-ai hits /v1/responses, not /chat/completions", async () => {
		const { url, payload } = await captureResponsesRequest();
		expect(url).toContain("https://api.meta.ai/v1/responses");
		expect(url).not.toContain("/chat/completions");
		expect(payload).toMatchObject({
			model: "muse-spark-1.2-contributor",
			store: false,
		});
		expect(payload).toHaveProperty("input");
	});

	test("default Muse request omits reasoning and gains 24h retention after hints", async () => {
		const raw = await captureResponsesRequest();
		expect(raw.payload).not.toHaveProperty("reasoning");
		expect(raw.payload?.prompt_cache_retention).toBeUndefined();

		const hinted = await captureResponsesRequest({ applyHints: true });
		expect(hinted.payload).not.toHaveProperty("reasoning");
		expect(hinted.payload?.prompt_cache_retention).toBe("24h");
	});

	test("high reasoning effort passes through with an auto summary", async () => {
		const { payload } = await captureResponsesRequest({
			reasoning: "high",
			applyHints: true,
		});
		expect(payload?.reasoning).toEqual({ effort: "high", summary: "auto" });
	});

	test("prompt_cache_key is session-addressed and stable across identical calls", async () => {
		const first = await captureResponsesRequest({
			sessionId: "stable-session",
			applyHints: true,
		});
		const second = await captureResponsesRequest({
			sessionId: "stable-session",
			applyHints: true,
		});
		expect(typeof first.payload?.prompt_cache_key).toBe("string");
		expect(first.payload?.prompt_cache_key).toBe(
			second.payload?.prompt_cache_key,
		);
		expect(first.payload?.prompt_cache_key).not.toBe(
			(
				await captureResponsesRequest({
					sessionId: "other-session",
					applyHints: true,
				})
			).payload?.prompt_cache_key,
		);
	});

	test("registers a Meta-only before_provider_request hook that applies the hints", async () => {
		type RequestHandler = (
			event: { payload: unknown },
			ctx: { model?: { provider: string } },
		) => unknown;
		let handler: RequestHandler | undefined;
		metaOAuthProvider({
			registerProvider() {},
			on(event: string, next: unknown) {
				if (event === "before_provider_request") {
					handler = next as RequestHandler;
				}
			},
		} as unknown as ExtensionAPI);
		expect(handler).toBeDefined();

		const other = handler?.(
			{ payload: { model: "gpt" } },
			{ model: { provider: "openai" } },
		);
		expect(other).toBeUndefined();

		const meta = handler?.(
			{ payload: { model: "muse-spark-1.2" } },
			{ model: { provider: META_PROVIDER_ID } },
		);
		expect(meta).toMatchObject({
			model: "muse-spark-1.2",
			prompt_cache_retention: "24h",
		});
	});
});

function liveCachePrefix(): string {
	const lines: string[] = [
		"This block is a fixed Muse prompt-cache probe. Keep it byte-identical.",
	];
	let n = 0;
	while (lines.join("\n").length < 16_000) {
		n += 1;
		lines.push(
			`${n}. Identical prefix line for prompt-cache measurement across two calls.`,
		);
	}
	return lines.join("\n");
}

function liveCachePayload(): Record<string, unknown> {
	return {
		model: LIVE_CACHE_MODEL,
		prompt_cache_key: LIVE_CACHE_KEY,
		max_output_tokens: 16,
		input: [
			{
				type: "message",
				role: "user",
				content: [
					{
						type: "input_text",
						text: `${liveCachePrefix()}\n\nReply with the single word pong.`,
					},
				],
			},
		],
	};
}

interface LiveResponseUsage {
	input_tokens?: number;
	output_tokens?: number;
	input_tokens_details?: { cached_tokens?: number };
}

interface LiveResponse {
	usage?: LiveResponseUsage;
}

async function callLiveMetaResponses(
	apiKey: string,
	payload: Record<string, unknown>,
): Promise<LiveResponse> {
	const body = applyMetaResponsesCacheHints({ ...payload, store: false });
	const response = await fetch(`${META_API_BASE_URL}/responses`, {
		method: "POST",
		headers: {
			Accept: "application/json",
			Authorization: `Bearer ${apiKey}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
	});
	const raw = (await response.json()) as LiveResponse;
	if (!response.ok) {
		throw new Error(
			`Meta Responses cache probe failed (HTTP ${response.status}): ${JSON.stringify(raw).slice(0, 500)}`,
		);
	}
	return raw;
}

function usageSummary(raw: LiveResponse): string {
	const input = raw.usage?.input_tokens ?? 0;
	const output = raw.usage?.output_tokens ?? 0;
	const cacheRead = raw.usage?.input_tokens_details?.cached_tokens ?? 0;
	const pct = input > 0 ? Math.round((cacheRead / input) * 100) : 0;
	return `cache=${cacheRead}/${input} (${pct}%) input=${input - cacheRead} output=${output}`;
}

describe("Meta live prompt-cache probe", () => {
	liveCacheTest(
		"second identical Responses call reports cached tokens",
		async () => {
			if (!liveApiKey) throw new Error("PI_META_LIVE_API_KEY is required");
			const payload = liveCachePayload();
			const first = await callLiveMetaResponses(liveApiKey, { ...payload });
			let second = await callLiveMetaResponses(liveApiKey, { ...payload });
			let cacheRead = second.usage?.input_tokens_details?.cached_tokens ?? 0;
			if (!cacheRead) {
				await Bun.sleep(2_000);
				second = await callLiveMetaResponses(liveApiKey, { ...payload });
				cacheRead = second.usage?.input_tokens_details?.cached_tokens ?? 0;
			}
			expect(
				second.usage?.input_tokens,
				`first ${usageSummary(first)}`,
			).toBeGreaterThan(1_000);
			expect(
				cacheRead,
				`first ${usageSummary(first)}; second ${usageSummary(second)}`,
			).toBeGreaterThan(0);
		},
		120_000,
	);
});
