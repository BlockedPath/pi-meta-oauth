import type {
	Model,
	ModelsStoreEntry,
	RefreshModelsContext,
} from "@earendil-works/pi-ai";
import {
	META_API_BASE_URL,
	META_API_VERSION,
	META_MODEL_CATALOG_URL,
	META_PROVIDER_ID,
} from "./constants.ts";
import { asRecord, errorDetail, responseBody } from "./http.ts";
import {
	fallbackModels,
	restoreProviderModels,
	toProviderModels,
} from "./models.ts";
import type { Fetch, MetaProviderModel } from "./types.ts";

/**
 * Pi >=0.86.1 refreshes its built-in pi.dev `meta` overlay before this extension, through the same
 * models-store key, so persisted entries carry a provenance marker.
 */
const STORE_SOURCE = "pi-meta-oauth";

type OwnedStoreEntry = ModelsStoreEntry & { source: typeof STORE_SOURCE };

interface LegacyCatalogStore {
	read(): Promise<unknown>;
	write(entry: ModelsStoreEntry): Promise<void>;
}

/** The runtime adapter spans Pi 0.83's store and Pi 0.84+'s snapshot/publication API. */
interface CompatibleRefreshContext {
	credential?: RefreshModelsContext["credential"];
	allowNetwork: boolean;
	signal?: AbortSignal;
	store?: LegacyCatalogStore;
	stored?: Readonly<ModelsStoreEntry>;
	publish?(publication: {
		persist?: ModelsStoreEntry | null;
	}): Promise<boolean>;
}

/** Accept marked entries and unmarked ones from older releases; pi.dev overlays set lastModified whenever they persist a catalog. */
function isOwnedEntry(value: unknown): boolean {
	const entry = asRecord(value);
	if (!entry) return false;
	if (entry.source === STORE_SOURCE) return true;
	return (
		entry.source === undefined &&
		entry.lastModified === undefined &&
		entry.etag === undefined
	);
}

async function cachedOrFallbackModels(
	context: CompatibleRefreshContext,
): Promise<MetaProviderModel[]> {
	try {
		const stored = context.stored ?? (await context.store?.read());
		if (isOwnedEntry(stored)) {
			const models = restoreProviderModels(asRecord(stored)?.models);
			if (models.length > 0) return models;
		}
	} catch {
		// Persistence is best-effort; an unreadable cache must not disable the provider.
	}
	return fallbackModels();
}

/** Undo a pi.dev overlay write from this refresh so the last good Meta catalog stays persisted. */
async function republishOwnedEntry(
	context: CompatibleRefreshContext,
): Promise<void> {
	const stored = context.stored;
	if (context.signal?.aborted || !context.publish || !stored) return;
	if (!isOwnedEntry(stored)) return;
	// Keep the original checkedAt: this refresh did not validate the catalog.
	const entry: OwnedStoreEntry = {
		...stored,
		lastModified: 0,
		source: STORE_SOURCE,
	};
	try {
		await context.publish({ persist: entry });
	} catch {
		// The restored catalog remains usable when its persistence fails.
	}
}

async function restoreAfterFailedRefresh(
	context: CompatibleRefreshContext,
): Promise<MetaProviderModel[]> {
	await republishOwnedEntry(context);
	return cachedOrFallbackModels(context);
}

function modelsForStore(
	models: MetaProviderModel[],
): Model<"openai-responses">[] {
	return models.map((model) => {
		const detached = structuredClone(model);
		return {
			...detached,
			api: "openai-responses",
			provider: META_PROVIDER_ID,
			baseUrl: detached.baseUrl ?? META_API_BASE_URL,
		};
	});
}

async function persistModels(
	context: CompatibleRefreshContext,
	models: MetaProviderModel[],
): Promise<void> {
	const entry: OwnedStoreEntry = {
		models: modelsForStore(models),
		checkedAt: Date.now(),
		// Pi's overlay reads lastModified 0 as "no pi.dev catalog" and skips pi.dev while this entry is fresh.
		lastModified: 0,
		source: STORE_SOURCE,
	};
	if (context.publish) {
		// A false result means this generation was superseded; never bypass that check with a legacy write.
		await context.publish({ persist: entry });
	} else {
		await context.store?.write(entry);
	}
}

function modelApiKey(context: CompatibleRefreshContext): string | undefined {
	const credential = context.credential;
	if (credential?.type === "oauth") return credential.access;
	if (credential?.type === "api_key") return credential.key;
	return undefined;
}

/** Restore an offline catalog or refresh it using the effective OAuth/API-key credential. */
export async function refreshMetaModels(
	context: RefreshModelsContext,
	fetchImpl: Fetch = fetch,
): Promise<MetaProviderModel[]> {
	// Pi 0.83 is outside the installed type declarations, but shares these runtime fields.
	const compatibleContext = context as unknown as CompatibleRefreshContext;
	const apiKey = modelApiKey(compatibleContext);
	if (!context.allowNetwork || context.signal?.aborted || !apiKey) {
		return cachedOrFallbackModels(compatibleContext);
	}

	try {
		const response = await fetchImpl(META_MODEL_CATALOG_URL, {
			headers: {
				Accept: "application/json",
				Authorization: `Bearer ${apiKey}`,
				"x-api-version": META_API_VERSION,
			},
			signal: context.signal,
		});
		const body = await responseBody(response);
		if (!response.ok) {
			const detail = errorDetail(body);
			throw new Error(
				`Meta model catalog failed (HTTP ${response.status})${detail ? `: ${detail}` : ""}`,
			);
		}
		const models = toProviderModels(body);
		if (models.length === 0)
			return restoreAfterFailedRefresh(compatibleContext);
		if (!context.signal?.aborted) {
			try {
				await persistModels(compatibleContext, models);
			} catch {
				// The fresh catalog remains usable when its persistence fails.
			}
		}
		return models;
	} catch (error) {
		// An in-flight cancellation belongs to the host; do not disguise it as a successful refresh.
		if (context.signal?.aborted) throw error;
		return restoreAfterFailedRefresh(compatibleContext);
	}
}
