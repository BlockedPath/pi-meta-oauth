import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ISOLATED_ENVIRONMENT_KEYS = new Set([
	"HOME",
	"USERPROFILE",
	"HOMEDRIVE",
	"HOMEPATH",
	"PI_META_LIVE_API_KEY",
	"META_API_KEY",
	"MODEL_API_KEY",
	"META_MUSE_USER_AGENT",
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
					: process.env,
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
