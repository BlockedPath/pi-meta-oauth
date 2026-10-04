import { META_ENV_VAR, MODEL_API_ENV_VAR } from "./constants.ts";
import type { MetaEnv } from "./types.ts";

/** Pi treats an empty $META_API_KEY as unset, and a blank one is never a usable key. */
function isMissing(value: string | undefined): boolean {
	return !value?.trim();
}

/** Pi interpolates $META_API_KEY; Muse tooling may use MODEL_API_KEY. */
export function synchronizeMetaApiKeyAliases(env: MetaEnv): void {
	if (isMissing(env[META_ENV_VAR]) && !isMissing(env[MODEL_API_ENV_VAR])) {
		env[META_ENV_VAR] = env[MODEL_API_ENV_VAR];
	}
	if (isMissing(env[MODEL_API_ENV_VAR]) && !isMissing(env[META_ENV_VAR])) {
		env[MODEL_API_ENV_VAR] = env[META_ENV_VAR];
	}
}
