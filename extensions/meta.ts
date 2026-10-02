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
/**
 * User-Agent captured from the Muse CLI inference entrypoint, kept
 * byte-for-byte (including the linux-x86_64 platform) because it is a
 * captured fingerprint: variants for other platforms are unverified.
 *
 * Sending it on direct Meta Model API requests enables `reasoning.effort:
 * "max"` on muse-spark-1.3-contributor (live-verified 2026-09-25 on
 * login-minted credentials: identical payloads 400 without it and 200
 * with it; API-key parity reported in oh-my-pi#12199). Observed wire
 * behavior, not a permission claim: Meta documents `max` for standard-tier
 * 1.3 only, and the gate may change server-side without notice.
 *
 * Off by default. It impersonates Meta's first-party client, so users opt
 * in with {@link MUSE_USER_AGENT_ENV_VAR}; see {@link isMuseUserAgentEnabled}.
 */
export const MUSE_USER_AGENT =
	"muse-build/1.3.0 (non-interactive; linux-x86_64; build ac7280f2aca67769d1455a8847bb502b617d50f6)";
/** Set to `1`/`true`/`yes` to send {@link MUSE_USER_AGENT} and expose Contributor `max`. */
export const MUSE_USER_AGENT_ENV_VAR = "META_MUSE_USER_AGENT";
/** Models whose `max` effort Meta accepts only with the Muse fingerprint. */
const MUSE_USER_AGENT_MODEL_IDS: ReadonlySet<string> = new Set([
	"muse-spark-1.3-contributor",
]);
const META_ENV_VAR = "META_API_KEY";
const MODEL_API_KEY_ENV_VAR = "MODEL_API_KEY";
const META_API_VERSION = "1.0.0";
const DEFAULT_CONTEXT_WINDOW = 1_048_576;
const DEFAULT_MAX_TOKENS = 256_000;

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

