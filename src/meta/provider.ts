import { META_API_BASE_URL, META_ENV_VAR } from "./constants.ts";
import { refreshMetaModels } from "./model-store.ts";
import { fallbackModels } from "./models.ts";
import { loginMeta, refreshMetaToken } from "./oauth.ts";
import type { MetaProviderConfig } from "./types.ts";

export function createMetaProviderConfig(): MetaProviderConfig {
	return {
		name: "Meta Model API",
		baseUrl: META_API_BASE_URL,
		api: "openai-responses",
		apiKey: `$${META_ENV_VAR}`,
		models: fallbackModels(),
		refreshModels: refreshMetaModels,
		oauth: {
			name: "Meta Model API (browser login)",
			login: loginMeta,
			refreshToken: refreshMetaToken,
			getApiKey: (credentials) => credentials.access,
		},
	};
}
