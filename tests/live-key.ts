import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Pi's agent directory: `PI_CODING_AGENT_DIR`, expanded the way Pi expands it
 * (`~`, `~/…`, and `file://` URLs), else `~/.pi/agent`.
 */
export function piAgentDir(env: NodeJS.ProcessEnv = process.env): string {
	const configured = env.PI_CODING_AGENT_DIR;
	if (!configured) return join(homedir(), ".pi", "agent");
	if (configured === "~") return homedir();
	if (
		configured.startsWith("~/") ||
		(process.platform === "win32" && configured.startsWith("~\\"))
	) {
		return join(homedir(), configured.slice(2));
	}
	if (configured.startsWith("file://")) return fileURLToPath(configured);
	return configured;
}

/**
 * The live-probe gate. `bun run test:live` sets it to `1` and the hermetic runner
 * strips it; a run that merely inherits it is live too, so never export it.
 */
export const LIVE_PROBES_ENV_VAR = "PI_META_LIVE";

/**
 * Resolve the credential for the billable live probes: an explicit env key,
 * then an unexpired `meta.access` entry from the local `/login meta`. Every
 * live test must use this, so a plain `bun run test:live` exercises all of
 * them; a probe keyed on one env var alone silently skips. Nothing resolves
 * unless the launcher turned the probes on, so a direct `bun test` on a
 * logged-in machine stays free.
 */
export function resolveLiveMetaApiKey(
	env: NodeJS.ProcessEnv = process.env,
): string | undefined {
	if (env[LIVE_PROBES_ENV_VAR] !== "1") return undefined;
	for (const value of [
		env.PI_META_LIVE_API_KEY,
		env.META_API_KEY,
		env.MODEL_API_KEY,
	]) {
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	try {
		const auth = JSON.parse(
			readFileSync(join(piAgentDir(env), "auth.json"), "utf8"),
		) as { meta?: { access?: unknown; expires?: unknown } };
		// auth.meta.expires is epoch milliseconds; an expired token must not turn
		// every test run into a hard 401 — treat it as no credential.
		if (
			typeof auth.meta?.expires === "number" &&
			auth.meta.expires <= Date.now()
		) {
			return undefined;
		}
		return typeof auth.meta?.access === "string" && auth.meta.access.trim()
			? auth.meta.access.trim()
			: undefined;
	} catch {
		return undefined;
	}
}
