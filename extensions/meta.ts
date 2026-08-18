import type {
	Api,
	Model,
	ModelsStoreEntry,
	OAuthCredentials,
	OAuthLoginCallbacks,
	RefreshModelsContext,
} from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ProviderConfig,
} from "@earendil-works/pi-coding-agent";

export const META_PROVIDER_ID = "meta";
export const META_API_BASE_URL = "https://api.meta.ai/v1";
export const META_MODEL_CATALOG_URL = "https://api.meta.ai/v1/models";
export const META_AUTH_BASE_URL = "https://auth.meta.com";
export const META_CLIENT_ID = "1031625952748946";
export const META_FILES_URL = `${META_API_BASE_URL}/files`;
const META_ENV_VAR = "META_API_KEY";

const DEVICE_AUTHORIZATION_URL = `${META_AUTH_BASE_URL}/oidc/device/authorization/`;
const DEVICE_TOKEN_URL = `${META_AUTH_BASE_URL}/oidc/device/token/`;
const API_KEY_MINT_URL = "https://api.meta.ai/muse-code/key";
const DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const API_KEY_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;

export type MetaProviderModel = NonNullable<ProviderConfig["models"]>[number];
type Fetch = typeof fetch;
type Sleep = (milliseconds: number) => Promise<void>;

interface DeviceAuthorization {
	device_code: string;
	user_code: string;
	verification_uri: string;
	verification_uri_complete?: string;
	expires_in?: number;
	interval?: number;
}

interface DeviceTokenGrant {
	access_token: string;
}

interface OAuthError {
	error?: string;
	error_description?: string;
}

interface MintResponse {
	api_key?: string;
	base_url?: string;
	require_payment?: boolean;
	action_url?: string;
}

interface CatalogResponse {
	data?: MetaCatalogModel[];
}

interface MetaCatalogModel {
	id?: string;
	metadata?: {
		"muse-code"?: {
			name?: string;
			is_hidden?: boolean;
			reasoning?: boolean;
			modalities?: { input?: string[] };
			limit?: { context?: number; output?: number };
			variants?: Record<string, { reasoningEffort?: string }>;
			cost?: {
				input?: string | number;
				output?: string | number;
				cached?: string | number;
			};
		};
	};
}

