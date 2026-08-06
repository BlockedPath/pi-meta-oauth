/// <reference types="bun-types" />
import { describe, expect, test } from "bun:test";
import {
	loginMeta,
	mintMetaApiKey,
	toProviderModels,
} from "../extensions/meta.ts";

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

describe("Meta OAuth provider", () => {
	test("maps the Muse catalog into Pi model metadata", () => {
		const models = toProviderModels({
			data: [
				{
					id: "muse-spark-test",
					metadata: {
						"muse-code": {
							name: "Muse Spark Test",
							reasoning: true,
							modalities: { input: ["text", "image"] },
							limit: { context: 123_000, output: 45_000 },
							variants: { high: { reasoningEffort: "deep" } },
							cost: { input: "1.25", output: "4.25", cached: "0.15" },
						},
					},
				},
				{ id: "hidden", metadata: { "muse-code": { is_hidden: true } } },
			],
		});

		expect(models).toHaveLength(1);
		expect(models[0]).toMatchObject({
			id: "muse-spark-test",
			name: "Muse Spark Test",
			input: ["text", "image"],
			contextWindow: 123_000,
			maxTokens: 45_000,
			cost: { input: 1.25, output: 4.25, cacheRead: 0.15, cacheWrite: 0 },
			thinkingLevelMap: { off: null, high: "deep", max: null },
		});
	});

	test("runs device login, polls, and mints a Model API key", async () => {
		const requests: Array<{ url: string; authorization?: string }> = [];
		const responses = [
			jsonResponse({
				device_code: "device-token",
				user_code: "ABCD-1234",
				verification_uri: "https://auth.meta.com/device",
				verification_uri_complete:
					"https://auth.meta.com/device?code=ABCD-1234",
				expires_in: 900,
				interval: 1,
			}),
			jsonResponse({ error: "authorization_pending" }, 400),
			jsonResponse({ access_token: "identity-token" }),
			jsonResponse({
				api_key: "model-api-key",
				base_url: "https://api.meta.ai/v1",
			}),
		];
		const fetchMock = (async (
			input: string | URL | Request,
			init?: RequestInit,
		) => {
			const headers = new Headers(init?.headers);
			requests.push({
				url: String(input),
				authorization: headers.get("Authorization") ?? undefined,
			});
			const response = responses.shift();
			if (!response) throw new Error("Unexpected request");
			return response;
		}) as unknown as typeof fetch;
		const deviceCodes: unknown[] = [];
		const credentials = await loginMeta(
			{
				onAuth() {},
				onDeviceCode(value: unknown) {
					deviceCodes.push(value);
				},
				onPrompt: async () => "",
				onSelect: async () => undefined,
			},
			fetchMock,
			async () => {},
		);

		expect(deviceCodes).toEqual([
			{
				userCode: "ABCD-1234",
				verificationUri: "https://auth.meta.com/device?code=ABCD-1234",
				intervalSeconds: 1,
				expiresInSeconds: 900,
			},
		]);
		expect(credentials.refresh).toBe("identity-token");
		expect(credentials.access).toBe("model-api-key");
		expect(requests.at(-1)?.authorization).toBe("Bearer identity-token");
	});

	test("reports account setup when minting yields no API key", async () => {
		const fetchMock = (async () =>
			jsonResponse({
				require_payment: true,
				action_url: "https://dev.meta.ai/billing",
			})) as unknown as typeof fetch;
		await expect(mintMetaApiKey("identity-token", fetchMock)).rejects.toThrow(
			"Complete setup at https://dev.meta.ai/billing",
		);
	});
});
