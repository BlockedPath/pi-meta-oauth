import { META_API_BASE_URL, META_PROVIDER_ID } from "./constants.ts";
import { asRecord } from "./http.ts";
import { gateMuseMaxEffort } from "./muse-policy.ts";
import type {
	MetaEnv,
	MetaProviderModel,
	MetaResponsesCompat,
} from "./types.ts";

const DEFAULT_CONTEXT_WINDOW = 1_048_576;
const DEFAULT_MAX_TOKENS = 256_000;
const STANDARD_COST = {
	input: 1.25,
	output: 4.25,
	cacheRead: 0.15,
	cacheWrite: 0,
};
const CONTRIBUTOR_COST = {
	input: 0.1,
	output: 0.2,
	cacheRead: 0.002,
	cacheWrite: 0,
};
const UNKNOWN_MODEL_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const THINKING_LEVELS = [
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const;
type ThinkingLevelMap = NonNullable<MetaProviderModel["thinkingLevelMap"]>;

/** Data-only definitions; callers always receive fresh model objects. */
const FALLBACK_DEFINITIONS = [
	{
		id: "muse-spark-1.3",
		name: "Muse Spark 1.3",
		cost: STANDARD_COST,
		max: true,
	},
	{
		id: "muse-spark-1.3-contributor",
		name: "Muse Spark 1.3 Contributor",
		cost: CONTRIBUTOR_COST,
		max: false,
	},
	{
		id: "muse-spark-1.2",
		name: "Muse Spark 1.2",
		cost: STANDARD_COST,
		max: false,
	},
	{
		id: "muse-spark-1.2-contributor",
		name: "Muse Spark 1.2 Contributor",
		cost: CONTRIBUTOR_COST,
		max: false,
	},
	{
		id: "muse-spark-1.1",
		name: "Muse Spark 1.1",
		cost: STANDARD_COST,
		max: false,
	},
] as const;

function nonemptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function positiveInteger(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0
		? value
		: fallback;
}

function numericCost(value: unknown, fallback: number): number {
	const number =
		typeof value === "number"
			? value
			: typeof value === "string" && value.trim()
				? Number(value)
				: Number.NaN;
	return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function defaultThinkingLevels(max: boolean): ThinkingLevelMap {
	return {
		off: null,
		minimal: "minimal",
		low: "low",
		medium: "medium",
		high: "high",
		xhigh: "xhigh",
		max: max ? "max" : null,
	};
}

function displayName(id: string): string {
	return id
		.split("-")
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(" ");
}

function defaultModel(id: string): MetaProviderModel {
	const definition = FALLBACK_DEFINITIONS.find((model) => model.id === id);
	const cost = definition?.cost ?? UNKNOWN_MODEL_COST;
	return {
		id,
		name: definition?.name ?? displayName(id),
		reasoning: true,
		thinkingLevelMap: defaultThinkingLevels(definition?.max ?? false),
		input: definition ? ["text", "image"] : ["text"],
		cost: { ...cost },
		contextWindow: DEFAULT_CONTEXT_WINDOW,
		maxTokens: DEFAULT_MAX_TOKENS,
		compat: { supportsReasoningEffort: true, supportsToolSearch: true },
	};
}

export function fallbackModels(
	env: MetaEnv = process.env,
): MetaProviderModel[] {
	return FALLBACK_DEFINITIONS.map(({ id }) =>
		gateMuseMaxEffort(defaultModel(id), env),
	);
}

export function metaFallbackCost(
	modelId: string,
): MetaProviderModel["cost"] | undefined {
	const definition = FALLBACK_DEFINITIONS.find((model) => model.id === modelId);
	return definition ? { ...definition.cost } : undefined;
}

function modelInput(
	value: unknown,
	fallback: MetaProviderModel["input"],
): MetaProviderModel["input"] {
	if (!Array.isArray(value)) return [...fallback];
	return value.includes("image") ? ["text", "image"] : ["text"];
}

function catalogThinkingLevels(
	variants: unknown,
	fallback: ThinkingLevelMap,
): ThinkingLevelMap {
	const entries = asRecord(variants);
	const map: ThinkingLevelMap = { ...fallback };
	for (const level of THINKING_LEVELS) {
		const effort = nonemptyString(asRecord(entries?.[level])?.reasoningEffort);
		if (effort !== undefined) map[level] = effort;
	}
	return map;
}

/** Validate each remote field independently so one malformed entry cannot discard the catalog. */
export function toProviderModels(catalog: unknown): MetaProviderModel[] {
	const data = asRecord(catalog)?.data;
	if (!Array.isArray(data)) return [];
	const models: MetaProviderModel[] = [];
	const seen = new Set<string>();
	for (const value of data) {
		const entry = asRecord(value);
		const id = nonemptyString(entry?.id);
		if (!id || seen.has(id)) continue;
		const metadata = asRecord(asRecord(entry?.metadata)?.["muse-code"]);
		if (metadata?.is_hidden === true) continue;
		const fallback = defaultModel(id);
		const name = nonemptyString(metadata?.name);
		const cost = asRecord(metadata?.cost);
		const limit = asRecord(metadata?.limit);
		models.push(
			gateMuseMaxEffort({
				...fallback,
				name: name && name !== id ? name : fallback.name,
				reasoning:
					typeof metadata?.reasoning === "boolean"
						? metadata.reasoning
						: fallback.reasoning,
				thinkingLevelMap: catalogThinkingLevels(
					metadata?.variants,
					fallback.thinkingLevelMap ?? {},
				),
				input: modelInput(
					asRecord(metadata?.modalities)?.input,
					fallback.input,
				),
				cost: {
					input: numericCost(cost?.input, fallback.cost.input),
					output: numericCost(cost?.output, fallback.cost.output),
					cacheRead: numericCost(cost?.cached, fallback.cost.cacheRead),
					cacheWrite: 0,
				},
				contextWindow: positiveInteger(limit?.context, fallback.contextWindow),
				maxTokens: positiveInteger(limit?.output, fallback.maxTokens),
			}),
		);
		seen.add(id);
	}
	return models;
}

function storedThinkingLevels(
	value: unknown,
	fallback: ThinkingLevelMap,
): ThinkingLevelMap {
	const entries = asRecord(value);
	const map: ThinkingLevelMap = { ...fallback };
	for (const level of ["off", ...THINKING_LEVELS] as const) {
		if (entries?.[level] === null) map[level] = null;
		else {
			const effort = nonemptyString(entries?.[level]);
			if (effort !== undefined) map[level] = effort;
		}
	}
	return map;
}

const COMPAT_BOOLEAN_KEYS = [
	"supportsReasoningEffort",
	"supportsToolSearch",
	"supportsDeveloperRole",
	"supportsMidConvoSystemMessages",
	"supportsLongCacheRetention",
	"supportsStrictMode",
	"supportsOpenAIGrammarTools",
	"supportsAdditionalTools",
	"supportsExplicitPromptCacheMode",
	"supportsMaxOutputTokens",
] as const satisfies readonly (keyof MetaResponsesCompat)[];

function storedCompat(value: unknown): MetaResponsesCompat {
	const entries = asRecord(value);
	const compat: MetaResponsesCompat = {
		supportsReasoningEffort: true,
		supportsToolSearch: true,
	};
	for (const key of COMPAT_BOOLEAN_KEYS) {
		if (typeof entries?.[key] === "boolean") compat[key] = entries[key];
	}
	const sessionAffinity = entries?.sessionAffinityFormat;
	if (
		sessionAffinity === "openai" ||
		sessionAffinity === "openai-nosession" ||
		sessionAffinity === "openrouter"
	) {
		compat.sessionAffinityFormat = sessionAffinity;
	}
	return compat;
}

function storedHeaders(value: unknown): Record<string, string> | undefined {
	const entries = asRecord(value);
	if (!entries) return undefined;
	const headers = Object.fromEntries(
		Object.entries(entries).filter(
			(entry): entry is [string, string] => typeof entry[1] === "string",
		),
	);
	return Object.keys(headers).length ? headers : undefined;
}

type CachedCostTier = Pick<
	MetaProviderModel["cost"],
	"input" | "output" | "cacheRead" | "cacheWrite"
> & {
	inputTokensAbove: number;
};
type CachedCost = MetaProviderModel["cost"] & { tiers?: CachedCostTier[] };

function storedCost(
	value: unknown,
	fallback: MetaProviderModel["cost"],
): CachedCost {
	const entries = asRecord(value);
	const cost: CachedCost = {
		input: numericCost(entries?.input, fallback.input),
		output: numericCost(entries?.output, fallback.output),
		cacheRead: numericCost(entries?.cacheRead, fallback.cacheRead),
		cacheWrite: numericCost(entries?.cacheWrite, fallback.cacheWrite),
	};
	if (Array.isArray(entries?.tiers)) {
		const tiers: CachedCostTier[] = [];
		for (const valueTier of entries.tiers) {
			const tier = asRecord(valueTier);
			const inputTokensAbove = tier?.inputTokensAbove;
			if (
				typeof inputTokensAbove !== "number" ||
				!Number.isSafeInteger(inputTokensAbove) ||
				inputTokensAbove < 0
			)
				continue;
			const rates = {
				input: numericCost(tier?.input, Number.NaN),
				output: numericCost(tier?.output, Number.NaN),
				cacheRead: numericCost(tier?.cacheRead, Number.NaN),
				cacheWrite: numericCost(tier?.cacheWrite, Number.NaN),
			};
			if (Object.values(rates).every(Number.isFinite))
				tiers.push({ ...rates, inputTokensAbove });
		}
		if (tiers.length > 0) cost.tiers = tiers;
	}
	return cost;
}

/** Cache contents cross the same untrusted-data boundary as the remote catalog. */
export function restoreProviderModels(value: unknown): MetaProviderModel[] {
	if (!Array.isArray(value)) return [];
	const models: MetaProviderModel[] = [];
	const seen = new Set<string>();
	for (const valueEntry of value) {
		const entry = asRecord(valueEntry);
		if (
			entry?.provider !== META_PROVIDER_ID ||
			entry.api !== "openai-responses"
		)
			continue;
		const id = nonemptyString(entry.id);
		if (!id || seen.has(id)) continue;
		const fallback = defaultModel(id);
		models.push(
			gateMuseMaxEffort({
				...fallback,
				name: nonemptyString(entry.name) ?? fallback.name,
				api: "openai-responses",
				// The extension only persists the direct endpoint; a cached URL must never redirect the key.
				baseUrl: META_API_BASE_URL,
				reasoning:
					typeof entry.reasoning === "boolean"
						? entry.reasoning
						: fallback.reasoning,
				thinkingLevelMap: storedThinkingLevels(
					entry.thinkingLevelMap,
					fallback.thinkingLevelMap ?? {},
				),
				input: modelInput(entry.input, fallback.input),
				cost: storedCost(entry.cost, fallback.cost),
				contextWindow: positiveInteger(
					entry.contextWindow,
					fallback.contextWindow,
				),
				maxTokens: positiveInteger(entry.maxTokens, fallback.maxTokens),
				headers: storedHeaders(entry.headers),
				compat: storedCompat(entry.compat),
			}),
		);
		seen.add(id);
	}
	return models;
}
