/// <reference types="bun-types" />
import { describe, expect, spyOn, test } from "bun:test";
import type {
	ModelsStoreEntry,
	OAuthLoginCallbacks,
	RefreshModelsContext,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import metaOAuthProvider, {
	createMetaProviderConfig,
	loginMeta,
	META_API_BASE_URL,
	META_MODEL_CATALOG_URL,
	META_PROVIDER_ID,
	mintMetaApiKey,
	refreshMetaModels,
	refreshMetaToken,
} from "../extensions/meta.ts";
import { META_REQUEST_TIMEOUT_MS } from "../src/meta/constants.ts";
import { withMuseUserAgent } from "./muse-env.ts";

// Characterization tests for the failure, fallback, and wire-shape paths of
// extensions/meta.ts: exact messages and request shapes that users and Meta
// depend on but the happy-path suites do not pin.

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function scriptedFetch(...responses: Array<Response | Error>) {
	const requests: Array<{ url: string; init?: RequestInit }> = [];
	const fetchMock = (async (
		input: string | URL | Request,
		init?: RequestInit,
	) => {
		requests.push({ url: String(input), init });
		const next = responses.shift();
		if (!next) throw new Error("Unexpected request");
		if (next instanceof Error) throw next;
		return next;
	}) as unknown as typeof fetch;
	return { fetchMock, requests };
}

/** Answer with the scripted responses, then stall until the request aborts. */
function stallingFetch(...responses: Response[]) {
	const requests: Array<{ url: string; init?: RequestInit }> = [];
	const fetchMock = (async (
		input: string | URL | Request,
		init?: RequestInit,
	) => {
		requests.push({ url: String(input), init });
		const next = responses.shift();
		if (next) return next;
		return new Promise<Response>((_resolve, reject) => {
			const signal = init?.signal;
			signal?.addEventListener("abort", () => reject(signal.reason));
		});
	}) as unknown as typeof fetch;
	return { fetchMock, requests };
}

async function rejectionMessage(promise: Promise<unknown>): Promise<string> {
	try {
		await promise;
	} catch (error) {
		return (error as Error).message;
	}
	throw new Error("expected the promise to reject");
}

function deviceAuthorization(extra: Record<string, unknown> = {}): Response {
	return jsonResponse({
		device_code: "device-token",
		user_code: "ABCD-1234",
		verification_uri: "https://auth.meta.com/device",
		interval: 1,
		expires_in: 900,
		...extra,
	});
}

function loginCallbacks(
	events: { deviceCodes?: unknown[]; progress?: string[] } = {},
): OAuthLoginCallbacks {
	return {
		onAuth() {},
		onDeviceCode(value: unknown) {
			events.deviceCodes?.push(value);
		},
		onProgress(message: string) {
			events.progress?.push(message);
		},
		onPrompt: async () => "",
		onSelect: async () => undefined,
	} as OAuthLoginCallbacks;
}

const noSleep = async () => {};

describe("Meta device login failures", () => {
	test("backs off by five seconds on slow_down and keeps the new interval", async () => {
		const sleeps: number[] = [];
		const { fetchMock } = scriptedFetch(
			deviceAuthorization(),
			jsonResponse({ error: "slow_down" }, 400),
			jsonResponse({ error: "authorization_pending" }, 400),
			jsonResponse({ access_token: "identity-token" }),
			jsonResponse({ api_key: "model-api-key" }),
		);
		const credentials = await loginMeta(
			loginCallbacks(),
			fetchMock,
			async (milliseconds) => {
				sleeps.push(milliseconds);
			},
		);

		expect(sleeps).toEqual([1000, 6000, 6000]);
		expect(credentials.access).toBe("model-api-key");
	});

	for (const [label, serverInterval, expectedWait] of [
		["a longer server-supplied interval", 10, 10_000],
		["the five-second back-off over a shorter server interval", 2, 6000],
		["the five-second back-off over a malformed server interval", "10", 6000],
	] as const) {
		test(`uses ${label} after slow_down`, async () => {
			const sleeps: number[] = [];
			const { fetchMock } = scriptedFetch(
				deviceAuthorization(),
				jsonResponse({ error: "slow_down", interval: serverInterval }, 400),
				jsonResponse({ access_token: "identity-token" }),
				jsonResponse({ api_key: "model-api-key" }),
			);
			await loginMeta(loginCallbacks(), fetchMock, async (milliseconds) => {
				sleeps.push(milliseconds);
			});

			expect(sleeps).toEqual([1000, expectedWait]);
		});
	}

	test("polls at most once per second for a sub-second interval", async () => {
		const sleeps: number[] = [];
		const { fetchMock } = scriptedFetch(
			deviceAuthorization({ interval: 0.05 }),
			jsonResponse({ error: "authorization_pending" }, 400),
			jsonResponse({ access_token: "identity-token" }),
			jsonResponse({ api_key: "model-api-key" }),
		);
		await loginMeta(loginCallbacks(), fetchMock, async (milliseconds) => {
			sleeps.push(milliseconds);
		});

		expect(sleeps).toEqual([1000, 1000]);
	});

	const terminalGrants: Array<[string, Response, string]> = [
		[
			"access_denied",
			jsonResponse({ error: "access_denied" }, 400),
			"Meta login was denied",
		],
		[
			"expired_token",
			jsonResponse({ error: "expired_token" }, 400),
			"Meta login request expired",
		],
		[
			"an unknown error with a description",
			jsonResponse({ error: "server_error", error_description: "boom" }, 500),
			"Meta login failed (HTTP 500): boom",
		],
		[
			"an empty error body",
			jsonResponse({}, 502),
			"Meta login failed (HTTP 502)",
		],
		[
			"a non-JSON error body",
			new Response("<html>bad gateway</html>", { status: 502 }),
			"Meta login failed (HTTP 502)",
		],
		[
			"an OK response without an access token",
			jsonResponse({}),
			"Meta login failed (HTTP 200)",
		],
	];
	for (const [label, grant, message] of terminalGrants) {
		test(`stops polling on ${label}`, async () => {
			const { fetchMock, requests } = scriptedFetch(
				deviceAuthorization(),
				grant,
			);
			expect(
				await rejectionMessage(loginMeta(loginCallbacks(), fetchMock, noSleep)),
			).toBe(message);
			expect(requests).toHaveLength(2);
		});
	}

	test("reports a failed device authorization and does not poll", async () => {
		const { fetchMock, requests } = scriptedFetch(
			jsonResponse({ error: "temporarily_unavailable" }, 503),
		);
		expect(
			await rejectionMessage(loginMeta(loginCallbacks(), fetchMock, noSleep)),
		).toBe(
			"Meta login could not be started (HTTP 503): temporarily_unavailable",
		);
		expect(requests).toHaveLength(1);
	});

	test("rejects an incomplete device authorization", async () => {
		const { fetchMock } = scriptedFetch(
			jsonResponse({ device_code: "device-token", user_code: "ABCD-1234" }),
		);
		expect(
			await rejectionMessage(loginMeta(loginCallbacks(), fetchMock, noSleep)),
		).toBe("Meta device authorization returned an incomplete response");
	});

	async function forwardedVerificationUri(
		extra: Record<string, unknown>,
	): Promise<unknown> {
		const deviceCodes: Array<{ verificationUri?: unknown }> = [];
		const { fetchMock } = scriptedFetch(
			deviceAuthorization(extra),
			jsonResponse({ access_token: "identity-token" }),
			jsonResponse({ api_key: "model-api-key" }),
		);
		await loginMeta(loginCallbacks({ deviceCodes }), fetchMock, noSleep);
		return deviceCodes[0]?.verificationUri;
	}

	for (const complete of [
		"javascript:alert(1)",
		"file:///etc/passwd",
		"not a URL",
	]) {
		test(`falls back to verification_uri when the complete URI is ${complete}`, async () => {
			expect(
				await forwardedVerificationUri({
					verification_uri_complete: complete,
				}),
			).toBe("https://auth.meta.com/device");
		});
	}

	for (const uri of ["javascript:alert(1)", "file:///etc/passwd"]) {
		test(`rejects a ${uri} verification URI without a trusted fallback`, async () => {
			const { fetchMock, requests } = scriptedFetch(
				deviceAuthorization({ verification_uri: uri }),
			);
			expect(
				await rejectionMessage(loginMeta(loginCallbacks(), fetchMock, noSleep)),
			).toBe("Meta device authorization returned an incomplete response");
			expect(requests).toHaveLength(1);
		});
	}

	test("percent-encodes control characters before Pi renders the link", async () => {
		expect(
			await forwardedVerificationUri({
				verification_uri_complete:
					"https://auth.meta.com/device\x07\x1b]52;c;AAAA\x07\x1b[2J",
			}),
		).toBe("https://auth.meta.com/device%07%1B]52;c;AAAA%07%1B[2J");
	});

	test("accepts a trusted complete URI without verification_uri", async () => {
		expect(
			await forwardedVerificationUri({
				verification_uri: undefined,
				verification_uri_complete:
					"https://auth.meta.com/device?code=ABCD-1234",
			}),
		).toBe("https://auth.meta.com/device?code=ABCD-1234");
	});

	test("expires when approval never arrives before the deadline", async () => {
		const pending = () => jsonResponse({ error: "authorization_pending" }, 400);
		const { fetchMock } = scriptedFetch(
			deviceAuthorization({ expires_in: 0.05 }),
			...Array.from({ length: 50 }, pending),
		);
		expect(
			await rejectionMessage(
				loginMeta(
					loginCallbacks(),
					fetchMock,
					() => new Promise((resolve) => setTimeout(resolve, 20)),
				),
			),
		).toBe("Meta login request expired");
	});

	for (const [label, extra] of [
		["missing", {}],
		["zero and negative", { interval: 0, expires_in: -1 }],
		["non-numeric", { interval: "7", expires_in: "60" }],
	] as const) {
		test(`falls back to a 5s interval and 15m expiry when they are ${label}`, async () => {
			const deviceCodes: unknown[] = [];
			const { fetchMock } = scriptedFetch(
				deviceAuthorization({
					interval: undefined,
					expires_in: undefined,
					...extra,
				}),
				jsonResponse({ access_token: "identity-token" }),
				jsonResponse({ api_key: "model-api-key" }),
			);
			const sleeps: number[] = [];
			await loginMeta(
				loginCallbacks({ deviceCodes }),
				fetchMock,
				async (milliseconds) => {
					sleeps.push(milliseconds);
				},
			);

			expect(deviceCodes).toEqual([
				{
					userCode: "ABCD-1234",
					verificationUri: "https://auth.meta.com/device",
					intervalSeconds: 5,
					expiresInSeconds: 900,
				},
			]);
			expect(sleeps).toEqual([5000]);
		});
	}

	test("sends the documented request shapes and progress messages", async () => {
		const progress: string[] = [];
		const { fetchMock, requests } = scriptedFetch(
			deviceAuthorization(),
			jsonResponse({ access_token: "identity-token" }),
			jsonResponse({ api_key: "model-api-key" }),
		);
		const before = Date.now();
		const credentials = await loginMeta(
			loginCallbacks({ progress }),
			fetchMock,
			noSleep,
		);

		expect(progress).toEqual([
			"Starting Meta device authorization…",
			"Waiting for Meta login approval…",
			"Enabling Meta Model API access…",
		]);
		expect(requests.map((request) => request.url)).toEqual([
			"https://auth.meta.com/oidc/device/authorization/",
			"https://auth.meta.com/oidc/device/token/",
			"https://api.meta.ai/muse-code/key",
		]);

		const [authorization, token, mint] = requests;
		for (const request of [authorization, token]) {
			expect(request?.init?.method).toBe("POST");
			expect(request?.init?.redirect).toBe("manual");
			expect(new Headers(request?.init?.headers).get("Content-Type")).toBe(
				"application/x-www-form-urlencoded",
			);
			expect(new Headers(request?.init?.headers).get("Accept")).toBe(
				"application/json",
			);
		}
		expect(String(authorization?.init?.body)).toBe(
			"client_id=1031625952748946",
		);
		expect(
			Object.fromEntries(new URLSearchParams(String(token?.init?.body))),
		).toEqual({
			grant_type: "urn:ietf:params:oauth:grant-type:device_code",
			device_code: "device-token",
			client_id: "1031625952748946",
		});
		expect(mint?.init?.method).toBe("POST");
		expect(mint?.init?.body).toBe("{}");
		const mintHeaders = new Headers(mint?.init?.headers);
		expect(mintHeaders.get("Authorization")).toBe("Bearer identity-token");
		expect(mintHeaders.get("Content-Type")).toBe("application/json");
		expect(mintHeaders.get("x-api-version")).toBe("1.0.0");

		expect(credentials.refresh).toBe("identity-token");
		expect(credentials.access).toBe("model-api-key");
		expect(credentials.expires).toBeGreaterThanOrEqual(before + 86_400_000);
		expect(credentials.expires).toBeLessThanOrEqual(Date.now() + 86_400_000);
	});
});

describe("Meta API-key minting failures", () => {
	const failures: Array<[string, Response, string]> = [
		[
			"a message",
			jsonResponse({ message: "upstream down" }, 500),
			"Meta API-key mint failed (HTTP 500): upstream down",
		],
		[
			"an empty body",
			jsonResponse({}, 500),
			"Meta API-key mint failed (HTTP 500)",
		],
		[
			"a non-JSON body",
			new Response("<html>bad gateway</html>", { status: 502 }),
			"Meta API-key mint failed (HTTP 502)",
		],
		[
			"a JSON array body",
			jsonResponse(["nope"], 500),
			"Meta API-key mint failed (HTTP 500)",
		],
		[
			"every detail key, preferring error_description and trimming it",
			jsonResponse(
				{
					error: "e",
					message: "m",
					detail: "d",
					error_description: "  desc  ",
				},
				500,
			),
			"Meta API-key mint failed (HTTP 500): desc",
		],
		[
			"a blank error_description, falling through to detail",
			jsonResponse(
				{ error_description: "   ", detail: "d", message: "m" },
				500,
			),
			"Meta API-key mint failed (HTTP 500): d",
		],
		[
			"only an error code",
			jsonResponse({ error: "rate_limited" }, 429),
			"Meta API-key mint failed (HTTP 429): rate_limited",
		],
		[
			"an expired session without detail",
			jsonResponse({}, 401),
			"Meta session expired (HTTP 401); run /login meta again",
		],
	];
	for (const [label, response, message] of failures) {
		test(`reports ${label}`, async () => {
			const { fetchMock } = scriptedFetch(response);
			expect(
				await rejectionMessage(mintMetaApiKey("identity-token", fetchMock)),
			).toBe(message);
		});
	}

	for (const [label, body] of [
		["no api_key", {}],
		["an empty api_key", { api_key: "" }],
		["a non-string api_key", { api_key: 42 }],
	] as const) {
		test(`reports a bare no-key error for ${label}`, async () => {
			const { fetchMock } = scriptedFetch(jsonResponse(body));
			expect(
				await rejectionMessage(mintMetaApiKey("identity-token", fetchMock)),
			).toBe("Meta did not issue an API key.");
		});
	}

	test("appends the setup link when Meta supplies one", async () => {
		const { fetchMock } = scriptedFetch(
			jsonResponse({
				require_payment: true,
				action_url: "https://dev.meta.ai/billing",
			}),
		);
		expect(
			await rejectionMessage(mintMetaApiKey("identity-token", fetchMock)),
		).toBe(
			"Meta did not issue an API key. Complete setup at https://dev.meta.ai/billing.",
		);
	});

	for (const actionUrl of ["javascript:x", "file:///etc/passwd", "billing"]) {
		test(`omits an untrusted setup link (${actionUrl})`, async () => {
			const { fetchMock } = scriptedFetch(
				jsonResponse({ action_url: actionUrl }),
			);
			expect(
				await rejectionMessage(mintMetaApiKey("identity-token", fetchMock)),
			).toBe("Meta did not issue an API key.");
		});
	}

	test("percent-encodes control characters in the setup link", async () => {
		const { fetchMock } = scriptedFetch(
			jsonResponse({ action_url: "https://dev.meta.ai/billing\x1b[2J" }),
		);
		expect(
			await rejectionMessage(mintMetaApiKey("identity-token", fetchMock)),
		).toBe(
			"Meta did not issue an API key. Complete setup at https://dev.meta.ai/billing%1B[2J.",
		);
	});

	test("requires an identity token to refresh", async () => {
		expect(
			await rejectionMessage(
				refreshMetaToken({ refresh: "", access: "old-key", expires: 0 }),
			),
		).toBe("Meta login is missing its identity token; run /login meta again");
	});

	test("ties the mint request to the caller's AbortSignal", async () => {
		const controller = new AbortController();
		const { fetchMock, requests } = scriptedFetch(
			jsonResponse({ api_key: "key" }),
		);
		await mintMetaApiKey("identity-token", fetchMock, controller.signal);
		const signal = requests[0]?.init?.signal;
		expect(signal?.aborted).toBe(false);
		controller.abort();
		expect(signal?.aborted).toBe(true);
		expect(signal?.reason).toBe(controller.signal.reason);
	});

	test("keeps other credential fields and extends expiry on refresh", async () => {
		const before = Date.now();
		const { fetchMock } = scriptedFetch(
			jsonResponse({ api_key: "rotated-key" }),
		);
		const refreshed = await refreshMetaToken(
			{
				refresh: "identity-token",
				access: "old-key",
				expires: 0,
				accountId: "acct-1",
			},
			fetchMock,
		);

		expect(refreshed).toMatchObject({
			refresh: "identity-token",
			access: "rotated-key",
			accountId: "acct-1",
		});
		expect(refreshed.expires).toBeGreaterThanOrEqual(before + 86_400_000);
	});
});

describe("Meta request timeouts", () => {
	const credentials = { refresh: "identity-token", access: "old", expires: 0 };

	/** Shrink every request timeout to 20ms and record the requested length. */
	async function withShortTimeouts(
		run: (requested: number[]) => Promise<void>,
	): Promise<void> {
		const timeout = AbortSignal.timeout.bind(AbortSignal);
		const requested: number[] = [];
		const spy = spyOn(AbortSignal, "timeout").mockImplementation(
			(milliseconds: number) => {
				requested.push(milliseconds);
				return timeout(20);
			},
		);
		try {
			await run(requested);
		} finally {
			spy.mockRestore();
		}
	}

	async function withStalledGlobalFetch(run: () => Promise<void>) {
		const { fetchMock } = stallingFetch();
		const spy = spyOn(globalThis, "fetch").mockImplementation(fetchMock);
		try {
			await run();
		} finally {
			spy.mockRestore();
		}
	}

	test("expires a stalled token poll at the device-code deadline", async () => {
		const { fetchMock, requests } = stallingFetch(
			deviceAuthorization({ interval: 0.05, expires_in: 0.2 }),
		);
		const started = Date.now();
		expect(
			await rejectionMessage(loginMeta(loginCallbacks(), fetchMock, noSleep)),
		).toBe("Meta login request expired");
		expect(Date.now() - started).toBeLessThan(1000);
		expect(requests).toHaveLength(2);
	});

	test("times out a stalled device authorization after 30 seconds", async () => {
		await withShortTimeouts(async (requested) => {
			const { fetchMock } = stallingFetch();
			expect(
				await rejectionMessage(loginMeta(loginCallbacks(), fetchMock, noSleep)),
			).toBe("Meta login request timed out");
			expect(requested).toEqual([META_REQUEST_TIMEOUT_MS]);
		});
	});

	test("times out a stalled token poll well before the deadline", async () => {
		await withShortTimeouts(async (requested) => {
			const { fetchMock, requests } = stallingFetch(deviceAuthorization());
			expect(
				await rejectionMessage(loginMeta(loginCallbacks(), fetchMock, noSleep)),
			).toBe("Meta login request timed out");
			expect(requested).toEqual([
				META_REQUEST_TIMEOUT_MS,
				META_REQUEST_TIMEOUT_MS,
			]);
			expect(requests).toHaveLength(2);
		});
	});

	for (const signal of [undefined, new AbortController().signal]) {
		test(`times out a stalled mint ${signal ? "with" : "without"} a caller signal`, async () => {
			const { fetchMock } = stallingFetch();
			expect(
				await rejectionMessage(
					mintMetaApiKey("identity-token", fetchMock, signal, 20),
				),
			).toBe("Meta API-key mint timed out");
		});
	}

	test("bounds a Pi 0.83 refresh, which passes no signal", async () => {
		await withShortTimeouts(async (requested) => {
			await withStalledGlobalFetch(async () => {
				expect(await rejectionMessage(refreshMetaToken(credentials))).toBe(
					"Meta API-key mint timed out",
				);
			});
			expect(requested).toEqual([META_REQUEST_TIMEOUT_MS]);
		});
	});

	test("reports Pi's refresh timeout as a timeout, not a cancellation", async () => {
		await withStalledGlobalFetch(async () => {
			expect(
				await rejectionMessage(
					refreshMetaToken(credentials, AbortSignal.timeout(20)),
				),
			).toBe("Meta token refresh timed out");
		});
	});

	test("still reports a caller abort during a stalled request as cancelled", async () => {
		await withStalledGlobalFetch(async () => {
			const controller = new AbortController();
			const refresh = refreshMetaToken(credentials, controller.signal);
			setTimeout(() => controller.abort(), 10);
			expect(await rejectionMessage(refresh)).toBe(
				"Meta token refresh was cancelled",
			);
		});
		const controller = new AbortController();
		const { fetchMock } = stallingFetch(deviceAuthorization());
		const login = loginMeta(
			{ ...loginCallbacks(), signal: controller.signal } as OAuthLoginCallbacks,
			fetchMock,
			noSleep,
		);
		setTimeout(() => controller.abort(), 10);
		expect(await rejectionMessage(login)).toBe("Login cancelled");
	});
});

describe("Meta catalog refresh fallbacks", () => {
	function context(
		overrides: Record<string, unknown> = {},
	): RefreshModelsContext {
		return {
			credential: { type: "api_key", key: "model-api-key" },
			allowNetwork: true,
			signal: new AbortController().signal,
			...overrides,
		} as unknown as RefreshModelsContext;
	}

	const fallbackModels = () => createMetaProviderConfig().models ?? [];
	const unexpectedFetch = (async () => {
		throw new Error("network should not be used");
	}) as unknown as typeof fetch;

	test("returns the bundled models when offline with nothing cached", async () => {
		const models = await refreshMetaModels(
			context({ allowNetwork: false }),
			unexpectedFetch,
		);
		expect(models).toEqual(fallbackModels());
	});

	test("returns the bundled models without calling the network when already aborted", async () => {
		const models = await refreshMetaModels(
			context({ signal: AbortSignal.abort() }),
			unexpectedFetch,
		);
		expect(models).toEqual(fallbackModels());
	});

	for (const credential of [
		undefined,
		{ type: "oauth" },
		{ type: "api_key" },
	]) {
		test(`skips the network without a usable key (${JSON.stringify(credential) ?? "no credential"})`, async () => {
			const models = await refreshMetaModels(
				context({ credential }),
				unexpectedFetch,
			);
			expect(models).toEqual(fallbackModels());
		});
	}

	test("authenticates with the OAuth access key or the API key", async () => {
		for (const [credential, key] of [
			[
				{ type: "oauth", access: "minted-key", refresh: "r", expires: 0 },
				"minted-key",
			],
			[{ type: "api_key", key: "plain-key" }, "plain-key"],
		] as const) {
			const signal = new AbortController().signal;
			const { fetchMock, requests } = scriptedFetch(
				jsonResponse({ data: [{ id: "muse-spark-1.2" }] }),
			);
			await refreshMetaModels(context({ credential, signal }), fetchMock);

			expect(requests[0]?.url).toBe(META_MODEL_CATALOG_URL);
			expect(requests[0]?.init?.signal).toBe(signal);
			const headers = new Headers(requests[0]?.init?.headers);
			expect(headers.get("Authorization")).toBe(`Bearer ${key}`);
			expect(headers.get("Accept")).toBe("application/json");
			expect(headers.get("x-api-version")).toBe("1.0.0");
		}
	});

	const unusableCatalogs: Array<[string, Response]> = [
		["an HTTP error", jsonResponse({ message: "down" }, 500)],
		["a non-JSON error", new Response("<html>oops</html>", { status: 502 })],
		["an OK response with no data", jsonResponse({})],
		[
			"only hidden models",
			jsonResponse({
				data: [{ id: "x", metadata: { "muse-code": { is_hidden: true } } }],
			}),
		],
	];
	for (const [label, response] of unusableCatalogs) {
		test(`falls back and does not persist after ${label}`, async () => {
			let writes = 0;
			const { fetchMock } = scriptedFetch(response);
			const models = await refreshMetaModels(
				context({
					store: {
						read: async () => undefined,
						write: async () => {
							writes += 1;
						},
					},
				}),
				fetchMock,
			);

			expect(models).toEqual(fallbackModels());
			expect(writes).toBe(0);
		});
	}

	test("rethrows when the signal aborts the request", async () => {
		const controller = new AbortController();
		const fetchMock = (async () => {
			controller.abort();
			throw new Error("request aborted");
		}) as unknown as typeof fetch;
		expect(
			await rejectionMessage(
				refreshMetaModels(context({ signal: controller.signal }), fetchMock),
			),
		).toBe("request aborted");
	});

	test("returns fresh models but skips persistence when aborted after the response", async () => {
		const controller = new AbortController();
		let writes = 0;
		const fetchMock = (async () => {
			controller.abort();
			return jsonResponse({ data: [{ id: "muse-spark-1.2" }] });
		}) as unknown as typeof fetch;
		const models = await refreshMetaModels(
			context({
				signal: controller.signal,
				store: {
					read: async () => undefined,
					write: async () => {
						writes += 1;
					},
				},
			}),
			fetchMock,
		);

		expect(models.map((model) => model.id)).toEqual(["muse-spark-1.2"]);
		expect(writes).toBe(0);
	});

	test("keeps the fresh catalog when persistence fails (Pi 0.83 store and Pi 0.84 publish)", async () => {
		for (const persistence of [
			{
				store: {
					read: async () => undefined,
					write: async () => {
						throw new Error("disk full");
					},
				},
			},
			{
				publish: async () => {
					throw new Error("stale generation");
				},
			},
		]) {
			const { fetchMock } = scriptedFetch(
				jsonResponse({ data: [{ id: "muse-spark-1.2" }] }),
			);
			const models = await refreshMetaModels(context(persistence), fetchMock);
			expect(models.map((model) => model.id)).toEqual(["muse-spark-1.2"]);
		}
	});

	test("falls back to the bundled models when reading the cache throws", async () => {
		const models = await refreshMetaModels(
			context({
				allowNetwork: false,
				store: {
					read: async () => {
						throw new Error("corrupt store");
					},
				},
			}),
			unexpectedFetch,
		);
		expect(models).toEqual(fallbackModels());
	});

	test("ignores stored models from other providers or APIs", async () => {
		const [template] = fallbackModels();
		if (!template) throw new Error("Meta fallback model is required");
		const entry = (provider: string, api: string) =>
			({ ...template, provider, api, baseUrl: META_API_BASE_URL }) as never;
		const stored: ModelsStoreEntry = {
			models: [
				entry("other", "openai-responses"),
				entry(META_PROVIDER_ID, "openai-completions"),
			],
			checkedAt: Date.now(),
		};
		const models = await refreshMetaModels(
			context({ allowNetwork: false, stored }),
			unexpectedFetch,
		);
		expect(models).toEqual(fallbackModels());
	});
});

describe("Meta bundled models", () => {
	const standardCost = {
		input: 1.25,
		output: 4.25,
		cacheRead: 0.15,
		cacheWrite: 0,
	};
	const contributorCost = {
		input: 0.1,
		output: 0.2,
		cacheRead: 0.002,
		cacheWrite: 0,
	};
	const expected = [
		["muse-spark-1.3", "Muse Spark 1.3", standardCost, "max"],
		[
			"muse-spark-1.3-contributor",
			"Muse Spark 1.3 Contributor",
			contributorCost,
			null,
		],
		["muse-spark-1.2", "Muse Spark 1.2", standardCost, null],
		[
			"muse-spark-1.2-contributor",
			"Muse Spark 1.2 Contributor",
			contributorCost,
			null,
		],
		["muse-spark-1.1", "Muse Spark 1.1", standardCost, null],
	] as const;

	function expectedModels(contributorMax: string | null) {
		return expected.map(([id, name, cost, max]) => ({
			id,
			name,
			reasoning: true,
			thinkingLevelMap: {
				off: null,
				minimal: "minimal",
				low: "low",
				medium: "medium",
				high: "high",
				xhigh: "xhigh",
				max: id === "muse-spark-1.3-contributor" ? contributorMax : max,
			},
			input: ["text", "image"] as Array<"text" | "image">,
			cost,
			contextWindow: 1_048_576,
			maxTokens: 256_000,
			compat: { supportsReasoningEffort: true, supportsToolSearch: true },
		}));
	}

	test("ships the five Muse models in order with their prices and effort maps", async () => {
		await withMuseUserAgent(undefined, () => {
			expect(createMetaProviderConfig().models).toEqual(expectedModels(null));
		});
	});

	test("exposes Contributor 1.3 max in the bundled models only when opted in", async () => {
		await withMuseUserAgent("1", () => {
			expect(createMetaProviderConfig().models).toEqual(expectedModels("max"));
		});
	});
});

describe("Meta extension entry point", () => {
	const KEYS = ["META_API_KEY", "MODEL_API_KEY"] as const;

	async function withKeys(
		values: Partial<Record<(typeof KEYS)[number], string>>,
		fn: () => void,
	): Promise<Record<(typeof KEYS)[number], string | undefined>> {
		const previous = { ...process.env };
		for (const key of KEYS) {
			if (values[key] === undefined) delete process.env[key];
			else process.env[key] = values[key];
		}
		try {
			fn();
			return {
				META_API_KEY: process.env.META_API_KEY,
				MODEL_API_KEY: process.env.MODEL_API_KEY,
			};
		} finally {
			for (const key of KEYS) {
				if (previous[key] === undefined) delete process.env[key];
				else process.env[key] = previous[key];
			}
		}
	}

	const register = () =>
		metaOAuthProvider({
			registerProvider() {},
			on() {},
		} as unknown as ExtensionAPI);

	test("mirrors MODEL_API_KEY into META_API_KEY and back", async () => {
		expect(await withKeys({ MODEL_API_KEY: "model" }, register)).toEqual({
			META_API_KEY: "model",
			MODEL_API_KEY: "model",
		});
		expect(await withKeys({ META_API_KEY: "meta" }, register)).toEqual({
			META_API_KEY: "meta",
			MODEL_API_KEY: "meta",
		});
	});

	test("never overwrites a key that is already set", async () => {
		expect(
			await withKeys(
				{ META_API_KEY: "meta", MODEL_API_KEY: "model" },
				register,
			),
		).toEqual({ META_API_KEY: "meta", MODEL_API_KEY: "model" });
		// Pi resolves $META_API_KEY with `||`, so an empty value is not set.
		expect(
			await withKeys({ META_API_KEY: "", MODEL_API_KEY: "model" }, register),
		).toEqual({
			META_API_KEY: "model",
			MODEL_API_KEY: "model",
		});
	});

	test("leaves both unset when neither is provided", async () => {
		expect(await withKeys({}, register)).toEqual({
			META_API_KEY: undefined,
			MODEL_API_KEY: undefined,
		});
	});
});
