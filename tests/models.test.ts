import { describe, expect, test } from "bun:test";
import { META_API_BASE_URL, META_PROVIDER_ID } from "../src/meta/constants.ts";
import {
	fallbackModels,
	metaFallbackCost,
	restoreProviderModels,
	toProviderModels,
} from "../src/meta/models.ts";
import type { MetaProviderModel } from "../src/meta/types.ts";
import { withMuseUserAgent } from "./muse-env.ts";

function requiredModel(
	models: MetaProviderModel[],
	index = 0,
): MetaProviderModel {
	const model = models[index];
	if (!model) throw new Error(`Expected model at index ${index}`);
	return model;
}

describe("Meta model decoding", () => {
	test("rejects non-catalog shapes without throwing", () => {
		for (const value of [
			undefined,
			null,
			false,
			[],
			42,
			"catalog",
			{},
			{ data: {} },
			{ data: null },
		]) {
			expect(toProviderModels(value)).toEqual([]);
		}
	});

	test("skips invalid entries and duplicates while preserving valid neighbors", () => {
		expect(
			toProviderModels({
				data: [
					null,
					[],
					{},
					{ id: " " },
					{ id: 12 },
					{ id: "muse-new" },
					{ id: "muse-new" },
					{ id: "hidden", metadata: { "muse-code": { is_hidden: true } } },
					{ id: "muse-next" },
				],
			}).map(({ id }) => id),
		).toEqual(["muse-new", "muse-next"]);
	});

	test("sanitizes malformed fields independently instead of corrupting provider metadata", () => {
		const [model] = toProviderModels({
			data: [
				{
					id: "muse-spark-1.3",
					metadata: {
						"muse-code": {
							name: { invalid: true },
							reasoning: "false",
							is_hidden: "true",
							modalities: { input: "image" },
							limit: { context: Infinity, output: 1.5 },
							variants: {
								high: { reasoningEffort: 42 },
								xhigh: { reasoningEffort: " " },
								max: [],
							},
							cost: { input: " ", output: -2, cached: { invalid: true } },
						},
					},
				},
			],
		});
		expect(model).toEqual(fallbackModels()[0]);
	});

	test("ignores scalar and array metadata containers", () => {
		for (const metadata of [
			null,
			"invalid",
			[],
			{ "muse-code": [] },
			{ "muse-code": "invalid" },
		]) {
			expect(
				toProviderModels({ data: [{ id: "muse-spark-1.3", metadata }] }),
			).toEqual([requiredModel(fallbackModels())]);
		}
	});

	test("preserves false reasoning, free costs and valid model-specific efforts", () => {
		const [model] = toProviderModels({
			data: [
				{
					id: "muse-future",
					metadata: {
						"muse-code": {
							name: "Future",
							reasoning: false,
							modalities: { input: ["video", "image", null] },
							cost: { input: 0, output: "0", cached: "0" },
							variants: { high: { reasoningEffort: "deep" } },
						},
					},
				},
			],
		});
		expect(model).toMatchObject({
			name: "Future",
			reasoning: false,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			thinkingLevelMap: { high: "deep", max: null },
		});
	});

	test("gates server-advertised Contributor max while preserving custom effort names", async () => {
		const catalog = {
			data: [
				{
					id: "muse-spark-1.3-contributor",
					metadata: {
						"muse-code": { variants: { max: { reasoningEffort: "max" } } },
					},
				},
			],
		};
		await withMuseUserAgent(undefined, () =>
			expect(toProviderModels(catalog)[0]?.thinkingLevelMap?.max).toBeNull(),
		);
		await withMuseUserAgent("1", () =>
			expect(toProviderModels(catalog)[0]?.thinkingLevelMap?.max).toBe("max"),
		);
		await withMuseUserAgent(undefined, () =>
			expect(
				toProviderModels({
					data: [
						{
							id: "muse-spark-1.3-contributor",
							metadata: {
								"muse-code": {
									variants: { max: { reasoningEffort: "ultra" } },
								},
							},
						},
					],
				})[0]?.thinkingLevelMap?.max,
			).toBe("ultra"),
		);
	});

	test("detaches fallback model configurations and cost lookups", () => {
		const models = fallbackModels();
		const original = fallbackModels();
		const model = requiredModel(models);
		model.name = "changed";
		model.input.length = 0;
		model.cost.input = 99;
		if (model.thinkingLevelMap) model.thinkingLevelMap.high = "changed";
		if (model.compat && "supportsToolSearch" in model.compat)
			model.compat.supportsToolSearch = false;
		const cost = metaFallbackCost(model.id);
		if (cost) cost.input = 100;
		expect(fallbackModels()).toEqual(original);
		expect(metaFallbackCost(model.id)?.input).toBe(1.25);
		expect(metaFallbackCost("unknown")).toBeUndefined();
	});

	test("catalog decoding never shares nested values with later calls or fallback models", () => {
		const catalog = {
			data: [{ id: "muse-spark-1.3" }, { id: "muse-spark-1.2" }],
		};
		const models = toProviderModels(catalog);
		const model = requiredModel(models);
		model.input.length = 0;
		model.cost.input = 99;
		if (model.thinkingLevelMap) model.thinkingLevelMap.high = "changed";
		expect(requiredModel(models, 1).input).toEqual(["text", "image"]);
		expect(toProviderModels(catalog)[0]).toEqual(fallbackModels()[0]);
	});
});

