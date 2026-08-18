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
import { callMetaResponses } from "../extensions/media/responses.ts";

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

	test("keeps off/max unmapped so Meta never receives reasoning.effort none by default", () => {
		for (const model of fallbackModels()) {
			expect(model.thinkingLevelMap?.off).toBeNull();
			expect(model.thinkingLevelMap?.max).toBeNull();
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

	test("advertises video and audio on bundled Muse models", () => {
		for (const model of fallbackModels()) {
			expect(model.input).toEqual(
				expect.arrayContaining(["text", "image", "video", "audio"]),
			);
		}
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

	test("direct media Responses calls also send the 24h retention hint", async () => {
		const originalFetch = globalThis.fetch;
		let url = "";
		let body: Record<string, unknown> | undefined;
		globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			url = String(input);
			body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
			return new Response(JSON.stringify({ output_text: "ok" }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}) as typeof fetch;
		try {
			await callMetaResponses("test-key", {
				model: "muse-spark-1.2",
				input: [],
			});
		} finally {
			globalThis.fetch = originalFetch;
		}
		expect(url).toBe("https://api.meta.ai/v1/responses");
		expect(body).toMatchObject({
			model: "muse-spark-1.2",
			store: false,
			prompt_cache_retention: "24h",
		});
	});
});
