import type { ProviderConfig } from "@earendil-works/pi-coding-agent";

type ProviderModel = NonNullable<ProviderConfig["models"]>[number];

/** Responses hints spanning the supported Pi versions, including newer flags. */
export interface MetaResponsesCompat {
	supportsReasoningEffort?: boolean;
	supportsToolSearch?: boolean;
	supportsDeveloperRole?: boolean;
	supportsMidConvoSystemMessages?: boolean;
	supportsLongCacheRetention?: boolean;
	supportsStrictMode?: boolean;
	supportsOpenAIGrammarTools?: boolean;
	supportsAdditionalTools?: boolean;
	supportsExplicitPromptCacheMode?: boolean;
	supportsMaxOutputTokens?: boolean;
	sessionAffinityFormat?: "openai" | "openai-nosession" | "openrouter";
}

/** This provider never registers metadata for another transport API. */
export type MetaProviderModel = Omit<ProviderModel, "api" | "compat"> & {
	api?: "openai-responses";
	compat?: MetaResponsesCompat;
};
export type MetaProviderConfig = Omit<ProviderConfig, "models"> & {
	models: MetaProviderModel[];
};
export type MetaEnv = Record<string, string | undefined>;
/** Depend on fetch's callable contract, without runtime-specific static helpers. */
export type Fetch = (
	...args: Parameters<typeof globalThis.fetch>
) => ReturnType<typeof globalThis.fetch>;
export type Sleep = (milliseconds: number) => Promise<void>;
