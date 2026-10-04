import { afterEach, describe, expect, test } from "bun:test";
import {
	type CredentialStore,
	InMemoryModelsStore,
	type ModelsStore,
} from "@earendil-works/pi-ai";
import {
	META_API_BASE_URL,
	META_MODEL_CATALOG_URL,
	META_PROVIDER_ID,
} from "../src/meta/constants.ts";
import { createMetaProviderConfig } from "../src/meta/provider.ts";

const CATALOG_BASE_URL = "https://pidev.invalid";
const META_ONLY_MODEL = "muse-spark-meta-only";
const PIDEV_ONLY_MODEL = "muse-spark-pidev-only";
const NETWORK_REFRESH = {
	allowNetwork: true,
	providers: [META_PROVIDER_ID],
} as const;

/** The ModelRuntime surface these tests drive, typed locally so every CI Pi version typechecks. */
interface PiModelRuntime {
	getModels(providerId: string): readonly { id: string; baseUrl: string }[];
	registerProvider(providerId: string, config: unknown): void;
	refresh(options: {
		allowNetwork: boolean;
		force?: boolean;
		providers: readonly string[];
	}): Promise<{ errors: ReadonlyMap<string, Error> }>;
}
interface PiModelRuntimeClass {
	create(options: Record<string, unknown>): Promise<PiModelRuntime>;
}

function credentials(): CredentialStore {
	const credential = {
		type: "oauth" as const,
		refresh: "identity-token",
		access: "model-api-key",
		expires: Date.now() + 3_600_000,
	};
	return {
		read: async (providerId: string) =>
			providerId === META_PROVIDER_ID ? credential : undefined,
		list: async () => [{ providerId: META_PROVIDER_ID, type: "oauth" }],
		modify: async () => credential,
		delete: async () => {},
	};
}

function runtimeOptions(modelsStore: ModelsStore): Record<string, unknown> {
	return {
		credentials: credentials(),
		modelsPath: null,
		modelsStore,
		catalogBaseUrl: CATALOG_BASE_URL,
		refreshOnCreate: false,
	};
}

/** Only Pi >=0.87 composes this extension over a built-in `meta` provider with a pi.dev overlay. */
async function loadModelRuntime(): Promise<PiModelRuntimeClass | undefined> {
	// A non-literal specifier keeps older Pi declarations, which lack this module, typechecking.
	const builtinMetaProvider = "@earendil-works/pi-ai/providers/meta";
	try {
		await import(builtinMetaProvider);
	} catch {
		return undefined;
	}
	// Imported only here: Pi 0.85.0's entrypoint cannot load without an undeclared dependency.
	const agent: Record<string, unknown> = await import(
		"@earendil-works/pi-coding-agent"
	);
	return agent.ModelRuntime as PiModelRuntimeClass;
}

const ModelRuntime = await loadModelRuntime();
const runtimeTest = ModelRuntime ? test : test.skip;

async function metaRuntime(modelsStore: ModelsStore): Promise<PiModelRuntime> {
	if (!ModelRuntime) throw new Error("Pi ModelRuntime is unavailable");
	const runtime = await ModelRuntime.create(runtimeOptions(modelsStore));
	runtime.registerProvider(META_PROVIDER_ID, createMetaProviderConfig());
	return runtime;
}

function jsonResponse(
	body: unknown,
	status = 200,
	headers: Record<string, string> = {},
): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json", ...headers },
	});
}

function pidevCatalog(): Response {
	return jsonResponse(
		{
			models: [
				{
					id: PIDEV_ONLY_MODEL,
					name: "pi.dev only",
					api: "openai-responses",
					baseUrl: META_API_BASE_URL,
					reasoning: true,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 1_048_576,
					maxTokens: 131_072,
				},
			],
		},
		200,
		{ etag: '"pidev"', "last-modified": new Date().toUTCString() },
	);
}

function metaCatalog(): Response {
	return jsonResponse({
		data: [{ id: "muse-spark-1.3" }, { id: META_ONLY_MODEL }],
	});
}

