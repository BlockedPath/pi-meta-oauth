import type { Fetch } from "./types.ts";

/** Keep untrusted JSON as unknown until its fields have been validated. */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

export async function responseBody(
	response: Response,
): Promise<Record<string, unknown>> {
	const text = await response.text();
	if (!text) return {};
	try {
		return asRecord(JSON.parse(text)) ?? {};
	} catch {
		return {};
	}
}

export function errorDetail(body: Record<string, unknown>): string | undefined {
	for (const key of ["error_description", "detail", "message", "error"]) {
		const value = body[key];
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return undefined;
}

export async function postForm(
	url: string,
	fields: Record<string, string>,
	fetchImpl: Fetch,
	signal?: AbortSignal,
): Promise<{ response: Response; body: Record<string, unknown> }> {
	const response = await fetchImpl(url, {
		method: "POST",
		headers: {
			Accept: "application/json",
			"Content-Type": "application/x-www-form-urlencoded",
		},
		body: new URLSearchParams(fields),
		redirect: "manual",
		signal,
	});
	return { response, body: await responseBody(response) };
}

export function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
