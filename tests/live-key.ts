import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Resolve the credential for the billable live probes: an explicit env key,
 * then an unexpired `meta.access` entry from the local `/login meta`. Every
 * live test must use this, so a plain `bun run test:live` exercises all of
 * them; a probe keyed on one env var alone silently skips.
 */
export function resolveLiveMetaApiKey(): string | undefined {
	for (const value of [
		process.env.PI_META_LIVE_API_KEY,
		process.env.META_API_KEY,
		process.env.MODEL_API_KEY,
	]) {
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	try {
		const auth = JSON.parse(
			readFileSync(join(homedir(), ".pi/agent/auth.json"), "utf8"),
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
