import type { Usage } from "@earendil-works/pi-ai";
import {
	applyMetaResponsesCacheHints,
	META_API_BASE_URL,
	metaFallbackCost,
} from "../meta.ts";

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object"
		? (value as Record<string, unknown>)
		: undefined;
}

function tokenCount(...values: unknown[]): number | undefined {
	for (const value of values) {
		const numeric =
			typeof value === "number"
				? value
				: typeof value === "string" && value.trim()
					? Number(value)
					: Number.NaN;
		if (Number.isFinite(numeric)) return Math.max(0, Math.trunc(numeric));
	}
	return undefined;
}

function responsesErrorDetail(
	json: unknown,
	text: string,
	statusText: string,
): string {
	const body = record(json);
	if (body?.error !== undefined) {
		return JSON.stringify(body.error).slice(0, 1000);
	}
	if (typeof body?.message === "string") {
		return body.message.slice(0, 1000);
	}
	return text.slice(0, 1000) || statusText;
}

/** Convert a Meta Responses API usage block into Pi's nested-tool usage shape. */
export function extractMetaResponseUsage(
	response: unknown,
	modelId = "muse-spark-1.2",
): Usage | undefined {
	const usage = record(record(response)?.usage);
	if (!usage) return undefined;

	const inputDetails = record(
		usage.input_tokens_details ?? usage.inputTokensDetails,
	);
	const outputDetails = record(
		usage.output_tokens_details ?? usage.outputTokensDetails,
	);
	const inputTotal = tokenCount(
		usage.input_tokens,
		usage.inputTokens,
		usage.prompt_tokens,
		usage.promptTokens,
		usage.input,
	);
	const output = tokenCount(
		usage.output_tokens,
		usage.outputTokens,
		usage.completion_tokens,
		usage.completionTokens,
		usage.output,
	);
	if (inputTotal === undefined && output === undefined) return undefined;

	const reportedInput = inputTotal ?? 0;
	const cacheRead = Math.min(
		reportedInput,
		tokenCount(inputDetails?.cached_tokens, inputDetails?.cachedTokens) ?? 0,
	);
	const cacheWrite = Math.min(
		reportedInput - cacheRead,
		tokenCount(
			inputDetails?.cache_write_tokens,
			inputDetails?.cacheWriteTokens,
		) ?? 0,
	);
	const uncachedInput = Math.max(0, reportedInput - cacheRead - cacheWrite);
	const outputTokens = output ?? 0;
	const reasoning = Math.min(
		outputTokens,
		tokenCount(outputDetails?.reasoning_tokens, outputDetails?.reasoningTokens) ??
			0,
	);
	const totalTokens =
		tokenCount(usage.total_tokens, usage.totalTokens) ??
		uncachedInput + cacheRead + cacheWrite + outputTokens;
	const rates = metaFallbackCost(modelId);
	const cost = {
		input: (uncachedInput * (rates?.input ?? 0)) / 1_000_000,
		output: (outputTokens * (rates?.output ?? 0)) / 1_000_000,
		cacheRead: (cacheRead * (rates?.cacheRead ?? 0)) / 1_000_000,
		cacheWrite: (cacheWrite * (rates?.cacheWrite ?? 0)) / 1_000_000,
		total: 0,
	};
	cost.total = cost.input + cost.output + cost.cacheRead + cost.cacheWrite;

	return {
		input: uncachedInput,
		output: outputTokens,
		cacheRead,
		cacheWrite,
		reasoning,
		totalTokens,
		cost,
	};
}

export function formatMetaResponseUsage(usage: Usage): string {
	const parts = [`${usage.input.toLocaleString()} input`];
	if (usage.cacheRead)
		parts.push(`${usage.cacheRead.toLocaleString()} cache read`);
	if (usage.cacheWrite)
		parts.push(`${usage.cacheWrite.toLocaleString()} cache write`);
	parts.push(`${usage.output.toLocaleString()} output`);
	if (usage.reasoning)
		parts.push(`${usage.reasoning.toLocaleString()} reasoning`);
	return `Video token usage: ${usage.totalTokens.toLocaleString()} total (${parts.join(", ")})`;
}

export function extractResponsesText(json: unknown): string {
	if (!json || typeof json !== "object") return "";
	const j = json as Record<string, unknown>;
	if (typeof j.output_text === "string" && j.output_text.trim())
		return j.output_text;
	const output = j.output as unknown;
	if (Array.isArray(output)) {
		const texts: string[] = [];
		for (const item of output as Record<string, unknown>[]) {
			if (!item || typeof item !== "object" || item.type !== "message") continue;
			if (typeof item.content === "string" && item.content.trim())
				texts.push(item.content);
			if (Array.isArray(item.content)) {
				for (const c of item.content as Record<string, unknown>[]) {
					if (
						(c.type === "output_text" || c.type === "text") &&
						typeof c.text === "string" &&
						c.text.trim()
					)
						texts.push(c.text);
					if (
						c.type === "refusal" &&
						typeof c.refusal === "string" &&
						c.refusal.trim()
					)
						texts.push(c.refusal);
				}
			}
		}
		if (texts.length) return texts.join("\n\n");
	}
	if (typeof j.text === "string" && j.text.trim()) return j.text;
	return "";
}

export async function callMetaResponses(
	apiKey: string,
	payload: Record<string, unknown>,
	signal?: AbortSignal,
): Promise<{ text: string; raw: unknown }> {
	payload.store = false;
	applyMetaResponsesCacheHints(payload);
	const res = await fetch(`${META_API_BASE_URL}/responses`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${apiKey}`,
			"Content-Type": "application/json",
			"x-api-version": "1.0.0",
		},
		body: JSON.stringify(payload),
		signal,
	});
	const text = await res.text();
	let json: unknown;
	try {
		json = text ? (JSON.parse(text) as unknown) : {};
	} catch {
		json = text;
	}
	if (!res.ok) {
		throw new Error(
			`Meta Responses failed (HTTP ${res.status}): ${responsesErrorDetail(json, text, res.statusText)}`,
		);
	}
	return { text: extractResponsesText(json), raw: json };
}
