import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHermeticTestEnvironment } from "../scripts/test.ts";

const launcher = fileURLToPath(new URL("../scripts/test.ts", import.meta.url));
const credentialKeys = [
	"PI_META_LIVE_API_KEY",
	"META_API_KEY",
	"MODEL_API_KEY",
	"META_MUSE_USER_AGENT",
];

async function runFixture(
	source: string,
	arguments_: string[] = [],
): Promise<{ exitCode: number; output: string; fixtureHome: string }> {
	const fixtureHome = await mkdtemp(join(tmpdir(), "pi-meta-runner-fixture-"));
	const fixture = join(fixtureHome, "fixture.test.ts");
	try {
		await writeFile(fixture, source);
		await writeFile(
			join(fixtureHome, ".env"),
			credentialKeys.map((key) => `${key}=from-dotenv`).join("\n"),
		);
		const authFile = join(fixtureHome, ".pi", "agent", "auth.json");
		await mkdir(dirname(authFile), { recursive: true });
		await writeFile(
			authFile,
			JSON.stringify({ meta: { access: "fixture-key" } }),
		);
		const child = Bun.spawn(
			[process.execPath, "--no-env-file", launcher, ...arguments_, fixture],
			{
				cwd: fixtureHome,
				env: {
					...process.env,
					HOME: fixtureHome,
					USERPROFILE: fixtureHome,
					...Object.fromEntries(
						credentialKeys.map((key) => [key, "fixture-key"]),
					),
				},
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const [exitCode, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		return { exitCode, output: stdout + stderr, fixtureHome };
	} finally {
		await rm(fixtureHome, { recursive: true, force: true });
	}
}

describe("hermetic test launcher", () => {
	test("removes credential aliases without mutating the inherited environment", () => {
		const inherited = {
			Path: "tool-path",
			HOME: "caller-home",
			UserProfile: "caller-profile",
			HOMEDRIVE: "C:",
			HOMEPATH: "caller-path",
			meta_api_key: "caller-key",
			MODEL_API_KEY: "caller-key",
			PI_META_LIVE_API_KEY: "caller-key",
			META_MUSE_USER_AGENT: "1",
		};
		const original = { ...inherited };
		expect(createHermeticTestEnvironment(inherited, "test-home")).toEqual({
			Path: "tool-path",
			HOME: "test-home",
			USERPROFILE: "test-home",
		});
		expect(inherited).toEqual(original);
	});

	test("isolates the child home, ignores dotenv, forwards test arguments, and cleans up", async () => {
		const result = await runFixture(
			`import { expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
test("selected", () => {
	for (const key of ${JSON.stringify(credentialKeys)}) expect(process.env[key]).toBeUndefined();
	expect(homedir()).toBe(process.env.HOME);
	expect(homedir()).toBe(process.env.USERPROFILE);
	expect(readdirSync(homedir())).toEqual([]);
	expect(existsSync(homedir() + "/.pi/agent/auth.json")).toBe(false);
	console.log("CHILD_HOME=" + JSON.stringify(homedir()));
});
test("excluded failure", () => { throw new Error("Argument filtering failed"); });`,
			["--test-name-pattern", "^selected$"],
		);
		expect(result.exitCode, result.output).toBe(0);
		const homeMatch = /CHILD_HOME=("[^\r\n]+")/.exec(result.output);
		expect(homeMatch, result.output).not.toBeNull();
		const childHome = JSON.parse(homeMatch?.[1] ?? "null") as string;
		expect(childHome).not.toBe(result.fixtureHome);
		expect(existsSync(childHome)).toBe(false);
	});

	test("propagates a failing child's exit code", async () => {
		const result = await runFixture(
			'import { test } from "bun:test"; test("failure", () => { throw new Error("Fixture failure"); });',
		);
		expect(result.exitCode).not.toBe(0);
		expect(result.output).toContain("Fixture failure");
	});

	test("keeps credential and profile discovery available only with explicit live mode", async () => {
		const result = await runFixture(
			`import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
test("live fixture", () => {
	for (const key of ${JSON.stringify(credentialKeys)}) expect(process.env[key]).toBe("fixture-key");
	expect(homedir()).toBe(process.env.USERPROFILE);
	expect(existsSync(homedir() + "/.pi/agent/auth.json")).toBe(true);
});`,
			["--live"],
		);
		expect(result.exitCode, result.output).toBe(0);
	});
});
