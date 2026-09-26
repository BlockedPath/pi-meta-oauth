import { MUSE_USER_AGENT_ENV_VAR } from "../extensions/meta.ts";

/**
 * Run `fn` with META_MUSE_USER_AGENT set to `value` (or unset for
 * undefined), restoring the caller's environment afterwards so tests stay
 * hermetic even when a developer has the opt-in exported.
 */
export async function withMuseUserAgent<T>(
	value: string | undefined,
	fn: () => T | Promise<T>,
): Promise<T> {
	const previous = process.env[MUSE_USER_AGENT_ENV_VAR];
	if (value === undefined) delete process.env[MUSE_USER_AGENT_ENV_VAR];
	else process.env[MUSE_USER_AGENT_ENV_VAR] = value;
	try {
		return await fn();
	} finally {
		if (previous === undefined) delete process.env[MUSE_USER_AGENT_ENV_VAR];
		else process.env[MUSE_USER_AGENT_ENV_VAR] = previous;
	}
}
