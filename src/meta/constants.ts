export const META_PROVIDER_ID = "meta";
export const META_API_BASE_URL = "https://api.meta.ai/v1";
export const META_MODEL_CATALOG_URL = `${META_API_BASE_URL}/models`;
export const META_AUTH_BASE_URL = "https://auth.meta.com";
export const META_CLIENT_ID = "1031625952748946";
export const META_API_VERSION = "1.0.0";
export const META_ENV_VAR = "META_API_KEY";
export const MODEL_API_ENV_VAR = "MODEL_API_KEY";

export const DEVICE_AUTHORIZATION_URL = `${META_AUTH_BASE_URL}/oidc/device/authorization/`;
export const DEVICE_TOKEN_URL = `${META_AUTH_BASE_URL}/oidc/device/token/`;
export const API_KEY_MINT_URL = "https://api.meta.ai/muse-code/key";
export const DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
export const API_KEY_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Captured Muse CLI fingerprint. Preserve its bytes, including the platform
 * segment: alternative fingerprints have not been verified. This is an
 * opt-in compatibility workaround for Contributor `max`, not a supported API
 * contract; see the README for its account and compatibility implications.
 */
export const MUSE_USER_AGENT =
	"muse-build/1.3.0 (non-interactive; linux-x86_64; build ac7280f2aca67769d1455a8847bb502b617d50f6)";
/** Set to `1`, `true`, or `yes` to enable the Muse fingerprint. */
export const MUSE_USER_AGENT_ENV_VAR = "META_MUSE_USER_AGENT";
export const META_PROMPT_CACHE_RETENTION = "24h";