describe("Meta cached model decoding", () => {
	test("preserves detached pricing tiers and ignores incomplete or malformed tiers", () => {
		const tier = {
			inputTokensAbove: 200_000,
			input: 3,
			output: 8,
			cacheRead: 0.3,
			cacheWrite: 0,
		};
		const cached = {
			...requiredModel(fallbackModels()),
			provider: META_PROVIDER_ID,
			api: "openai-responses",
			cost: {
				input: 1,
				output: 4,
				cacheRead: 0.1,
				cacheWrite: 0,
				tiers: [tier],
			},
		};
		const model = requiredModel(
			restoreProviderModels([
				{
					...cached,
					cost: {
						...cached.cost,
						tiers: [
							null,
							{ ...tier, inputTokensAbove: -1 },
							{ inputTokensAbove: 1 },
							{ ...tier, output: -8 },
							tier,
						],
					},
				},
			]),
		);
		expect(model.cost).toMatchObject({ tiers: [tier] });
		tier.input = 99;
		expect(model.cost).toMatchObject({ tiers: [{ input: 3 }] });
	});

	test("skips invalid/provider-mismatched/API-mismatched records and keeps valid siblings", () => {
		const valid = {
			...requiredModel(fallbackModels()),
			provider: META_PROVIDER_ID,
			api: "openai-responses",
		};
		const models = restoreProviderModels([
			null,
			[],
			{},
			{ ...valid, provider: "other" },
			{ ...valid, api: "openai-completions" },
			{ ...valid, id: "" },
			valid,
			valid,
		]);
		expect(models).toHaveLength(1);
		expect(models[0]).toMatchObject({
			id: valid.id,
			api: "openai-responses",
			baseUrl: META_API_BASE_URL,
		});
		expect("provider" in requiredModel(models)).toBe(false);
		for (const value of [null, undefined, {}, "models"])
			expect(restoreProviderModels(value)).toEqual([]);
	});

	test("repairs malformed cached fields and preserves valid overrides", () => {
		const [model] = restoreProviderModels([
			{
				id: "muse-spark-1.3",
				provider: META_PROVIDER_ID,
				api: "openai-responses",
				name: 42,
				baseUrl: 42,
				reasoning: {},
				input: "image",
				contextWindow: -1,
				maxTokens: NaN,
				cost: { input: -1, output: "7", cacheRead: null, cacheWrite: 0.5 },
				thinkingLevelMap: { high: 10, low: null, xhigh: "deep" },
				headers: { "X-Valid": "yes", "X-Invalid": 42 },
				compat: {
					supportsToolSearch: false,
					supportsDeveloperRole: "no",
					sessionAffinityFormat: "openrouter",
					unsafe: {},
				},
			},
		]);
		if (!model) throw new Error("Expected a restored model");
		expect(model).toMatchObject({
			name: "Muse Spark 1.3",
			baseUrl: META_API_BASE_URL,
			reasoning: true,
			input: ["text", "image"],
			contextWindow: 1_048_576,
			maxTokens: 256_000,
			cost: { input: 1.25, output: 7, cacheRead: 0.15, cacheWrite: 0.5 },
			thinkingLevelMap: { low: null, high: "high", xhigh: "deep" },
			headers: { "X-Valid": "yes" },
			compat: {
				supportsToolSearch: false,
				sessionAffinityFormat: "openrouter",
			},
		});
		expect(model.compat).not.toHaveProperty("unsafe");
		expect(model.compat).not.toHaveProperty("supportsDeveloperRole");
	});

	test("restored nested values are detached from the cache snapshot", () => {
		const cached = {
			...requiredModel(fallbackModels()),
			provider: META_PROVIDER_ID,
			api: "openai-responses",
			headers: { "X-Test": "original" },
		};
		const snapshot = structuredClone(cached);
		const [model] = restoreProviderModels([cached]);
		if (!model) throw new Error("Expected a restored model");
		model.cost.input = 10;
		model.input.length = 0;
		if (model.thinkingLevelMap) model.thinkingLevelMap.high = "changed";
		if (model.headers) model.headers["X-Test"] = "changed";
		if (model.compat && "supportsToolSearch" in model.compat)
			model.compat.supportsToolSearch = false;
		expect(cached).toEqual(snapshot);
	});
});
