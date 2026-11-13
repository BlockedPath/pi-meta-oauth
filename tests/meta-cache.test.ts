/// <reference types="bun-types" />
import { describe, expect, test } from "bun:test";
import type {
	AssistantMessage,
	Context,
	Model,
	SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import * as piAi from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-responses";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/compat";
import {
	applyMetaResponsesCacheHints,
	applyMetaUserAgentFingerprint,
	createMetaProviderConfig,
	isDirectMetaModelApiUrl,
	isMuseUserAgentEnabled,
	META_API_BASE_URL,
	META_ATTESTATION_DENIED_MESSAGE,
	META_PROMPT_CACHE_RETENTION,
	META_PROVIDER_ID,
	MUSE_USER_AGENT,
	MUSE_USER_AGENT_ENV_VAR,
	refreshMetaModels,
	toProviderModels,
} from "../extensions/meta.ts";
import { MAX_EFFORT_MODEL_IDS } from "../src/meta/muse-policy.ts";
import { forwardMetaStream } from "../src/meta/provider.ts";
import { resolveLiveMetaApiKey } from "./live-key.ts";
import { withMuseUserAgent } from "./muse-env.ts";

const LIVE_CACHE_MODEL = "muse-spark-1.2-contributor";
const LIVE_CACHE_KEY = "pi-meta-oauth-live-cache-probe-v1";

// Pi 0.86+ stream functions take a branded TranscriptContext built by
// normalizeContext(); Pi 0.83–0.85 take a plain Context and do not export
// normalizeContext. A namespace import keeps the file loadable on both.
function toStreamContext(context: Context): Parameters<typeof streamSimple>[1] {
	const normalize = (piAi as { normalizeContext?: (c: Context) => unknown })
		.normalizeContext;
	return (
		typeof normalize === "function" ? normalize(context) : context
	) as Parameters<typeof streamSimple>[1];
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
	model?: Model<"openai-responses">;
	headers?: SimpleStreamOptions["headers"];
	onPayload?: SimpleStreamOptions["onPayload"];
}): Promise<{
	url?: string;
	payload?: Record<string, unknown>;
	headers?: Headers;
}> {
	let url: string | undefined;
	let payload: Record<string, unknown> | undefined;
	let headers: Headers | undefined;
	const send = options?.applyHints
		? createMetaProviderConfig().streamSimple
		: streamSimple;
	if (!send) throw new Error("Expected Meta stream adapter");
	const events = send(
		options?.model ?? museModel(),
		toStreamContext({
			messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
		}),
		{
			apiKey: "test-key",
			sessionId: options?.sessionId ?? "sid",
			reasoning: options?.reasoning,
			cacheRetention: options?.cacheRetention,
			headers: options?.headers,
			fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
				url = String(input);
				headers = new Headers(init?.headers);
				payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
				return new Response("not a stream", { status: 400 });
			}) as typeof fetch,
			onPayload: options?.onPayload,
		},
	);
	for await (const _event of events) {
		// Drain until the mocked 400 terminates the stream.
	}
	return { url, payload, headers };
}

/** Meta's 403 for a Muse Code subscription key used outside Muse Code (observed 2026-11-01). */
const ATTESTATION_BODY = {
	error: {
		code: "client_attestation_denied",
		message:
			"This API key is billed to a Muse Code subscription. Muse Code subscriptions cover requests from the Muse Code client only. Use it in Muse Code, or use a pay-as-you-go API key for other clients.",
		param: null,
		type: "permission_error",
	},
};

const SUCCESS_SSE_ITEM = {
	type: "message",
	id: "msg_1",
	status: "completed",
	role: "assistant",
	content: [
		{ type: "output_text", text: "META_OK", annotations: [], logprobs: [] },
	],
};
const SUCCESS_SSE_BODY = [
	{ type: "response.created", response: { id: "resp_1" } },
	{
		type: "response.output_item.added",
		output_index: 0,
		item: { type: "message", id: "msg_1", role: "assistant", content: [] },
	},
	{
		type: "response.output_text.delta",
		output_index: 0,
		item_id: "msg_1",
		content_index: 0,
		delta: "META_OK",
	},
	{
		type: "response.output_item.done",
		output_index: 0,
		item: SUCCESS_SSE_ITEM,
	},
	{
		type: "response.completed",
		response: {
			id: "resp_1",
			object: "response",
			created_at: 0,
			status: "completed",
			model: "muse-spark-1.2-contributor",
			output: [SUCCESS_SSE_ITEM],
			usage: {
				input_tokens: 3,
				output_tokens: 2,
				total_tokens: 5,
				input_tokens_details: { cached_tokens: 0 },
				output_tokens_details: { reasoning_tokens: 0 },
			},
		},
	},
]
	.map((event) => `data: ${JSON.stringify(event)}\n\n`)
	.join("")
	.concat("data: [DONE]\n\n");

