import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { piAgentDir, resolveLiveMetaApiKey } from "./live-key.ts";

const directories: string[] = [];

afterEach(async () => {
	for (const directory of directories.splice(0))
		await rm(directory, { recursive: true, force: true });
});

async function agentDirWithAuth(
	meta: Record<string, unknown>,
): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "pi-meta-live-key-"));
	directories.push(directory);
	await writeFile(join(directory, "auth.json"), JSON.stringify({ meta }));
	return directory;
}

describe("live-probe credential resolution", () => {
	test("resolves Pi's agent directory the way Pi does", () => {
		expect(piAgentDir({})).toBe(join(homedir(), ".pi", "agent"));
		expect(piAgentDir({ PI_CODING_AGENT_DIR: "" })).toBe(
			join(homedir(), ".pi", "agent"),
		);
		expect(piAgentDir({ PI_CODING_AGENT_DIR: "~" })).toBe(homedir());
		expect(piAgentDir({ PI_CODING_AGENT_DIR: "~/custom/agent" })).toBe(
			join(homedir(), "custom", "agent"),
		);
		const absolute = join(tmpdir(), "agent");
		expect(piAgentDir({ PI_CODING_AGENT_DIR: absolute })).toBe(absolute);
		expect(
			piAgentDir({ PI_CODING_AGENT_DIR: pathToFileURL(absolute).href }),
		).toBe(absolute);
	});

	test("reads the minted key from PI_CODING_AGENT_DIR", async () => {
		const directory = await agentDirWithAuth({
			access: " agent-dir-key ",
			expires: Date.now() + 60_000,
		});
		expect(resolveLiveMetaApiKey({ PI_CODING_AGENT_DIR: directory })).toBe(
			"agent-dir-key",
		);
	});

	test("prefers an env key and ignores an expired minted key", async () => {
		const live = await agentDirWithAuth({ access: "minted-key" });
		expect(
			resolveLiveMetaApiKey({
				PI_CODING_AGENT_DIR: live,
				META_API_KEY: " env-key ",
			}),
		).toBe("env-key");

		const expired = await agentDirWithAuth({
			access: "expired-key",
			expires: Date.now() - 1,
		});
		expect(
			resolveLiveMetaApiKey({ PI_CODING_AGENT_DIR: expired }),
		).toBeUndefined();
	});
});
