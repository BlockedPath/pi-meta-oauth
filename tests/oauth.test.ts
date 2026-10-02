import { describe, expect, spyOn, test } from "bun:test";
import type { OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import {
	API_KEY_MINT_URL,
	API_KEY_REFRESH_INTERVAL_MS,
	DEVICE_AUTHORIZATION_URL,
	DEVICE_CODE_GRANT,
	DEVICE_TOKEN_URL,
	META_CLIENT_ID,
} from "../src/meta/constants.ts";
import {
	loginMeta,
	mintMetaApiKey,
	refreshMetaToken,
} from "../src/meta/oauth.ts";
import type { Fetch } from "../src/meta/types.ts";

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function deviceAuthorization(overrides: Record<string, unknown> = {}) {
	return {
		device_code: "device-token",
		user_code: "ABCD-1234",
		verification_uri: "https://auth.meta.com/device",
		interval: 1,
		expires_in: 900,
		...overrides,
	};
}

function scriptedFetch(...responses: Response[]) {
	const requests: Array<{ url: string; init?: RequestInit }> = [];
	const fetchImpl: Fetch = async (input, init) => {
		requests.push({ url: String(input), init });
		const response = responses.shift();
		if (!response) throw new Error("Unexpected OAuth request");
		return response;
	};
	return { fetchImpl, requests };
}

function loginCallbacks() {
	const deviceCodes: Parameters<OAuthLoginCallbacks["onDeviceCode"]>[0][] = [];
	const progress: string[] = [];
	const callbacks: OAuthLoginCallbacks = {
		onAuth() {},
		onDeviceCode(value) {
			deviceCodes.push(value);
		},
		onPrompt: async () => "",
		onSelect: async () => undefined,
		onProgress(value) {
			progress.push(value);
		},
	};
	return { callbacks, deviceCodes, progress };
}

function fakeClock() {
	let time = 1_000_000;
	const waits: number[] = [];
	return {
		now: () => time,
		waits,
		sleep: async (milliseconds: number) => {
			waits.push(milliseconds);
			time += milliseconds;
		},
	};
}

describe("Meta device OAuth", () => {
	test("preserves the authorization, grant, and mint wire contracts", async () => {
		const { fetchImpl, requests } = scriptedFetch(
			jsonResponse(
				deviceAuthorization({
					verification_uri_complete:
						"https://auth.meta.com/device?code=ABCD-1234",
				}),
			),
			jsonResponse({ error: "authorization_pending" }, 400),
			jsonResponse({ access_token: "identity-token" }),
			jsonResponse({ api_key: "model-api-key" }),
		);
		const { callbacks, deviceCodes, progress } = loginCallbacks();
		const clock = fakeClock();
		const credentials = await loginMeta(
			callbacks,
			fetchImpl,
			clock.sleep,
			clock.now,
		);

		expect(credentials).toEqual({
			refresh: "identity-token",
			access: "model-api-key",
			expires: clock.now() + API_KEY_REFRESH_INTERVAL_MS,
		});
		expect(deviceCodes).toEqual([
			{
				userCode: "ABCD-1234",
				verificationUri: "https://auth.meta.com/device?code=ABCD-1234",
				intervalSeconds: 1,
				expiresInSeconds: 900,
			},
		]);
		expect(progress).toEqual([
			"Starting Meta device authorization…",
			"Waiting for Meta login approval…",
			"Enabling Meta Model API access…",
		]);
		expect(clock.waits).toEqual([1000, 1000]);
		expect(requests.map(({ url }) => url)).toEqual([
			DEVICE_AUTHORIZATION_URL,
			DEVICE_TOKEN_URL,
			DEVICE_TOKEN_URL,
			API_KEY_MINT_URL,
		]);
		expect(requests[0]?.init?.method).toBe("POST");
		expect(requests[0]?.init?.redirect).toBe("manual");
		expect(String(requests[0]?.init?.body)).toBe(
			new URLSearchParams({ client_id: META_CLIENT_ID }).toString(),
		);
		expect(new Headers(requests[1]?.init?.headers).get("Content-Type")).toBe(
			"application/x-www-form-urlencoded",
		);
		expect(String(requests[1]?.init?.body)).toBe(
			new URLSearchParams({
				grant_type: DEVICE_CODE_GRANT,
				device_code: "device-token",
				client_id: META_CLIENT_ID,
			}).toString(),
		);
		expect(new Headers(requests[3]?.init?.headers).get("Authorization")).toBe(
			"Bearer identity-token",
		);
		expect(new Headers(requests[3]?.init?.headers).get("x-api-version")).toBe(
			"1.0.0",
		);
		expect(requests[3]?.init?.body).toBe("{}");
	});

	for (const field of ["device_code", "user_code", "verification_uri"]) {
		for (const value of [123, {}, " "]) {
			test(`rejects malformed ${field}: ${JSON.stringify(value)}`, async () => {
				const { fetchImpl, requests } = scriptedFetch(
					jsonResponse(deviceAuthorization({ [field]: value })),
				);
				const { callbacks, deviceCodes } = loginCallbacks();
				await expect(loginMeta(callbacks, fetchImpl)).rejects.toThrow(
					"Meta device authorization returned an incomplete response",
				);
				expect(deviceCodes).toHaveLength(0);
				expect(requests).toHaveLength(1);
			});
		}
	}

	for (const body of ["null", "[]", "not-json"]) {
		test(`rejects non-object authorization body ${body}`, async () => {
			const { fetchImpl } = scriptedFetch(new Response(body));
			await expect(
				loginMeta(loginCallbacks().callbacks, fetchImpl),
			).rejects.toThrow("incomplete response");
		});
	}

	test("reports an authorization failure with the server detail", async () => {
		const { fetchImpl } = scriptedFetch(
			jsonResponse({ error_description: " Invalid client " }, 401),
		);
		await expect(
			loginMeta(loginCallbacks().callbacks, fetchImpl),
		).rejects.toThrow(
			"Meta login could not be started (HTTP 401): Invalid client",
		);
	});

	test("uses defaults for malformed timing fields and complete verification URI", async () => {
		const { fetchImpl } = scriptedFetch(
			jsonResponse(
				deviceAuthorization({
					interval: "1",
					expires_in: -1,
					verification_uri_complete: { url: "https://example.com" },
				}),
			),
			jsonResponse({ access_token: "identity-token" }),
			jsonResponse({ api_key: "model-api-key" }),
		);
		const { callbacks, deviceCodes } = loginCallbacks();
		const clock = fakeClock();
		await loginMeta(callbacks, fetchImpl, clock.sleep, clock.now);
		expect(deviceCodes[0]).toEqual({
			userCode: "ABCD-1234",
			verificationUri: "https://auth.meta.com/device",
			intervalSeconds: 5,
			expiresInSeconds: 900,
		});
		expect(clock.waits).toEqual([5000]);
	});

	test("increases the poll interval by five seconds after each slow_down", async () => {
		const { fetchImpl } = scriptedFetch(
			jsonResponse(deviceAuthorization()),
			jsonResponse({ error: "slow_down" }, 400),
			jsonResponse({ error: "authorization_pending" }, 400),
			jsonResponse({ error: "slow_down" }, 400),
			jsonResponse({ access_token: "identity-token" }),
			jsonResponse({ api_key: "model-api-key" }),
		);
		const clock = fakeClock();
		await loginMeta(
			loginCallbacks().callbacks,
			fetchImpl,
			clock.sleep,
			clock.now,
		);
		expect(clock.waits).toEqual([1000, 6000, 6000, 11000]);
	});

	for (const [error, message] of [
		["access_denied", "Meta login was denied"],
		["expired_token", "Meta login request expired"],
	]) {
		test(`stops polling after ${error}`, async () => {
			const { fetchImpl, requests } = scriptedFetch(
				jsonResponse(deviceAuthorization()),
				jsonResponse({ error }, 400),
			);
			const clock = fakeClock();
			await expect(
				loginMeta(
					loginCallbacks().callbacks,
					fetchImpl,
					clock.sleep,
					clock.now,
				),
			).rejects.toThrow(message);
			expect(requests).toHaveLength(2);
		});
	}

	for (const accessToken of [42, {}, [], " ", null]) {
		test(`rejects malformed identity token ${JSON.stringify(accessToken)}`, async () => {
			const { fetchImpl, requests } = scriptedFetch(
				jsonResponse(deviceAuthorization()),
				jsonResponse({ access_token: accessToken }),
			);
			const clock = fakeClock();
			await expect(
				loginMeta(
					loginCallbacks().callbacks,
					fetchImpl,
					clock.sleep,
					clock.now,
				),
			).rejects.toThrow("Meta login failed (HTTP 200)");
			expect(requests).toHaveLength(2);
		});
	}

	test("reports an unrecognized grant error and does not mint a key", async () => {
		const { fetchImpl, requests } = scriptedFetch(
			jsonResponse(deviceAuthorization()),
			jsonResponse(
				{ error: "invalid_client", message: "Client disabled" },
				403,
			),
		);
		const clock = fakeClock();
		await expect(
			loginMeta(loginCallbacks().callbacks, fetchImpl, clock.sleep, clock.now),
		).rejects.toThrow("Meta login failed (HTTP 403): Client disabled");
		expect(requests).toHaveLength(2);
	});

	for (const interval of [1, 5]) {
		test(`does not poll at expiry when the interval is ${interval}s`, async () => {
			const { fetchImpl, requests } = scriptedFetch(
				jsonResponse(deviceAuthorization({ interval, expires_in: 1 })),
			);
			const clock = fakeClock();
			await expect(
				loginMeta(
					loginCallbacks().callbacks,
					fetchImpl,
					clock.sleep,
					clock.now,
				),
			).rejects.toThrow("Meta login request expired");
			expect(requests).toHaveLength(1);
			expect(clock.waits).toEqual([1000]);
		});
	}

	test("stops when slow_down moves the next poll beyond expiry", async () => {
		const { fetchImpl, requests } = scriptedFetch(
			jsonResponse(deviceAuthorization({ expires_in: 4 })),
			jsonResponse({ error: "slow_down" }, 400),
		);
		const clock = fakeClock();
		await expect(
			loginMeta(loginCallbacks().callbacks, fetchImpl, clock.sleep, clock.now),
		).rejects.toThrow("Meta login request expired");
		expect(requests).toHaveLength(2);
		expect(clock.waits).toEqual([1000, 3000]);
	});

	test("cancels before authorization without issuing a request", async () => {
		const { fetchImpl, requests } = scriptedFetch();
		const { callbacks, deviceCodes, progress } = loginCallbacks();
		const cancellableCallbacks: OAuthLoginCallbacks & { signal?: AbortSignal } =
			{
				...callbacks,
				signal: AbortSignal.abort(),
			};
		await expect(loginMeta(cancellableCallbacks, fetchImpl)).rejects.toThrow(
			"Meta login was cancelled",
		);
		expect(requests).toHaveLength(0);
		expect(deviceCodes).toHaveLength(0);
		expect(progress).toHaveLength(0);
	});

	for (const [phase, requestCount] of [
		["authorization", 1],
		["poll", 2],
		["mint", 3],
	] as const) {
		test(`cancels during ${phase} even if the transport returns success`, async () => {
			const controller = new AbortController();
			const signals: Array<AbortSignal | null | undefined> = [];
			const responses = [
				jsonResponse(deviceAuthorization()),
				jsonResponse({ access_token: "identity-token" }),
				jsonResponse({ api_key: "model-api-key" }),
			];
			const fetchImpl: Fetch = async (_input, init) => {
				signals.push(init?.signal);
				if (signals.length === requestCount) controller.abort();
				const response = responses.shift();
				if (!response) throw new Error("Unexpected OAuth request");
				return response;
			};
			const { callbacks, deviceCodes } = loginCallbacks();
			const cancellableCallbacks: OAuthLoginCallbacks & {
				signal?: AbortSignal;
			} = {
				...callbacks,
				signal: controller.signal,
			};
			const clock = fakeClock();
			await expect(
				loginMeta(cancellableCallbacks, fetchImpl, clock.sleep, clock.now),
			).rejects.toThrow("Meta login was cancelled");
			expect(signals).toHaveLength(requestCount);
			expect(signals.every((signal) => signal === controller.signal)).toBe(
				true,
			);
			expect(deviceCodes).toHaveLength(phase === "authorization" ? 0 : 1);
		});
	}

	test("cancels during an injected sleep and handles its later rejection", async () => {
		const controller = new AbortController();
		const { fetchImpl, requests } = scriptedFetch(
			jsonResponse(deviceAuthorization()),
		);
		const { callbacks } = loginCallbacks();
		const cancellableCallbacks: OAuthLoginCallbacks & { signal?: AbortSignal } =
			{
				...callbacks,
				signal: controller.signal,
			};
		const removeListener = spyOn(controller.signal, "removeEventListener");
		try {
			await expect(
				loginMeta(cancellableCallbacks, fetchImpl, async () => {
					controller.abort();
					throw new Error("Sleep finished after cancellation");
				}),
			).rejects.toThrow("Meta login was cancelled");
			expect(requests).toHaveLength(1);
			expect(removeListener).toHaveBeenCalled();
		} finally {
			removeListener.mockRestore();
		}
	});

	test("cancels and clears the default polling timer", async () => {
		const controller = new AbortController();
		const { fetchImpl, requests } = scriptedFetch(
			jsonResponse(deviceAuthorization()),
		);
		const { callbacks } = loginCallbacks();
		const cancellableCallbacks: OAuthLoginCallbacks & { signal?: AbortSignal } =
			{
				...callbacks,
				signal: controller.signal,
				onDeviceCode() {
					queueMicrotask(() => controller.abort());
				},
			};
		const timerSpy = spyOn(globalThis, "setTimeout");
		const clearSpy = spyOn(globalThis, "clearTimeout");
		try {
			await expect(loginMeta(cancellableCallbacks, fetchImpl)).rejects.toThrow(
				"Meta login was cancelled",
			);
			expect(requests).toHaveLength(1);
			expect(timerSpy).toHaveBeenCalledTimes(1);
			expect(clearSpy).toHaveBeenCalledWith(timerSpy.mock.results[0]?.value);
		} finally {
			timerSpy.mockRestore();
			clearSpy.mockRestore();
		}
	});
});

describe("Meta key minting and refresh", () => {
	for (const apiKey of [42, {}, [], " ", null]) {
		test(`rejects malformed API key ${JSON.stringify(apiKey)}`, async () => {
			const { fetchImpl } = scriptedFetch(jsonResponse({ api_key: apiKey }));
			await expect(mintMetaApiKey("identity-token", fetchImpl)).rejects.toThrow(
				"Meta did not issue an API key.",
			);
		});
	}

	test("preserves identity token and issued key bytes", async () => {
		const { fetchImpl, requests } = scriptedFetch(
			jsonResponse({ api_key: " key with surrounding spaces " }),
		);
		const key = await mintMetaApiKey("identity token", fetchImpl);
		expect(key).toBe(" key with surrounding spaces ");
		expect(new Headers(requests[0]?.init?.headers).get("Authorization")).toBe(
			"Bearer identity token",
		);
	});

	test("reports setup only for a valid action URL string", async () => {
		const { fetchImpl } = scriptedFetch(
			jsonResponse({ action_url: { url: "https://dev.meta.ai/billing" } }),
		);
		await expect(mintMetaApiKey("identity-token", fetchImpl)).rejects.toThrow(
			"Meta did not issue an API key.",
		);
	});

	test("reports HTTP mint failures even when the body is malformed", async () => {
		const { fetchImpl } = scriptedFetch(
			new Response("not-json", { status: 500 }),
		);
		await expect(mintMetaApiKey("identity-token", fetchImpl)).rejects.toThrow(
			"Meta API-key mint failed (HTTP 500)",
		);
	});

	test("refresh rejects a blank identity token before making a request", async () => {
		const { fetchImpl, requests } = scriptedFetch();
		await expect(
			refreshMetaToken(
				{ refresh: " ", access: "old-key", expires: 0 },
				fetchImpl,
			),
		).rejects.toThrow("Meta login is missing its identity token");
		expect(requests).toHaveLength(0);
	});

	test("refresh preserves credentials and issues a daily expiry after minting", async () => {
		const credentials = {
			refresh: "identity-token",
			access: "old-key",
			expires: 0,
		};
		const { fetchImpl } = scriptedFetch(jsonResponse({ api_key: "new-key" }));
		const before = Date.now();
		const refreshed = await refreshMetaToken(credentials, fetchImpl);
		expect(refreshed).toMatchObject({
			refresh: "identity-token",
			access: "new-key",
		});
		expect(refreshed.expires).toBeGreaterThanOrEqual(
			before + API_KEY_REFRESH_INTERVAL_MS,
		);
		expect(refreshed.expires).toBeLessThanOrEqual(
			Date.now() + API_KEY_REFRESH_INTERVAL_MS,
		);
		expect(credentials).toEqual({
			refresh: "identity-token",
			access: "old-key",
			expires: 0,
		});
	});

	test("refresh passes Pi's cancellation signal to mint and rejects a late cancellation", async () => {
		const controller = new AbortController();
		let receivedSignal: AbortSignal | null | undefined;
		const fetchImpl: Fetch = async (_input, init) => {
			receivedSignal = init?.signal;
			controller.abort();
			return jsonResponse({ api_key: "new-key" });
		};
		const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
			fetchImpl as typeof globalThis.fetch,
		);
		try {
			await expect(
				refreshMetaToken(
					{ refresh: "identity-token", access: "old-key", expires: 0 },
					controller.signal,
				),
			).rejects.toThrow("Meta token refresh was cancelled");
			expect(receivedSignal).toBe(controller.signal);
		} finally {
			fetchSpy.mockRestore();
		}
	});
});
