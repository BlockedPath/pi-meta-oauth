import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { META_PROVIDER_ID } from "../src/meta/constants.ts";
import { synchronizeMetaApiKeyAliases } from "../src/meta/environment.ts";
import { createMetaProviderConfig } from "../src/meta/provider.ts";

// Preserve the extension's existing named exports for callers and wire tests.
export {
	META_API_BASE_URL,
	META_AUTH_BASE_URL,
	META_CLIENT_ID,
	META_MODEL_CATALOG_URL,
	META_PROMPT_CACHE_RETENTION,
	META_PROVIDER_ID,
	MUSE_USER_AGENT,
	MUSE_USER_AGENT_ENV_VAR,
} from "../src/meta/constants.ts";
export { refreshMetaModels } from "../src/meta/model-store.ts";
export { metaFallbackCost, toProviderModels } from "../src/meta/models.ts";
export { isMuseUserAgentEnabled } from "../src/meta/muse-policy.ts";
export {
	loginMeta,
	mintMetaApiKey,
	refreshMetaToken,
} from "../src/meta/oauth.ts";
export { createMetaProviderConfig } from "../src/meta/provider.ts";
export {
	applyMetaResponsesCacheHints,
	applyMetaUserAgentFingerprint,
	isDirectMetaModelApiUrl,
} from "../src/meta/request-policy.ts";
export type { MetaProviderModel } from "../src/meta/types.ts";

export default function metaOAuthProvider(pi: ExtensionAPI): void {
	synchronizeMetaApiKeyAliases(process.env);
	pi.registerProvider(META_PROVIDER_ID, createMetaProviderConfig());
}
