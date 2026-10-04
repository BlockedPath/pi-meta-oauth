import { expect, test } from "bun:test";
import {
	errorDetail,
	postForm,
	RequestTimeoutError,
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