// Media capabilities kept as "text"+"image" for pi-ai type compat (pi-ai 0.83/0.84 only allows those),
// with "video"/"audio" advertised via cast so future pi-ai that expands the union picks them up.
// See media.ts for the before_provider_request rewrite that makes @video/@audio work today
// despite UserMessage.content being string | (TextContent | ImageContent)[] .
const FALLBACK_MODELS: MetaProviderModel[] = [
	{
		id: "muse-spark-1.2",
		name: "Muse Spark 1.2",
		reasoning: true,
		thinkingLevelMap: {
			off: null,
			minimal: "minimal",
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: "xhigh",
			max: null,
		},
		input: [
			"text",
			"image",
			"video",
			"audio",
		] as unknown as MetaProviderModel["input"],
		cost: { input: 1.25, output: 4.25, cacheRead: 0.15, cacheWrite: 0 },
		contextWindow: 1_048_576,
		maxTokens: 256_000,
		compat: { supportsReasoningEffort: true, supportsToolSearch: true },
	},
	{
		id: "muse-spark-1.2-contributor",
		name: "Muse Spark 1.2 Contributor",
		reasoning: true,
		thinkingLevelMap: {
			off: null,
			minimal: "minimal",
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: "xhigh",
			max: null,
		},
		input: [
			"text",
			"image",
			"video",
			"audio",
		] as unknown as MetaProviderModel["input"],
		cost: { input: 0.1, output: 0.2, cacheRead: 0.002, cacheWrite: 0 },
		contextWindow: 1_048_576,
		maxTokens: 256_000,
		compat: { supportsReasoningEffort: true, supportsToolSearch: true },
	},
	{
		id: "muse-spark-1.1",
		name: "Muse Spark 1.1",
		reasoning: true,
		thinkingLevelMap: {
			off: null,
			minimal: "minimal",
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: "xhigh",
			max: null,
		},
		input: [
			"text",
			"image",
			"video",
			"audio",
		] as unknown as MetaProviderModel["input"],
		cost: { input: 1.25, output: 4.25, cacheRead: 0.15, cacheWrite: 0 },
		contextWindow: 1_048_576,
		maxTokens: 256_000,
		compat: { supportsReasoningEffort: true, supportsToolSearch: true },
	},
];

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function responseBody(
	response: Response,
): Promise<Record<string, unknown>> {
	const text = await response.text();
	if (!text) return {};
	try {
		const value = JSON.parse(text) as unknown;
		return value && typeof value === "object" && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}

function errorDetail(body: Record<string, unknown>): string | undefined {
	for (const key of ["error_description", "detail", "message", "error"]) {
		const value = body[key];
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return undefined;
}

async function postForm<T>(
	url: string,
	fields: Record<string, string>,
	fetchImpl: Fetch,
): Promise<{ response: Response; body: T & Record<string, unknown> }> {
	const response = await fetchImpl(url, {
		method: "POST",
		headers: {
			Accept: "application/json",
			"Content-Type": "application/x-www-form-urlencoded",
		},
		body: new URLSearchParams(fields),
		redirect: "manual",
	});
	return {
		response,
		body: (await responseBody(response)) as T & Record<string, unknown>,
	};
}

function isAbortSignal(value: unknown): value is AbortSignal {
	return (
		typeof value === "object" &&
		value !== null &&
		"aborted" in value &&
		typeof (value as AbortSignal).aborted === "boolean"
	);
}

export async function mintMetaApiKey(
	identityToken: string,
	fetchImpl: Fetch = fetch,
	signal?: AbortSignal,
): Promise<string> {
	const response = await fetchImpl(API_KEY_MINT_URL, {
		method: "POST",
		headers: {
			Accept: "application/json",
			Authorization: `Bearer ${identityToken}`,
			"Content-Type": "application/json",
			"x-api-version": "1.0.0",
		},
		body: "{}",
		signal,
	});
	const body = (await responseBody(response)) as MintResponse &
		Record<string, unknown>;
	if (!response.ok) {
		throw new Error(
			`Meta API-key mint failed (HTTP ${response.status})${errorDetail(body) ? `: ${errorDetail(body)}` : ""}`,
		);
	}
	if (typeof body.api_key !== "string" || !body.api_key) {
		const setup =
			typeof body.action_url === "string" && body.action_url
				? ` Complete setup at ${body.action_url}.`
				: "";
		throw new Error(`Meta did not issue an API key.${setup}`);
	}
	return body.api_key;
}

export async function loginMeta(
	callbacks: OAuthLoginCallbacks,
	fetchImpl: Fetch = fetch,
	sleep: Sleep = delay,
): Promise<OAuthCredentials> {
	callbacks.onProgress?.("Starting Meta device authorization…");
	const authorization = await postForm<DeviceAuthorization>(
		DEVICE_AUTHORIZATION_URL,
		{ client_id: META_CLIENT_ID },
		fetchImpl,
	);
	if (!authorization.response.ok) {
		throw new Error(
			`Meta login could not be started (HTTP ${authorization.response.status})${errorDetail(authorization.body) ? `: ${errorDetail(authorization.body)}` : ""}`,
		);
	}
	const device = authorization.body;
	if (!device.device_code || !device.user_code || !device.verification_uri) {
		throw new Error("Meta device authorization returned an incomplete response");
	}

	let intervalSeconds =
		Number.isFinite(device.interval) && Number(device.interval) > 0
			? Number(device.interval)
			: 5;
	const expiresInSeconds =
		Number.isFinite(device.expires_in) && Number(device.expires_in) > 0
			? Number(device.expires_in)
			: 900;
	const deadline = Date.now() + expiresInSeconds * 1000;
	callbacks.onDeviceCode({
		userCode: device.user_code,
		verificationUri: device.verification_uri_complete || device.verification_uri,
		intervalSeconds,
		expiresInSeconds,
	});
	callbacks.onProgress?.("Waiting for Meta login approval…");

	let identityToken: string | undefined;
	while (Date.now() < deadline) {
		await sleep(intervalSeconds * 1000);
		const grant = await postForm<DeviceTokenGrant & OAuthError>(
			DEVICE_TOKEN_URL,
			{
				grant_type: DEVICE_CODE_GRANT,
				device_code: device.device_code,
				client_id: META_CLIENT_ID,
			},
			fetchImpl,
		);
		if (grant.response.ok && grant.body.access_token) {
			identityToken = grant.body.access_token;
			break;
		}
		switch (grant.body.error) {
			case "authorization_pending":
				continue;
			case "slow_down":
				intervalSeconds += 5;
				continue;
			case "access_denied":
				throw new Error("Meta login was denied");
			case "expired_token":
				throw new Error("Meta login request expired");
			default:
				throw new Error(
					`Meta login failed (HTTP ${grant.response.status})${errorDetail(grant.body) ? `: ${errorDetail(grant.body)}` : ""}`,
				);
		}
	}
	if (!identityToken) throw new Error("Meta login request expired");

	callbacks.onProgress?.("Enabling Meta Model API access…");
	const apiKey = await mintMetaApiKey(identityToken, fetchImpl);
	return {
		refresh: identityToken,
		access: apiKey,
		expires: Date.now() + API_KEY_REFRESH_INTERVAL_MS,
	};
}

export async function refreshMetaToken(
	credentials: OAuthCredentials,
	fetchOrSignal: Fetch | AbortSignal = fetch,
): Promise<OAuthCredentials> {
	if (!credentials.refresh)
		throw new Error(
			"Meta login is missing its identity token; run /login meta again",
		);
	// Pi 0.83 calls refreshToken(credentials). Pi 0.84 passes AbortSignal as
	// the second argument. Tests inject a fetch mock in that slot.
	const fetchImpl = typeof fetchOrSignal === "function" ? fetchOrSignal : fetch;
	const signal = isAbortSignal(fetchOrSignal) ? fetchOrSignal : undefined;
	if (signal?.aborted) {
		throw new Error("Meta token refresh was cancelled");
	}
	return {
		...credentials,
		access: await mintMetaApiKey(credentials.refresh, fetchImpl, signal),
		expires: Date.now() + API_KEY_REFRESH_INTERVAL_MS,
	};
}

function finitePositive(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? value
		: fallback;
}

function numericCost(value: unknown, fallback: number): number {
	const number =
		typeof value === "number"
			? value
			: typeof value === "string" && value.trim()
				? Number(value)
				: Number.NaN;
	return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function displayName(id: string): string {
	return id
		.split("-")
		.map((part) => (part ? part[0].toUpperCase() + part.slice(1) : part))
		.join(" ");
}

function modalitiesToInput(
	modalities: string[] | undefined,
	fallback: MetaProviderModel["input"] | undefined,
): MetaProviderModel["input"] {
	if (!modalities)
		return fallback ?? (["text"] as unknown as MetaProviderModel["input"]);
	const input: string[] = ["text"];
	if (modalities.includes("image")) input.push("image");
	// Advertised via cast until pi-ai expands Model.input union beyond text|image.
	// The before_provider_request hook in media.ts rewrites these to typed media blocks at request time.
	if (modalities.includes("video")) input.push("video");
	if (modalities.includes("audio")) input.push("audio");
	// Some catalogs expose "document"/"pdf" as a modality for PDF handling.
	if (modalities.includes("document") || modalities.includes("pdf")) {
		if (!input.includes("image")) input.push("image"); // PDFs count toward image budget
	}
	return input as unknown as MetaProviderModel["input"];
}

export function toProviderModels(
	catalog: CatalogResponse,
): MetaProviderModel[] {
	return (catalog.data ?? []).flatMap((entry) => {
		if (typeof entry.id !== "string" || !entry.id) return [];
		const metadata = entry.metadata?.["muse-code"];
		if (metadata?.is_hidden) return [];
		const fallback = FALLBACK_MODELS.find((model) => model.id === entry.id);
		const catalogName = metadata?.name === entry.id ? undefined : metadata?.name;
		const variants = metadata?.variants ?? {};
		const thinkingLevelMap: NonNullable<MetaProviderModel["thinkingLevelMap"]> = {
			off: null,
			minimal: variants.minimal?.reasoningEffort ?? "minimal",
			low: variants.low?.reasoningEffort ?? "low",
			medium: variants.medium?.reasoningEffort ?? "medium",
			high: variants.high?.reasoningEffort ?? "high",
			xhigh: variants.xhigh?.reasoningEffort ?? "xhigh",
			max: null,
		};
		return [
			{
				id: entry.id,
				name: catalogName || fallback?.name || displayName(entry.id),
				reasoning: metadata?.reasoning ?? fallback?.reasoning ?? true,
				thinkingLevelMap,
				input: modalitiesToInput(metadata?.modalities?.input, fallback?.input),
				cost: {
					input: numericCost(metadata?.cost?.input, fallback?.cost.input ?? 0),
					output: numericCost(metadata?.cost?.output, fallback?.cost.output ?? 0),
					cacheRead: numericCost(
						metadata?.cost?.cached,
						fallback?.cost.cacheRead ?? 0,
					),
					cacheWrite: 0,
				},
				contextWindow: finitePositive(
					metadata?.limit?.context,
					fallback?.contextWindow ?? 1_048_576,
				),
				maxTokens: finitePositive(
					metadata?.limit?.output,
					fallback?.maxTokens ?? 256_000,
				),
				compat: { supportsReasoningEffort: true, supportsToolSearch: true },
			} satisfies MetaProviderModel,
		];
	});
}

interface CatalogStore {
	read(): Promise<ModelsStoreEntry | undefined>;
	write(entry: ModelsStoreEntry): Promise<void>;
}

interface CompatibleRefreshContext {
	credential?: RefreshModelsContext["credential"];
	allowNetwork: boolean;
	signal?: AbortSignal;
	// Pi 0.83 catalog persistence API.
	store?: CatalogStore;
	// Pi 0.84 generation-checked catalog persistence API.
	stored?: Readonly<ModelsStoreEntry>;
	publish?(publication: { persist?: ModelsStoreEntry | null }): Promise<boolean>;
}

function providerModelsFromStore(
	entry: Readonly<ModelsStoreEntry> | undefined,
): MetaProviderModel[] {
	return (entry?.models ?? []).flatMap((model: Model<Api>) => {
		if (model.provider !== META_PROVIDER_ID || model.api !== "openai-responses")
			return [];
		return [
			{
				id: model.id,
				name: model.name,
				api: model.api,
				baseUrl: model.baseUrl,
				reasoning: model.reasoning,
				thinkingLevelMap: model.thinkingLevelMap,
				input: model.input as MetaProviderModel["input"],
				cost: model.cost,
				contextWindow: model.contextWindow,
				maxTokens: model.maxTokens,
				headers: model.headers,
				compat: model.compat as MetaProviderModel["compat"],
			},
		];
	});
}

function modelsForStore(
	models: MetaProviderModel[],
): Model<"openai-responses">[] {
	return models.map((model) => ({
		...model,
		api: "openai-responses",
		provider: META_PROVIDER_ID,
		baseUrl: model.baseUrl ?? META_API_BASE_URL,
		input: model.input as Model<"openai-responses">["input"],
		compat: model.compat as Model<"openai-responses">["compat"],
	}));
}

async function cachedMetaModels(
	context: CompatibleRefreshContext,
): Promise<MetaProviderModel[]> {
	try {
		const stored = context.stored ?? (await context.store?.read());
		return providerModelsFromStore(stored);
	} catch {
		// Catalog persistence is best-effort; bundled fallbacks remain available.
		return [];
	}
}

async function persistMetaModels(
	context: CompatibleRefreshContext,
	entry: ModelsStoreEntry,
): Promise<void> {
	if (context.publish) {
		await context.publish({ persist: entry });
		return;
	}
	await context.store?.write(entry);
}

export async function refreshMetaModels(
	context: RefreshModelsContext,
	fetchImpl: Fetch = fetch,
): Promise<MetaProviderModel[]> {
	const compatibleContext = context as unknown as CompatibleRefreshContext;
	if (!context.allowNetwork || context.signal?.aborted) {
		const cached = await cachedMetaModels(compatibleContext);
		return cached.length > 0 ? cached : [...FALLBACK_MODELS];
	}
	const apiKey =
		context.credential?.type === "oauth"
			? context.credential.access
			: context.credential?.type === "api_key"
				? context.credential.key
				: undefined;
	if (!apiKey) {
		const cached = await cachedMetaModels(compatibleContext);
		return cached.length > 0 ? cached : [...FALLBACK_MODELS];
	}

	try {
		const response = await fetchImpl(META_MODEL_CATALOG_URL, {
			headers: {
				Accept: "application/json",
				Authorization: `Bearer ${apiKey}`,
				"x-api-version": "1.0.0",
			},
			signal: context.signal,
		});
		const body = (await responseBody(response)) as CatalogResponse &
			Record<string, unknown>;
		if (!response.ok) {
			throw new Error(
				`Meta model catalog failed (HTTP ${response.status})${errorDetail(body) ? `: ${errorDetail(body)}` : ""}`,
			);
		}
		const models = toProviderModels(body);
		if (models.length === 0) {
			const cached = await cachedMetaModels(compatibleContext);
			return cached.length > 0 ? cached : [...FALLBACK_MODELS];
		}
		if (!context.signal?.aborted) {
			try {
				await persistMetaModels(compatibleContext, {
					models: modelsForStore(models),
					checkedAt: Date.now(),
				});
			} catch {
				// Keep the fresh catalog usable even if persistence fails.
			}
		}
		return models;
	} catch (error) {
		if (context.signal?.aborted) throw error;
		const cached = await cachedMetaModels(compatibleContext);
		return cached.length > 0 ? cached : [...FALLBACK_MODELS];
	}
}

export function metaFallbackCost(
	modelId: string,
): MetaProviderModel["cost"] | undefined {
	return FALLBACK_MODELS.find((model) => model.id === modelId)?.cost;
}

/** Meta prompt-cache opt-in. Measured 0% hits on /chat/completions vs 93–99% on /responses with 24h. */
export const META_PROMPT_CACHE_RETENTION = "24h";

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

/**
 * Hermes-equivalent Responses hints for api.meta.ai:
 * setdefault `prompt_cache_retention: 24h`, and drop `reasoning.effort: none`
 * because Meta 400s on it.
 */
export function applyMetaResponsesCacheHints(payload: unknown): unknown {
	const body = asRecord(payload);
	if (!body) return payload;
	if (body.prompt_cache_retention === undefined) {
		body.prompt_cache_retention = META_PROMPT_CACHE_RETENTION;
	}
	const reasoning = asRecord(body.reasoning);
	if (
		reasoning &&
		(reasoning.effort === "none" ||
			reasoning.effort === undefined ||
			reasoning.effort === null)
	) {
		delete body.reasoning;
	}
	return body;
}

export function createMetaProviderConfig(): ProviderConfig {
	return {
		name: "Meta Model API",
		baseUrl: META_API_BASE_URL,
		api: "openai-responses",
		apiKey: "$META_API_KEY",
		models: [...FALLBACK_MODELS],
		refreshModels: refreshMetaModels,
		oauth: {
			name: "Meta Model API (browser login)",
			login: loginMeta,
			refreshToken: refreshMetaToken,
			getApiKey: (credentials: { access: string }) => credentials.access,
		},
	};
}

export default function metaOAuthProvider(pi: ExtensionAPI): void {
	// Allow MODEL_API_KEY as fallback for API-key users — shim to META_API_KEY so $META_API_KEY interpolation works.
	if (
		process.env[META_ENV_VAR] === undefined &&
		process.env["MODEL_API_KEY"] !== undefined
	) {
		process.env[META_ENV_VAR] = process.env["MODEL_API_KEY"];
	}
	if (
		process.env["MODEL_API_KEY"] === undefined &&
		process.env[META_ENV_VAR] !== undefined
	) {
		process.env["MODEL_API_KEY"] = process.env[META_ENV_VAR];
	}
	pi.registerProvider(META_PROVIDER_ID, createMetaProviderConfig());
	pi.on("before_provider_request", (event, ctx) => {
		if (ctx.model?.provider !== META_PROVIDER_ID) return undefined;
		return applyMetaResponsesCacheHints(event.payload);
	});
}
