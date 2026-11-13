import { expect, test } from "bun:test";
import {
	errorDetail,
	postForm,
	RequestTimeoutError,
	requestFailure,
	requestJson,
	responseBody,
} from "../src/meta/http.ts";
import type { Fetch } from "../src/meta/types.ts";

/** A transport that never answers and rejects only when its signal aborts. */
const stalledFetch: Fetch = (_url, init) =>
	new Promise((_resolve, reject) => {
		const signal = init?.signal;
		signal?.addEventListener("abort", () => reject(signal.reason));
	});

test.each(["", "not JSON", "null", "[]", "42", '"string"'])(
	"handles non-object JSON response %j",
	async (body) => {
		expect(await responseBody(new Response(body))).toEqual({});
	},
);

test("preserves JSON object fields for caller validation", async () => {
	expect(await responseBody(new Response('{"api_key":42}'))).toEqual({
		api_key: 42,
	});
});

test("selects a meaningful error detail in server priority order", () => {
	expect(
		errorDetail({
			error_description: " ",
			detail: 42,
			message: " message ",
			error: "code",
		}),
	).toBe("message");
	expect(
		errorDetail({ error_description: " description ", detail: "detail" }),
	).toBe("description");
	expect(errorDetail({ error: { message: "nested" } })).toBeUndefined();
});

test("device form transport URL-encodes fields and disables redirects", async () => {
	const fetchImpl = (async (url, init) => {
		expect(url).toBe("https://auth.meta.com/test");
		expect(init?.method).toBe("POST");
		expect(init?.redirect).toBe("manual");
		expect(new Headers(init?.headers).get("content-type")).toBe(
			"application/x-www-form-urlencoded",
		);
		expect(String(init?.body)).toBe("device_code=a%2Bb%26c");
		return new Response('{"access_token":"identity"}');
	}) as Fetch;
	const { body } = await postForm(
		"https://auth.meta.com/test",
		{ device_code: "a+b&c" },
		fetchImpl,
	);
	expect(body).toEqual({ access_token: "identity" });
});

test("device form transport times out a stalled request", async () => {
	for (const signal of [undefined, new AbortController().signal]) {
		const error = await postForm(
			"https://auth.meta.com/test",
			{},
			stalledFetch,
			signal,
			20,
		).catch((reason: unknown) => reason);
		expect(error).toBeInstanceOf(RequestTimeoutError);
		expect((error as Error).cause).toMatchObject({ name: "TimeoutError" });
	}
});

test("device form transport leaves caller cancellation to the caller", async () => {
	const controller = new AbortController();
	const pending = postForm(
		"https://auth.meta.com/test",
		{},
		stalledFetch,
		controller.signal,
		1_000,
	);
	controller.abort();
	const error = await pending.catch((reason: unknown) => reason);
	expect(error).not.toBeInstanceOf(RequestTimeoutError);
	expect(error).toBe(controller.signal.reason);
});

test("JSON transport never follows redirects and keeps the caller's request options", async () => {
	let seen: RequestInit | undefined;
	const fetchImpl = (async (_url, init) => {
		seen = init;
		return new Response(null, {
			status: 302,
			headers: { Location: "https://example.com/elsewhere" },
		});
	}) as Fetch;
	const { response, body } = await requestJson(
		"https://api.meta.ai/test",
		{ method: "POST", headers: { Authorization: "Bearer secret" }, body: "{}" },
		fetchImpl,
	);
	expect(seen?.redirect).toBe("manual");
	expect(seen?.method).toBe("POST");
	expect(seen?.body).toBe("{}");
	expect(new Headers(seen?.headers).get("Authorization")).toBe("Bearer secret");
	expect(seen?.signal).toBeInstanceOf(AbortSignal);
	expect(response.status).toBe(302);
	expect(body).toEqual({});
});

test("JSON transport bounds the body read with the same timeout", async () => {
	const fetchImpl = (async (_url, init) => {
		const signal = init?.signal;
		const stalledBody = new ReadableStream<Uint8Array>({
			start(controller) {
				signal?.addEventListener("abort", () =>
					controller.error(signal.reason),
				);
			},
		});
		return new Response(stalledBody);
	}) as Fetch;
	const error = await requestJson(
		"https://api.meta.ai/test",
		{},
		fetchImpl,
		undefined,
		20,
	).catch((reason: unknown) => reason);
	expect(error).toBeInstanceOf(RequestTimeoutError);
});

test("appends the server's detail to a failure message only when present", () => {
	expect(requestFailure("Request failed", { message: " why " }).message).toBe(
		"Request failed: why",
	);
	expect(requestFailure("Request failed", {}).message).toBe("Request failed");
});
