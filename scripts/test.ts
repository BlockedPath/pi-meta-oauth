import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Set only by `--live`; the billable probes stay skipped without it. */
const LIVE_PROBES_KEY = "PI_META_LIVE";

/** Flags that change request wire shapes, so a developer export must not reach tests. */
const BEHAVIOUR_KEYS = new Set(["META_MUSE_USER_AGENT", "META_TOOL_ALIASES"]);

const ISOLATED_ENVIRONMENT_KEYS = new Set([
	"HOME",
	"USERPROFILE",
	"HOMEDRIVE",
	"HOMEPATH",
	// Pi's agent directory holds auth.json, so it can resolve a live credential.
	"PI_CODING_AGENT_DIR",
	"PI_META_LIVE_API_KEY",
	"META_API_KEY",
	"MODEL_API_KEY",
	LIVE_PROBES_KEY,
	...BEHAVIOUR_KEYS,
]);

/** Build a child-only environment without credentials or the caller's Pi home. */
export function createHermeticTestEnvironment(
	environment: NodeJS.ProcessEnv,
	testHome: string,
): NodeJS.ProcessEnv {
	const isolated: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(environment)) {
		// Windows environment names are case-insensitive. Canonicalize our keys
		// before replacing them to avoid leaving a lower-case credential alias.
		if (!ISOLATED_ENVIRONMENT_KEYS.has(key.toUpperCase())) {
			isolated[key] = value;
		}
	}
	isolated.HOME = testHome;
	isolated.USERPROFILE = testHome;
	return isolated;
}

/**
 * Keep the caller's credentials and Pi home for the live probes, and turn the
 * probes on. Behaviour flags are blanked rather than removed: live mode loads
 * dotenv files, which would otherwise supply a removed name again.
 */
export function createLiveTestEnvironment(
	environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
	const live: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(environment)) {
		const name = key.toUpperCase();
		if (!BEHAVIOUR_KEYS.has(name) && name !== LIVE_PROBES_KEY) {
			live[key] = value;
		}
	}
	for (const key of BEHAVIOUR_KEYS) live[key] = "";
	live[LIVE_PROBES_KEY] = "1";
	return live;
}

export async function runTests(arguments_: readonly string[]): Promise<number> {
	const live = arguments_[0] === "--live";
	const testArguments = live ? arguments_.slice(1) : arguments_;
	const testHome = live
		? undefined
		: await mkdtemp(join(tmpdir(), "pi-meta-tests-"));
	try {
		const child = Bun.spawn(
			[
				process.execPath,
				"test",
				...(live ? [] : ["--no-env-file"]),
				...testArguments,
			],
			{
				env: testHome
					? createHermeticTestEnvironment(process.env, testHome)
					: createLiveTestEnvironment(process.env),
				stdin: "inherit",
				stdout: "inherit",
				stderr: "inherit",
			},
		);
		return await child.exited;
	} finally {
		if (testHome) await rm(testHome, { recursive: true, force: true });
	}
}

if (import.meta.main) {
	process.exitCode = await runTests(process.argv.slice(2));
}