interface CatalogRoutes {
	pidev: () => Response;
	meta: () => Response;
}

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

/** Route pi.dev and Meta catalog requests to `routes`, counting each host's requests. */
function stubCatalogs(routes: CatalogRoutes) {
	const calls = { pidev: 0, meta: 0, unexpected: [] as string[] };
	globalThis.fetch = Object.assign(
		async (input: Parameters<typeof fetch>[0]) => {
			const url = input instanceof Request ? input.url : String(input);
			if (url.startsWith(`${CATALOG_BASE_URL}/`)) {
				calls.pidev++;
				return routes.pidev();
			}
			if (url === META_MODEL_CATALOG_URL) {
				calls.meta++;
				return routes.meta();
			}
			calls.unexpected.push(url);
			throw new Error(`Unexpected request: ${url}`);
		},
		{ preconnect: originalFetch.preconnect },
	);
	return calls;
}

describe("Meta catalog refresh inside Pi's ModelRuntime", () => {
	runtimeTest(
		"a persisted Meta catalog keeps pi.dev inside its freshness window",
		async () => {
			const calls = stubCatalogs({ pidev: pidevCatalog, meta: metaCatalog });
			const store = new InMemoryModelsStore();
			const runtime = await metaRuntime(store);
			for (let refresh = 0; refresh < 2; refresh++) {
				const result = await runtime.refresh(NETWORK_REFRESH);
				expect(result.errors.get(META_PROVIDER_ID)).toBeUndefined();
			}
			expect(calls).toEqual({ pidev: 1, meta: 2, unexpected: [] });
			const entry = await store.read(META_PROVIDER_ID);
			expect(entry).toMatchObject({ lastModified: 0, source: "pi-meta-oauth" });
			expect(entry?.etag).toBeUndefined();
		},
	);

	runtimeTest(
		"a pi.dev outage does not skip the Meta catalog refresh while the Meta entry is fresh",
		async () => {
			const routes: CatalogRoutes = { pidev: pidevCatalog, meta: metaCatalog };
			const calls = stubCatalogs(routes);
			const runtime = await metaRuntime(new InMemoryModelsStore());
			await runtime.refresh(NETWORK_REFRESH);
			routes.pidev = () => {
				throw new TypeError("pi.dev blocked");
			};
			const result = await runtime.refresh(NETWORK_REFRESH);
			expect(result.errors.get(META_PROVIDER_ID)).toBeUndefined();
			expect(calls).toEqual({ pidev: 1, meta: 2, unexpected: [] });
		},
	);

	runtimeTest(
		"a failed Meta refresh keeps the last Meta catalog over pi.dev's overlay for offline restores",
		async () => {
			const routes: CatalogRoutes = { pidev: pidevCatalog, meta: metaCatalog };
			const calls = stubCatalogs(routes);
			const store = new InMemoryModelsStore();
			const runtime = await metaRuntime(store);
			await runtime.refresh(NETWORK_REFRESH);
			routes.meta = () => jsonResponse({ message: "unavailable" }, 502);
			// Forcing the overlay makes it rewrite the shared `meta` entry before the Meta refresh fails.
			const failed = await runtime.refresh({ ...NETWORK_REFRESH, force: true });
			expect(failed.errors.get(META_PROVIDER_ID)).toBeUndefined();
			expect(calls).toEqual({ pidev: 2, meta: 2, unexpected: [] });

			const restarted = await metaRuntime(store);
			await restarted.refresh({
				allowNetwork: false,
				providers: [META_PROVIDER_ID],
			});
			const models = restarted.getModels(META_PROVIDER_ID);
			expect(models.map(({ id }) => id)).toEqual([
				"muse-spark-1.3",
				META_ONLY_MODEL,
			]);
			expect(models.every(({ baseUrl }) => baseUrl === META_API_BASE_URL)).toBe(
				true,
			);
		},
	);
});
