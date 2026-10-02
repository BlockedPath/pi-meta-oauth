import { META_ENV_VAR, MODEL_API_ENV_VAR } from "./constants.ts";
import type { MetaEnv } from "./types.ts";

/** Pi interpolates $META_API_KEY; Muse tooling may use MODEL_API_KEY. */
export function synchronizeMetaApiKeyAliases(env: MetaEnv): void {
	if (env[META_ENV_VAR] === undefined && env[MODEL_API_ENV_VAR] !== undefined) {
		env[META_ENV_VAR] = env[MODEL_API_ENV_VAR];
	}
	if (env[MODEL_API_ENV_VAR] === undefined && env[META_ENV_VAR] !== undefined) {
		env[MODEL_API_ENV_VAR] = env[META_ENV_VAR];
	}
}
