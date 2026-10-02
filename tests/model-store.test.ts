import { describe, expect, test } from "bun:test";
import type {
	ModelsStoreEntry,
	RefreshModelsContext,
} from "@earendil-works/pi-ai";
import {
	META_API_BASE_URL,
	META_MODEL_CATALOG_URL,
	META_PROVIDER_ID,
} from "../src/meta/constants.ts";
import { refreshMetaModels } from "../src/meta/model-store.ts";
import { fallbackModels } from "../src/meta/models.ts";
import type { Fetch } from "../src/meta/types.ts";
import { withMuseUserAgent } from "./muse-env.ts";

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function refreshContext(
	fields: Record<string, unknown> = {},
): RefreshModelsContext {
	return {
		allowNetwork: true,
		credential: { type: "api_key", key: "test-key" },
		signal: new AbortController().signal,
		...fields,
	} as unknown as RefreshModelsContext;
}

function cachedCatalog(id = "muse-cached"): ModelsStoreEntry {
	const model = fallbackModels()[0];
	if (!model) throw new Error("Expected fallback model");
	return {
		models: [
			{
				...model,
				id,
				provider: META_PROVIDER_ID,
				api: "openai-responses",
				baseUrl: META_API_BASE_URL,
			},
		],
	};
}

function fetchMock(
	handler: (...args: Parameters<Fetch>) => Promise<Response>,
): Fetch {
	return Object.assign(handler, { preconnect() {} });
}

function catalogFetch(): Fetch {
	return fetchMock(async () => jsonResponse({ data: [{ id: "muse-fresh" }] }));
}

const unavailableFetch = fetchMock(async () => {
	throw new Error("Network should not be requested");
});

