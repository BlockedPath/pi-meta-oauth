import { expect, test } from "bun:test";
import { errorDetail, postForm, responseBody } from "../src/meta/http.ts";
import type { Fetch } from "../src/meta/types.ts";

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