interface DeviceTokenResponse {
	access_token?: string;
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

type ThinkingLevelMap = NonNullable<MetaProviderModel["thinkingLevelMap"]>;

const EFFORT_LEVELS = ["minimal", "low", "medium", "high", "xhigh"] as const;
const STANDARD_COST = {
	input: 1.25,
	output: 4.25,
	cacheRead: 0.15,
	cacheWrite: 0,
};
const CONTRIBUTOR_COST = {
	input: 0.1,
	output: 0.2,
	cacheRead: 0.002,
	cacheWrite: 0,
};

function buildThinkingLevelMap(
	effortFor: (level: (typeof EFFORT_LEVELS)[number]) => string,
	max: string | null,
): ThinkingLevelMap {
	const map: ThinkingLevelMap = { off: null, max };
	for (const level of EFFORT_LEVELS) map[level] = effortFor(level);
	return map;
}

function museCompat(): MetaProviderModel["compat"] {
	return { supportsReasoningEffort: true, supportsToolSearch: true };
}

function museFallbackModel(
	id: string,
	name: string,
	cost: MetaProviderModel["cost"],
	max: string | null = null,
): MetaProviderModel {
	return {
		id,
		name,
		reasoning: true,
		thinkingLevelMap: buildThinkingLevelMap((level) => level, max),
		input: ["text", "image"],
		cost: { ...cost },
		contextWindow: DEFAULT_CONTEXT_WINDOW,
		maxTokens: DEFAULT_MAX_TOKENS,
		compat: museCompat(),
	};
}

const FALLBACK_MODELS: MetaProviderModel[] = [
	museFallbackModel("muse-spark-1.3", "Muse Spark 1.3", STANDARD_COST, "max"),
	// `max` is accepted only with the Muse User-Agent fingerprint (live-verified
	// 2026-09-25). gateMuseMaxEffort() maps it to "max" when META_MUSE_USER_AGENT
	// opts in; otherwise it stays unexposed.
	museFallbackModel(
		"muse-spark-1.3-contributor",
		"Muse Spark 1.3 Contributor",
		CONTRIBUTOR_COST,
	),
	museFallbackModel("muse-spark-1.2", "Muse Spark 1.2", STANDARD_COST),
	museFallbackModel(
		"muse-spark-1.2-contributor",
		"Muse Spark 1.2 Contributor",
		CONTRIBUTOR_COST,
	),
	museFallbackModel("muse-spark-1.1", "Muse Spark 1.1", STANDARD_COST),
];

type MetaEnv = Record<string, string | undefined>;

/** True when the user opted in to the Muse User-Agent fingerprint. */
export function isMuseUserAgentEnabled(env: MetaEnv = process.env): boolean {
	const value = env[MUSE_USER_AGENT_ENV_VAR]?.trim().toLowerCase();
	return value === "1" || value === "true" || value === "yes";
}

/**
 * Expose `max` on fingerprint-gated models only when the fingerprint is
 * enabled, so users who have not opted in are never offered a level that
 * 400s. Any other explicit `max` mapping (e.g. a future server-advertised
 * effort name) passes through unchanged.
 */
function gateMuseMaxEffort(
	model: MetaProviderModel,
	env: MetaEnv = process.env,
): MetaProviderModel {
	const map = model.thinkingLevelMap;
	if (!map || !MUSE_USER_AGENT_MODEL_IDS.has(model.id)) return model;
	if (map.max != null && map.max !== "max") return model;
	return {
		...model,
		thinkingLevelMap: { ...map, max: isMuseUserAgentEnabled(env) ? "max" : null },
	};
}

function fallbackModels(): MetaProviderModel[] {
	return FALLBACK_MODELS.map((model) => gateMuseMaxEffort(model));
}

function fallbackModel(id: string): MetaProviderModel | undefined {
	const model = FALLBACK_MODELS.find((candidate) => candidate.id === id);
	return model && gateMuseMaxEffort(model);
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function finitePositive(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? value
		: fallback;
}

async function responseBody<T = unknown>(
	response: Response,
): Promise<T & Record<string, unknown>> {
	const text = await response.text();
	let value: unknown;
	try {
		value = text ? JSON.parse(text) : undefined;
	} catch {
		value = undefined;
	}
	return (asRecord(value) ?? {}) as T & Record<string, unknown>;
}

function errorDetail(body: Record<string, unknown>): string | undefined {
	for (const key of ["error_description", "detail", "message", "error"]) {
		const value = body[key];
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return undefined;
}

/** `message`, suffixed with the server's error detail when it sent one. */
function detailedError(message: string, body: Record<string, unknown>): Error {
	const detail = errorDetail(body);
	return new Error(detail ? `${message}: ${detail}` : message);
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
	return { response, body: await responseBody<T>(response) };
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
			"x-api-version": META_API_VERSION,
		},
		body: "{}",
		signal,
	});
	const body = await responseBody<MintResponse>(response);
	if (!response.ok) {
		throw detailedError(
			response.status === 401 || response.status === 403
				? `Meta session expired (HTTP ${response.status}); run /login meta again`
				: `Meta API-key mint failed (HTTP ${response.status})`,
			body,
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

function apiKeyExpiry(): number {
	return Date.now() + API_KEY_REFRESH_INTERVAL_MS;
}

async function startDeviceAuthorization(
	fetchImpl: Fetch,
): Promise<DeviceAuthorization> {
	const { response, body } = await postForm<DeviceAuthorization>(
		DEVICE_AUTHORIZATION_URL,
		{ client_id: META_CLIENT_ID },
		fetchImpl,
	);
	if (!response.ok) {
		throw detailedError(
			`Meta login could not be started (HTTP ${response.status})`,
			body,
		);
	}
	if (!body.device_code || !body.user_code || !body.verification_uri) {
		throw new Error("Meta device authorization returned an incomplete response");
	}
	return body;
}

async function pollForIdentityToken(
	deviceCode: string,
	intervalSeconds: number,
	deadline: number,
	fetchImpl: Fetch,
	sleep: Sleep,
): Promise<string> {
	while (Date.now() < deadline) {
		await sleep(intervalSeconds * 1000);
		const { response, body } = await postForm<DeviceTokenResponse>(
			DEVICE_TOKEN_URL,
			{
				grant_type: DEVICE_CODE_GRANT,
				device_code: deviceCode,
				client_id: META_CLIENT_ID,
			},
			fetchImpl,
		);
		if (response.ok && body.access_token) return body.access_token;
		switch (body.error) {
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
				throw detailedError(`Meta login failed (HTTP ${response.status})`, body);
		}
	}
	throw new Error("Meta login request expired");
}

export async function loginMeta(
	callbacks: OAuthLoginCallbacks,
	fetchImpl: Fetch = fetch,
	sleep: Sleep = delay,
): Promise<OAuthCredentials> {
	callbacks.onProgress?.("Starting Meta device authorization…");
	const device = await startDeviceAuthorization(fetchImpl);

	const intervalSeconds = finitePositive(device.interval, 5);
	const expiresInSeconds = finitePositive(device.expires_in, 900);
	const deadline = Date.now() + expiresInSeconds * 1000;
	callbacks.onDeviceCode({
		userCode: device.user_code,
		verificationUri: device.verification_uri_complete || device.verification_uri,
		intervalSeconds,
		expiresInSeconds,
	});
	callbacks.onProgress?.("Waiting for Meta login approval…");
	const identityToken = await pollForIdentityToken(
		device.device_code,
		intervalSeconds,
		deadline,
		fetchImpl,
		sleep,
	);

	callbacks.onProgress?.("Enabling Meta Model API access…");
	return {
		refresh: identityToken,
		access: await mintMetaApiKey(identityToken, fetchImpl),
		expires: apiKeyExpiry(),
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
		expires: apiKeyExpiry(),
	};
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
	if (!modalities) return fallback ?? ["text"];
	const input: MetaProviderModel["input"] = ["text"];
	if (modalities.includes("image")) input.push("image");
	return input;
}

export function toProviderModels(
	catalog: CatalogResponse,
): MetaProviderModel[] {
	return (catalog.data ?? []).flatMap((entry) => {
		if (typeof entry.id !== "string" || !entry.id) return [];
		const metadata = entry.metadata?.["muse-code"];
		if (metadata?.is_hidden) return [];
		// Gated fallbacks: a server-advertised variants.max still wins below.
		const fallback = fallbackModel(entry.id);
		const catalogName = metadata?.name === entry.id ? undefined : metadata?.name;
		const variants = metadata?.variants ?? {};
		const thinkingLevelMap = buildThinkingLevelMap(
			(level) => variants[level]?.reasoningEffort ?? level,
			variants.max?.reasoningEffort ?? fallback?.thinkingLevelMap?.max ?? null,
		);
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
					fallback?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
				),
				maxTokens: finitePositive(
					metadata?.limit?.output,
					fallback?.maxTokens ?? DEFAULT_MAX_TOKENS,
				),
				compat: museCompat(),
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
		// Re-gate on restore: a catalog cached while the fingerprint was enabled
		// must not keep offering Contributor `max` after the user opts out.
		return [
			gateMuseMaxEffort({
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
			}),
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

async function cachedOrFallbackModels(
	context: CompatibleRefreshContext,
): Promise<MetaProviderModel[]> {
	const cached = await cachedMetaModels(context);
	return cached.length > 0 ? cached : fallbackModels();
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

function credentialApiKey(
	credential: RefreshModelsContext["credential"],
): string | undefined {
	if (credential?.type === "oauth") return credential.access;
	if (credential?.type === "api_key") return credential.key;
	return undefined;
}

async function fetchMetaCatalog(
	apiKey: string,
	fetchImpl: Fetch,
	signal: AbortSignal | undefined,
): Promise<MetaProviderModel[]> {
	const response = await fetchImpl(META_MODEL_CATALOG_URL, {
		headers: {
			Accept: "application/json",
			Authorization: `Bearer ${apiKey}`,
			"x-api-version": META_API_VERSION,
		},
		signal,
	});
	const body = await responseBody<CatalogResponse>(response);
	if (!response.ok) {
		throw detailedError(`Meta model catalog failed (HTTP ${response.status})`, body);
	}
	return toProviderModels(body);
}

export async function refreshMetaModels(
	context: RefreshModelsContext,
	fetchImpl: Fetch = fetch,
): Promise<MetaProviderModel[]> {
	// SAFETY: CompatibleRefreshContext is the union of the Pi 0.83 and 0.84
	// refresh-context fields that this adapter probes defensively at runtime.
	const compatibleContext = context as unknown as CompatibleRefreshContext;
	const apiKey = credentialApiKey(context.credential);
	if (!context.allowNetwork || context.signal?.aborted || !apiKey) {
		return cachedOrFallbackModels(compatibleContext);
	}

	try {
		const models = await fetchMetaCatalog(apiKey, fetchImpl, context.signal);
		if (models.length === 0) return cachedOrFallbackModels(compatibleContext);
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
		return cachedOrFallbackModels(compatibleContext);
	}
}

/** Meta prompt-cache opt-in. Measured 0% hits on /chat/completions vs 93–99% on /responses with 24h. */
export const META_PROMPT_CACHE_RETENTION = "24h";

/**
 * Strict direct-endpoint check: https scheme, api.meta.ai hostname
 * (case-insensitive), default port, and a bare /v1 path. WHATWG URL parsing
 * normalizes the equivalent forms (uppercase host, explicit :443) to match;
 * proxies, lookalike hosts (api.meta.ai.evil.com), subpaths, and
 * non-default ports never match, so they never receive the fingerprint.
 */
export function isDirectMetaModelApiUrl(baseUrl: unknown): boolean {
	if (typeof baseUrl !== "string" || !baseUrl) return false;
	let parsed: URL;
	try {
		parsed = new URL(baseUrl);
	} catch {
		return false;
	}
	if (parsed.protocol !== "https:") return false;
	if (parsed.hostname.toLowerCase() !== "api.meta.ai") return false;
	if (parsed.port !== "") return false;
	return parsed.pathname.replace(/\/+$/, "") === "/v1";
}

function hasUserAgentHeader(
	headers: Record<string, string | null>,
): boolean {
	return Object.keys(headers).some(
		(name) => name.toLowerCase() === "user-agent",
	);
}

/**
 * Setdefault the Muse fingerprint for direct Meta Model API requests.
 * Explicit User-Agent headers (any casing, including null suppression)
 * always win; anything but the direct endpoint is left untouched.
 * Applies regardless of credential type: API-key and Muse Code login
 * (minted) credentials both reach the same direct wire. Returns true when
 * the fingerprint was applied.
 */
export function applyMetaUserAgentFingerprint(
	headers: Record<string, string | null>,
	baseUrl: unknown,
): boolean {
	if (!isDirectMetaModelApiUrl(baseUrl)) return false;
	if (hasUserAgentHeader(headers)) return false;
	headers["User-Agent"] = MUSE_USER_AGENT;
	return true;
}

/**
 * Hermes-equivalent Responses hints for api.meta.ai:
 * setdefault `prompt_cache_retention: 24h`, and drop `reasoning.effort: none`
 * because Meta 400s on it.
 */
export function applyMetaResponsesCacheHints(
	payload: unknown,
): Record<string, unknown> | undefined {
	const body = asRecord(payload);
	if (!body) return undefined;
	if (body.prompt_cache_retention === undefined) {
		body.prompt_cache_retention = META_PROMPT_CACHE_RETENTION;
	}
	const reasoning = asRecord(body.reasoning);
	if (reasoning && (reasoning.effort == null || reasoning.effort === "none")) {
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
		models: fallbackModels(),
		refreshModels: refreshMetaModels,
		oauth: {
			name: "Meta Model API (browser login)",
			login: loginMeta,
			refreshToken: refreshMetaToken,
			getApiKey: (credentials: { access: string }) => credentials.access,
		},
	};
}

/**
 * Accept MODEL_API_KEY as an alias for API-key users: mirror whichever of the
 * two is set into the other so `$META_API_KEY` interpolation works. A key that
 * is already set is never overwritten.
 */
function mirrorApiKeyEnv(env: MetaEnv = process.env): void {
	const key = env[META_ENV_VAR] ?? env[MODEL_API_KEY_ENV_VAR];
	if (key === undefined) return;
	env[META_ENV_VAR] ??= key;
	env[MODEL_API_KEY_ENV_VAR] ??= key;
}

export default function metaOAuthProvider(pi: ExtensionAPI): void {
	mirrorApiKeyEnv();
	pi.registerProvider(META_PROVIDER_ID, createMetaProviderConfig());
	pi.on("before_provider_request", (event, ctx) => {
		if (ctx.model?.provider !== META_PROVIDER_ID) return undefined;
		return applyMetaResponsesCacheHints(event.payload);
	});
	pi.on("before_provider_headers", (event, ctx) => {
		const model = ctx.model;
		if (model?.provider !== META_PROVIDER_ID) return;
		// Opt-in only, and only for models that need it: every other Meta
		// request keeps Pi's own User-Agent.
		if (!MUSE_USER_AGENT_MODEL_IDS.has(model.id)) return;
		if (!isMuseUserAgentEnabled()) return;
		// The composed model always carries the effective baseUrl; without
		// it the endpoint cannot be verified, so no fingerprint is sent.
		applyMetaUserAgentFingerprint(event.headers, model.baseUrl);
	});
}
