// Pi's extension loader maps only pi-ai's root, compat, oauth, and providers
// entrypoints; installed extensions cannot resolve `pi-ai/api/*` subpaths.
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	createAssistantMessageEventStream,
	openAIResponsesApi,
} from "@earendil-works/pi-ai/compat";
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
	isDirectMetaModelApiUrl,
	rewriteMetaAttestationError,
} from "./request-policy.ts";
import { MetaToolAliases } from "./tool-aliases.ts";
import type { MetaProviderConfig } from "./types.ts";

const { streamSimple } = openAIResponsesApi();

type MetaStream = ReturnType<typeof streamSimple>;

/**
 * Restore Pi tool names and explain subscription attestation failures.
 * The loop drains upstream itself, so consumers that only await `result()`
 * still get the final message. Exported for tests, not from the entrypoint.
 */
export function forwardMetaStream(
	send: () => MetaStream,
	model: { id: string; provider: string },
	aliases?: MetaToolAliases,
): MetaStream {
	const downstream = createAssistantMessageEventStream();
	void (async () => {
		let partial: AssistantMessage | undefined;
		let settled = false;
		try {
			for await (const upstreamEvent of send()) {
				const event = aliases?.restoreEvent(upstreamEvent) ?? upstreamEvent;
				if (event.type === "error") {
					rewriteMetaAttestationError(event.error);
					settled = true;
				} else if (event.type === "done") {
					rewriteMetaAttestationError(event.message);
					settled = true;
				} else partial = event.partial;
				downstream.push(event);
			}
			// Ending a stream without a result leaves result() pending forever.
			if (!settled) throw new Error("Meta stream ended without a result");
		} catch (error) {
			// pi-ai reports its own setup and transport failures as error events, so
			// this covers a throw from send() or the loop above and a stream that
			// ended early: downstream always settles with an error message.
			const message: AssistantMessage = partial ?? {
				role: "assistant",
				content: [],
				api: "openai-responses",
				provider: model.provider,
				model: model.id,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "error",
				timestamp: Date.now(),
			};
			message.stopReason = "error";
			message.errorMessage =
				error instanceof Error ? error.message : String(error);
			rewriteMetaAttestationError(message);
			downstream.push({ type: "error", reason: "error", error: message });
		} finally {
			downstream.end();
		}
	})();
	return downstream;
}

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
			const isMeta = requestModel.provider === META_PROVIDER_ID;
			const aliases =
				isMeta && isDirectMetaModelApiUrl(requestModel.baseUrl)
					? new MetaToolAliases()
					: undefined;
			const send = () =>
				streamSimple(requestModel, context, {
					...options,
					headers,
					onPayload: async (payload, sentModel) => {
						const replacement = await options?.onPayload?.(payload, sentModel);
						const body = replacement === undefined ? payload : replacement;
						const hinted = isMeta
							? (applyMetaResponsesCacheHints(body) ?? body)
							: body;
						return aliases ? aliases.rewritePayload(hinted) : hinted;
					},
				});
			return isMeta ? forwardMetaStream(send, requestModel, aliases) : send();
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
