// Pi's extension loader maps only pi-ai's root, compat, oauth, and providers
// entrypoints; installed extensions cannot resolve `pi-ai/api/*` subpaths.
import { openAIResponsesApi } from "@earendil-works/pi-ai/compat";
import {
	META_API_BASE_URL,
	META_ENV_VAR,
	META_PROVIDER_ID,
} from "./constants.ts";
import { refreshMetaModels } from "./model-store.ts";
import { fallbackModels } from "./models.ts";
import { loginMeta, refreshMetaToken } from "./oauth.ts";
import {
	applyMetaModelHeaders,
	applyMetaResponsesCacheHints,
} from "./request-policy.ts";
import type { MetaProviderConfig } from "./types.ts";

const { streamSimple } = openAIResponsesApi();

export function createMetaProviderConfig(): MetaProviderConfig {
	return {
		name: "Meta Model API",
		baseUrl: META_API_BASE_URL,
		api: "openai-responses",
		apiKey: `$${META_ENV_VAR}`,
		streamSimple(model, context, options) {
			// Pi's global hooks see the session selection, not the in-flight model.
			// This adapter runs after auth/header resolution with the request's endpoint.
			const requestModel = { ...model, api: "openai-responses" as const };
			const headers = { ...model.headers, ...options?.headers };
			applyMetaModelHeaders(headers, requestModel);
			return streamSimple(requestModel, context, {
				...options,
				headers,
				onPayload: async (payload, sentModel) => {
					const replacement = await options?.onPayload?.(payload, sentModel);
					const body = replacement === undefined ? payload : replacement;
					return model.provider === META_PROVIDER_ID
						? (applyMetaResponsesCacheHints(body) ?? body)
						: body;
				},
			});
		},
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
