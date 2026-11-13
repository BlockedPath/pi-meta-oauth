import { META_REQUEST_TIMEOUT_MS } from "./constants.ts";
import type { Fetch } from "./types.ts";

/** A request outlived its own timeout while the caller's signal stayed live. */
export class RequestTimeoutError extends Error {
	override name = "RequestTimeoutError";
}

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

/**
 * Run one request under the caller's signal and its own timeout, so a stalled
 * connection cannot hang a login or refresh. Only a timeout the caller did not
 * cause becomes a RequestTimeoutError; caller cancellation passes through.
 */
export async function withRequestTimeout<T>(
	signal: AbortSignal | undefined,
	timeoutMs: number,
	request: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
	const timeout = AbortSignal.timeout(timeoutMs);
	try {
		return await request(signal ? AbortSignal.any([signal, timeout]) : timeout);
	} catch (error) {
		if (timeout.aborted && !signal?.aborted) {
			throw new RequestTimeoutError(`Request timed out after ${timeoutMs} ms`, {
				cause: error,
			});
		}
		throw error;
	}
}

/** Append the server's own explanation, when it sent one, to a failure message. */
export function requestFailure(
	message: string,
	body: Record<string, unknown>,
): Error {
	const detail = errorDetail(body);
	return new Error(`${message}${detail ? `: ${detail}` : ""}`);
}

type RequestOptions = Omit<
	NonNullable<Parameters<Fetch>[1]>,
	"redirect" | "signal"
>;

/**
 * Send one credential-bearing request and decode its JSON object body, with the
 * body read inside the same timeout. Redirects are never followed: a 3xx is
 * reported as the failure it is instead of resending a token or key elsewhere.
 */
export async function requestJson(
	url: string,
	options: RequestOptions,
	fetchImpl: Fetch,
	signal?: AbortSignal,
	timeoutMs = META_REQUEST_TIMEOUT_MS,
): Promise<{ response: Response; body: Record<string, unknown> }> {
	return withRequestTimeout(signal, timeoutMs, async (requestSignal) => {
		const response = await fetchImpl(url, {
			...options,
			redirect: "manual",
			signal: requestSignal,
		});
		return { response, body: await responseBody(response) };
	});
}

export function postForm(
	url: string,
	fields: Record<string, string>,
	fetchImpl: Fetch,
	signal?: AbortSignal,
	timeoutMs = META_REQUEST_TIMEOUT_MS,
): Promise<{ response: Response; body: Record<string, unknown> }> {
	return requestJson(
		url,
		{
			method: "POST",
			headers: {
				Accept: "application/json",
				"Content-Type": "application/x-www-form-urlencoded",
			},
			body: new URLSearchParams(fields),
		},
		fetchImpl,
		signal,
		timeoutMs,
	);
}

export function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