describe("Meta catalog persistence compatibility", () => {
	for (const credential of [
		{ type: "api_key", key: "api-key" },
		{
			type: "oauth",
			access: "oauth-key",
			refresh: "identity",
			expires: Date.now() + 1000,
		},
	]) {
		test(`fetches catalogs using the effective ${credential.type} credential`, async () => {
			let request:
				| {
						url: string;
						headers: Headers;
						signal: AbortSignal | null | undefined;
				  }
				| undefined;
			const context = refreshContext({ credential });
			const models = await refreshMetaModels(
				context,
				fetchMock(async (input, init) => {
					request = {
						url: String(input),
						headers: new Headers(init?.headers),
						signal: init?.signal,
					};
					return jsonResponse({ data: [{ id: "muse-fresh" }] });
				}),
			);
			expect(request?.url).toBe(META_MODEL_CATALOG_URL);
			expect(request?.headers.get("Authorization")).toBe(
				`Bearer ${credential.type === "api_key" ? credential.key : credential.access}`,
			);
			expect(request?.headers.get("x-api-version")).toBe("1.0.0");
			expect(request?.signal).toBe(context.signal);
			expect(models.map(({ id }) => id)).toEqual(["muse-fresh"]);
		});
	}

	test("persists complete, detached models through the Pi 0.83 store", async () => {
		let persisted: ModelsStoreEntry | undefined;
		const context = refreshContext({
			store: {
				read: async () => undefined,
				write: async (entry: ModelsStoreEntry) => {
					persisted = entry;
				},
			},
		});
		const models = await refreshMetaModels(context, catalogFetch());
		const fresh = models[0];
		const stored = persisted?.models[0];
		if (!fresh || !stored)
			throw new Error("Expected fresh and persisted models");
		expect(stored).toMatchObject({
			id: "muse-fresh",
			provider: META_PROVIDER_ID,
			api: "openai-responses",
			baseUrl: META_API_BASE_URL,
		});
		expect(persisted?.checkedAt).toBeGreaterThan(0);
		stored.cost.input = 42;
		stored.input.length = 0;
		if (stored.thinkingLevelMap) stored.thinkingLevelMap.high = "changed";
		if (stored.compat && "supportsToolSearch" in stored.compat)
			stored.compat.supportsToolSearch = false;
		expect(fresh.cost.input).toBe(0);
		expect(fresh.input).toEqual(["text"]);
		expect(fresh.thinkingLevelMap?.high).toBe("high");
		expect(fresh.compat).toMatchObject({ supportsToolSearch: true });
	});

	test("prefers generation-checked publish and never falls through to a legacy write after rejection", async () => {
		let published = 0;
		let writes = 0;
		const context = refreshContext({
			publish: async (publication: { persist?: ModelsStoreEntry | null }) => {
				published++;
				expect(publication.persist?.models[0]?.provider).toBe(META_PROVIDER_ID);
				return false;
			},
			store: {
				read: async () => undefined,
				write: async () => {
					writes++;
				},
			},
		});
		expect((await refreshMetaModels(context, catalogFetch()))[0]?.id).toBe(
			"muse-fresh",
		);
		expect(published).toBe(1);
		expect(writes).toBe(0);
	});

	test("publishing cannot mutate the returned fresh catalog", async () => {
		const context = refreshContext({
			publish: async (publication: { persist?: ModelsStoreEntry | null }) => {
				const model = publication.persist?.models[0];
				if (!model) throw new Error("Expected publication");
				model.cost.input = 42;
				if (model.compat && "supportsToolSearch" in model.compat)
					model.compat.supportsToolSearch = false;
				return true;
			},
		});
		const [model] = await refreshMetaModels(context, catalogFetch());
		expect(model?.cost.input).toBe(0);
		expect(model?.compat).toMatchObject({ supportsToolSearch: true });
	});

	for (const api of ["publish", "store"] as const) {
		test(`keeps fresh models usable when ${api} persistence fails`, async () => {
			const fail = async () => {
				throw new Error("Persistence unavailable");
			};
			const context = refreshContext(
				api === "publish"
					? { publish: fail }
					: { store: { read: async () => undefined, write: fail } },
			);
			expect((await refreshMetaModels(context, catalogFetch()))[0]?.id).toBe(
				"muse-fresh",
			);
		});
	}

	test("prefers the immutable snapshot and does not read the legacy store", async () => {
		let reads = 0;
		const context = refreshContext({
			allowNetwork: false,
			stored: cachedCatalog(),
			store: {
				read: async () => {
					reads++;
					throw new Error("Unexpected read");
				},
			},
		});
		expect((await refreshMetaModels(context, unavailableFetch))[0]?.id).toBe(
			"muse-cached",
		);
		expect(reads).toBe(0);
	});

	for (const fields of [
		{ allowNetwork: false },
		{ credential: undefined },
		{ signal: AbortSignal.abort() },
	]) {
		test(`restores cached models without requesting network for ${Object.keys(fields)[0]}`, async () => {
			const context = refreshContext({ stored: cachedCatalog(), ...fields });
			expect((await refreshMetaModels(context, unavailableFetch))[0]?.id).toBe(
				"muse-cached",
			);
		});
	}

	test("cache read failures and malformed snapshots retain bundled fallbacks", async () => {
		for (const fields of [
			{ stored: { models: null } },
			{
				stored: {
					models: [
						null,
						{},
						{ provider: "other", api: "openai-responses", id: "invalid" },
					],
				},
			},
			{
				store: {
					read: async () => {
						throw new Error("Read failed");
					},
				},
			},
		]) {
			expect(
				await refreshMetaModels(
					refreshContext({ allowNetwork: false, ...fields }),
					unavailableFetch,
				),
			).toEqual(fallbackModels());
		}
	});

	for (const [name, fetchImpl] of [
		["empty", fetchMock(async () => jsonResponse({ data: [] }))],
		[
			"malformed",
			fetchMock(async () => jsonResponse({ data: [null, { id: 42 }] })),
		],
		["invalid JSON", fetchMock(async () => new Response("invalid"))],
		[
			"HTTP failure",
			fetchMock(async () => jsonResponse({ message: "failed" }, 500)),
		],
		[
			"network failure",
			fetchMock(async () => {
				throw new Error("Unreachable");
			}),
		],
	] as const) {
		test(`retains the cache after ${name} catalogs without persisting`, async () => {
			let publishes = 0;
			const context = refreshContext({
				stored: cachedCatalog(),
				publish: async () => {
					publishes++;
					return true;
				},
			});
			expect((await refreshMetaModels(context, fetchImpl))[0]?.id).toBe(
				"muse-cached",
			);
			expect(publishes).toBe(0);
		});
	}

	test("restoring a snapshot re-gates Contributor max after the opt-in changes", async () => {
		const cached = await withMuseUserAgent("1", () =>
			cachedCatalog("muse-spark-1.3-contributor"),
		);
		const model = cached.models[0];
		if (!model) throw new Error("Expected cached Contributor");
		model.thinkingLevelMap = { ...model.thinkingLevelMap, max: "max" };
		await withMuseUserAgent(undefined, async () => {
			const [restored] = await refreshMetaModels(
				refreshContext({ allowNetwork: false, stored: cached }),
				unavailableFetch,
			);
			expect(restored?.thinkingLevelMap?.max).toBeNull();
			expect(model.thinkingLevelMap?.max).toBe("max");
		});
	});

	test("propagates an in-flight cancellation instead of silently restoring cache", async () => {
		const controller = new AbortController();
		let publishes = 0;
		const context = refreshContext({
			signal: controller.signal,
			stored: cachedCatalog(),
			publish: async () => {
				publishes++;
				return true;
			},
		});
		await expect(
			refreshMetaModels(
				context,
				fetchMock(async () => {
					controller.abort();
					throw new Error("Fetch cancelled");
				}),
			),
		).rejects.toThrow("Fetch cancelled");
		expect(publishes).toBe(0);
	});

	test("does not persist a successful response completed after cancellation", async () => {
		const controller = new AbortController();
		let publishes = 0;
		const context = refreshContext({
			signal: controller.signal,
			publish: async () => {
				publishes++;
				return true;
			},
		});
		await refreshMetaModels(
			context,
			fetchMock(async () => {
				controller.abort();
				return jsonResponse({ data: [{ id: "muse-fresh" }] });
			}),
		);
		expect(publishes).toBe(0);
	});
});