async function captureStreamFailure(options: {
	status: number;
	body: unknown;
	model?: Model<"openai-responses">;
}) {
	const send = createMetaProviderConfig().streamSimple;
	if (!send) throw new Error("Expected Meta stream adapter");
	const stream = send(
		options.model ?? museModel(),
		toStreamContext({
			messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
		}),
		{
			apiKey: "test-key",
			fetch: (async () =>
				new Response(JSON.stringify(options.body), {
					status: options.status,
					headers: { "Content-Type": "application/json" },
				})) as unknown as typeof fetch,
		},
	);
	const events: Array<{
		type: string;
		error?: { errorMessage?: string; stopReason?: string };
	}> = [];
	for await (const event of stream) {
		events.push(event as (typeof events)[number]);
	}
	return { events, finalMessage: await stream.result() };
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

	test("keeps off/max unmapped so Meta never receives reasoning.effort none by default", async () => {
		const models = await withMuseUserAgent(undefined, fallbackModels);
		for (const model of models) {
			expect(model.thinkingLevelMap?.off).toBeNull();
			if (MAX_EFFORT_MODEL_IDS.has(model.id)) {
				// Live-probed 2026-09-06 (Spark 1.3) and per PR #32 (Wonder):
				// these accept effort "max" with any User-Agent.
				expect(model.thinkingLevelMap?.max, model.id).toBe("max");
			} else {
				// Contributor variants need the opt-in Muse fingerprint for "max".
				expect(model.thinkingLevelMap?.max, model.id).toBeNull();
			}
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

	test("advertises only native text and image inputs", () => {
		for (const model of fallbackModels()) {
			expect(model.input).toEqual(["text", "image"]);
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

	test("applies request-local hints after an async payload replacement without discarding caller fields", async () => {
		const { payload } = await captureResponsesRequest({
			applyHints: true,
			onPayload: async (_payload, model) => ({
				model: model.id,
				input: "Replacement prompt",
				prompt_cache_retention: "in-memory",
				reasoning: { effort: "none" },
			}),
		});
		expect(payload).toEqual({
			model: "muse-spark-1.2-contributor",
			input: "Replacement prompt",
			prompt_cache_retention: "in-memory",
		});
	});
});

describe("Meta subscription attestation failures", () => {
	test("replaces the raw client_attestation_denied 403 with pay-as-you-go guidance", async () => {
		const { events, finalMessage } = await captureStreamFailure({
			status: 403,
			body: ATTESTATION_BODY,
		});
		const terminal = events.at(-1);
		expect(terminal?.type).toBe("error");
		expect(terminal?.error?.stopReason).toBe("error");
		expect(terminal?.error?.errorMessage).toContain(
			"Set META_API_KEY to a pay-as-you-go key",
		);
		expect(terminal?.error?.errorMessage).not.toContain('"param":null');
		expect(finalMessage.errorMessage).toBe(terminal?.error?.errorMessage);
		expect(finalMessage.stopReason).toBe("error");
	});

	test("leaves other provider failures untouched", async () => {
		const { finalMessage } = await captureStreamFailure({
			status: 403,
			body: {
				error: {
					code: "forbidden",
					message: "not allowed",
					type: "permission_error",
				},
			},
		});
		expect(finalMessage.errorMessage).toContain("forbidden");
		expect(finalMessage.errorMessage).not.toContain("Set META_API_KEY");
	});

	test("does not rewrite errors for another provider's model", async () => {
		const { finalMessage } = await captureStreamFailure({
			status: 403,
			body: ATTESTATION_BODY,
			model: { ...museModel(), provider: "openai" },
		});
		expect(finalMessage.errorMessage).toContain("client_attestation_denied");
		expect(finalMessage.errorMessage).not.toContain("Set META_API_KEY");
	});

	test("forwards a successful Responses stream unchanged", async () => {
		const send = createMetaProviderConfig().streamSimple;
		if (!send) throw new Error("Expected Meta stream adapter");
		const stream = send(
			museModel(),
			toStreamContext({
				messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
			}),
			{
				apiKey: "test-key",
				fetch: (async () =>
					new Response(SUCCESS_SSE_BODY, {
						status: 200,
						headers: { "Content-Type": "text/event-stream" },
					})) as unknown as typeof fetch,
			},
		);
		const types: string[] = [];
		for await (const event of stream) types.push(event.type);
		const finalMessage = await stream.result();
		expect(types).toEqual([
			"start",
			"text_start",
			"text_delta",
			"text_end",
			"done",
		]);
		expect(finalMessage.stopReason).toBe("stop");
		expect(finalMessage.content).toEqual([
			expect.objectContaining({ type: "text", text: "META_OK" }),
		]);
		expect(finalMessage.errorMessage).toBeUndefined();
	});

	test("still surfaces a missing-key setup failure as an error event", async () => {
		const send = createMetaProviderConfig().streamSimple;
		if (!send) throw new Error("Expected Meta stream adapter");
		const stream = send(
			museModel(),
			toStreamContext({
				messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
			}),
			{
				fetch: (async () =>
					new Response("unreachable")) as unknown as typeof fetch,
			},
		);
		// result()-only consumption: the adapter must drain upstream itself.
		const finalMessage = await stream.result();
		expect(finalMessage.stopReason).toBe("error");
		expect(finalMessage.errorMessage).toContain(
			"No API key for provider: meta",
		);
		expect(finalMessage.errorMessage).not.toContain("Set META_API_KEY");
	});

	test("settles with an error when upstream ends without a result", async () => {
		const model = museModel();
		const partial = {
			role: "assistant",
			content: [{ type: "text", text: "partial" }],
			api: "openai-responses",
			provider: model.provider,
			model: model.id,
			stopReason: "stop",
			timestamp: Date.now(),
		} as unknown as AssistantMessage;
		const upstream = createAssistantMessageEventStream();
		upstream.push({ type: "start", partial });
		upstream.end();

		const stream = forwardMetaStream(() => upstream, model);
		const types: string[] = [];
		for await (const event of stream) types.push(event.type);
		// Without the guard result() never resolves and this test times out.
		const finalMessage = await stream.result();
		expect(types).toEqual(["start", "error"]);
		expect(finalMessage.stopReason).toBe("error");
		expect(finalMessage.errorMessage).toBe(
			"Meta stream ended without a result",
		);
		expect(finalMessage.content).toEqual([{ type: "text", text: "partial" }]);
	});

	test("settles with an error when sending throws before any event", async () => {
		const model = museModel();
		const failures: Array<[string, string]> = [
			["connection reset", "connection reset"],
			["403 client_attestation_denied", META_ATTESTATION_DENIED_MESSAGE],
		];
		for (const [thrown, reported] of failures) {
			const stream = forwardMetaStream(() => {
				throw new Error(thrown);
			}, model);
			const finalMessage = await stream.result();
			expect(finalMessage).toMatchObject({
				role: "assistant",
				content: [],
				provider: META_PROVIDER_ID,
				model: model.id,
				stopReason: "error",
				errorMessage: reported,
			});
		}
	});
});

describe("Meta User-Agent fingerprint", () => {
	test("matches only the direct Meta Model API endpoint", () => {
		for (const baseUrl of [
			"https://api.meta.ai/v1",
			"https://api.meta.ai/v1/",
			"https://API.META.AI/v1",
			"https://api.meta.ai:443/v1",
		]) {
			expect(isDirectMetaModelApiUrl(baseUrl)).toBe(true);
		}
		for (const baseUrl of [
			"https://proxy.example/v1",
			"https://api.meta.ai.evil.com/v1",
			"https://evil.com/api.meta.ai/v1",
			"https://api.meta.ai:8443/v1",
			"https://api.meta.ai/v1/models",
			"https://api.meta.ai",
			"http://api.meta.ai/v1",
			"not a url",
			"",
			undefined,
			null,
		]) {
			expect(isDirectMetaModelApiUrl(baseUrl)).toBe(false);
		}
	});

	test("setdefaults the fingerprint and preserves explicit headers", () => {
		const fresh: Record<string, string | null> = {};
		expect(applyMetaUserAgentFingerprint(fresh, META_API_BASE_URL)).toBe(true);
		expect(fresh["User-Agent"]).toBe(MUSE_USER_AGENT);

		for (const headers of [
			{ "User-Agent": "custom-muse-client/1.0" },
			{ "user-agent": "custom-muse-client/1.0" },
			{ "User-Agent": null },
		] as Record<string, string | null>[]) {
			const copy = { ...headers };
			expect(applyMetaUserAgentFingerprint(copy, META_API_BASE_URL)).toBe(
				false,
			);
			expect(copy).toEqual(headers);
		}

		const proxied: Record<string, string | null> = {};
		expect(
			applyMetaUserAgentFingerprint(proxied, "https://proxy.example/v1"),
		).toBe(false);
		expect(proxied).toEqual({});
	});

	test("parses the META_MUSE_USER_AGENT opt-in strictly", () => {
		for (const value of ["1", "true", "TRUE", " yes "]) {
			expect(isMuseUserAgentEnabled({ [MUSE_USER_AGENT_ENV_VAR]: value })).toBe(
				true,
			);
		}
		for (const value of [undefined, "", "0", "false", "no", "on"]) {
			expect(isMuseUserAgentEnabled({ [MUSE_USER_AGENT_ENV_VAR]: value })).toBe(
				false,
			);
		}
	});

	test("stream adapter fingerprints only opted-in, direct Contributor 1.3 requests", async () => {
		const contributor = museModel("muse-spark-1.3-contributor");
		const headersFor = async (
			optIn: string | undefined,
			model: Model<"openai-responses">,
		) =>
			withMuseUserAgent(optIn, async () => {
				const result = await captureResponsesRequest({
					applyHints: true,
					model,
				});
				expect(result.url).toBe(`${model.baseUrl}/responses`);
				return result.headers?.get("user-agent");
			});

		// Opted in, direct endpoint, Contributor 1.3: fingerprinted.
		expect(await headersFor("1", contributor)).toBe(MUSE_USER_AGENT);
		// Default (not opted in): untouched, Pi's own User-Agent is kept.
		expect(await headersFor(undefined, contributor)).not.toBe(MUSE_USER_AGENT);
		expect(await headersFor("0", contributor)).not.toBe(MUSE_USER_AGENT);
		// Opted in but any other Meta model, provider, or endpoint: untouched.
		for (const model of [
			{ ...contributor, id: "muse-spark-1.3" },
			{ ...contributor, id: "muse-spark-1.2-contributor" },
			{ ...contributor, provider: "openai" },
			{ ...contributor, baseUrl: "https://proxy.example/v1" },
		]) {
			expect(await headersFor("1", model)).not.toBe(MUSE_USER_AGENT);
		}
	});

	test("stream adapter preserves model and request User-Agent overrides", async () => {
		await withMuseUserAgent("1", async () => {
			for (const name of ["User-Agent", "user-agent"]) {
				const model = {
					...museModel("muse-spark-1.3-contributor"),
					headers: { [name]: "custom-model" },
				};
				const modelOnly = await captureResponsesRequest({
					applyHints: true,
					model,
				});
				expect(modelOnly.headers?.get("user-agent")).toBe("custom-model");
				for (const value of ["custom-request", null]) {
					const result = await captureResponsesRequest({
						applyHints: true,
						model,
						headers: { [name]: value },
					});
					expect(result.headers?.get("user-agent")).toBe(value);
				}
			}
		});
	});

	test("exposes Contributor 1.3 max only when the fingerprint is opted in", async () => {
		const contributorMax = (
			models: { id: string; thinkingLevelMap?: { max?: string | null } }[],
		) =>
			models.find((model) => model.id === "muse-spark-1.3-contributor")
				?.thinkingLevelMap?.max;
		const bareCatalog = { data: [{ id: "muse-spark-1.3-contributor" }] };

		await withMuseUserAgent(undefined, () => {
			expect(contributorMax(fallbackModels())).toBeNull();
			expect(contributorMax(toProviderModels(bareCatalog))).toBeNull();
		});
		await withMuseUserAgent("1", () => {
			expect(contributorMax(fallbackModels())).toBe("max");
			expect(contributorMax(toProviderModels(bareCatalog))).toBe("max");
			// Opting in never adds max to models that reject it.
			const other = fallbackModels().find(
				(model) => model.id === "muse-spark-1.2-contributor",
			);
			expect(other?.thinkingLevelMap?.max).toBeNull();
		});

		// A server-advertised literal max still requires the fingerprint opt-in.
		await withMuseUserAgent(undefined, () => {
			const advertised = toProviderModels({
				data: [
					{
						id: "muse-spark-1.3-contributor",
						metadata: {
							"muse-code": { variants: { max: { reasoningEffort: "max" } } },
						},
					},
				],
			});
			expect(contributorMax(advertised)).toBeNull();
		});
	});

	test("re-gates Contributor max when restoring a cached catalog", async () => {
		const cachedWhileOptedIn = await withMuseUserAgent("1", () =>
			toProviderModels({ data: [{ id: "muse-spark-1.3-contributor" }] }),
		);
		const stored = {
			models: cachedWhileOptedIn.map((model) => ({
				...model,
				api: "openai-responses",
				provider: META_PROVIDER_ID,
				baseUrl: META_API_BASE_URL,
			})),
			checkedAt: Date.now(),
		};
		const restore = (optIn: string | undefined) =>
			withMuseUserAgent(optIn, () =>
				refreshMetaModels({
					allowNetwork: false,
					stored,
				} as unknown as Parameters<typeof refreshMetaModels>[0]),
			);

		expect((await restore(undefined))[0]?.thinkingLevelMap?.max).toBeNull();
		expect((await restore("1"))[0]?.thinkingLevelMap?.max).toBe("max");

		// A custom server-advertised effort name is not ours to gate.
		const customStored = {
			...stored,
			models: stored.models.map((model) => ({
				...model,
				thinkingLevelMap: { ...model.thinkingLevelMap, max: "ultra" },
			})),
		};
		const custom = await withMuseUserAgent(undefined, () =>
			refreshMetaModels({
				allowNetwork: false,
				stored: customStored,
			} as unknown as Parameters<typeof refreshMetaModels>[0]),
		);
		expect(custom[0]?.thinkingLevelMap?.max).toBe("ultra");
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

const liveFingerprintTest = liveApiKey ? test : test.skip;

async function callLiveContributorMax(
	apiKey: string,
	userAgent: string | undefined,
): Promise<{ status: number; body: Record<string, unknown> }> {
	const headers: Record<string, string> = {
		Accept: "application/json",
		Authorization: `Bearer ${apiKey}`,
		"Content-Type": "application/json",
		"x-api-version": "1.0.0",
	};
	if (userAgent !== undefined) headers["User-Agent"] = userAgent;
	const response = await fetch(`${META_API_BASE_URL}/responses`, {
		method: "POST",
		headers,
		body: JSON.stringify({
			model: "muse-spark-1.3-contributor",
			input: "Reply with the single word pong.",
			stream: false,
			store: false,
			reasoning: { effort: "max", summary: "auto" },
			max_output_tokens: 32,
		}),
	});
	return {
		status: response.status,
		body: (await response.json()) as Record<string, unknown>,
	};
}

describe("Meta live fingerprint probe", () => {
	liveFingerprintTest(
		"contributor max is accepted with the Muse fingerprint",
		async () => {
			if (!liveApiKey) throw new Error("PI_META_LIVE_API_KEY is required");
			// Informational only: observed 2026-09-25 as HTTP 400 without the
			// fingerprint. Not asserted, so the suite keeps passing if Meta ever
			// opens Contributor max to every client.
			const bare = await callLiveContributorMax(liveApiKey, undefined);
			console.info(
				`[live] contributor max without fingerprint: HTTP ${bare.status}`,
			);

			// With it, the same payload is accepted and echoes effort "max".
			// The tiny output budget may truncate visible text; only the
			// acceptance and the echoed effort are asserted.
			const fingerprinted = await callLiveContributorMax(
				liveApiKey,
				MUSE_USER_AGENT,
			);
			expect(fingerprinted.status).toBe(200);
			expect(fingerprinted.body).toMatchObject({
				model: "muse-spark-1.3-contributor",
				reasoning: { effort: "max" },
			});
		},
		120_000,
	);
});
