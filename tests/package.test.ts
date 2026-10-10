/// <reference types="bun-types" />
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

interface PackageManifest {
	name: string;
	files: string[];
	pi?: { extensions?: string[] };
	dependencies?: Record<string, string>;
	peerDependencies?: Record<string, string>;
}

function readManifest(): PackageManifest {
	return JSON.parse(
		readFileSync(join(projectRoot, "package.json"), "utf8"),
	) as PackageManifest;
}

function publishedFiles(manifest: PackageManifest): Set<string> {
	return new Set(
		manifest.files.flatMap((entry) => {
			const selector = statSync(join(projectRoot, entry)).isDirectory()
				? `${entry.replace(/\/$/, "")}/**/*`
				: entry;
			return [...new Bun.Glob(selector).scanSync({ cwd: projectRoot })].map(
				(file) => file.replaceAll("\\", "/"),
			);
		}),
	);
}

describe("OAuth-only package", () => {
	test("loads an installed extension through Pi's Node CLI without local peer packages", async () => {
		const directory = await mkdtemp(join(tmpdir(), "meta-loader-"));
		try {
			const installed = join(directory, "node_modules", "pi-meta-oauth");
			await mkdir(installed, { recursive: true });
			for (const entry of ["package.json", ...readManifest().files]) {
				await cp(join(projectRoot, entry), join(installed, entry), {
					recursive: true,
				});
			}
			const agentRoot = resolve(
				dirname(
					fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")),
				),
				"..",
			);
			const agentPackage = JSON.parse(
				readFileSync(join(agentRoot, "package.json"), "utf8"),
			) as { bin: { pi: string } };
			const child = Bun.spawn(
				[
					"node",
					join(agentRoot, agentPackage.bin.pi),
					"--offline",
					"--no-session",
					"--no-extensions",
					"--extension",
					join(installed, "extensions/meta.ts"),
					"--mode",
					"rpc",
					"--provider",
					"meta",
					"--model",
					"muse-spark-1.3-contributor",
				],
				{
					cwd: directory,
					env: {
						...process.env,
						HOME: directory,
						USERPROFILE: directory,
						PI_CODING_AGENT_DIR: join(directory, "agent"),
						META_API_KEY: "test-key",
					},
					stdin: new Blob(['{"id":"state","type":"get_state"}\n']),
					stdout: "pipe",
					stderr: "pipe",
				},
			);
			const [stdout, stderr, exitCode] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited,
			]);
			expect(exitCode, stderr).toBe(0);
			expect(stderr).not.toContain("Failed to load extension");
			const responses = stdout
				.trim()
				.split("\n")
				.map(
					(line) =>
						JSON.parse(line) as {
							id?: string;
							success?: boolean;
							data?: { model?: { id?: string } };
						},
				);
			expect(
				responses.find((response) => response.id === "state"),
			).toMatchObject({
				success: true,
				data: { model: { id: "muse-spark-1.3-contributor" } },
			});
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	}, 30_000);

	test("registers and ships only the Meta OAuth provider extension", () => {
		const manifest = readManifest();

		expect(manifest.pi?.extensions).toEqual(["./extensions/meta.ts"]);
		expect(readdirSync(join(projectRoot, "extensions")).sort()).toEqual([
			"meta.ts",
		]);
		expect(manifest.peerDependencies).not.toHaveProperty(
			"@earendil-works/pi-tui",
		);
		expect(manifest.peerDependencies).not.toHaveProperty("typebox");
	});

	test("publishes provider source and documentation without test or platform assets", () => {
		const files = publishedFiles(readManifest());
		expect(files.has("extensions/meta.ts")).toBe(true);
		expect([...files].some((file) => file.startsWith("src/meta/"))).toBe(true);
		for (const file of files) {
			expect(
				file === "extensions/meta.ts" ||
					/^src\/meta\/[^/]+(?<!\.test)\.ts$/.test(file) ||
					/^[^/]+\.md$/.test(file) ||
					file === "LICENSE",
				`Unexpected published file: ${file}`,
			).toBe(true);
		}
	});

	test("includes the full runtime import graph and only necessary dependencies", () => {
		const manifest = readManifest();
		const files = publishedFiles(manifest);
		const transpiler = new Bun.Transpiler({ loader: "ts" });
		const visited = new Set<string>();
		const runtimeDependencies = new Set<string>();
		const pending = [resolve(projectRoot, "extensions/meta.ts")];
		for (const module of pending) {
			if (visited.has(module)) continue;
			visited.add(module);
			const file = relative(projectRoot, module).replaceAll("\\", "/");
			expect(files.has(file), `Unpublished runtime module: ${file}`).toBe(true);
			for (const imported of transpiler.scanImports(readFileSync(module))) {
				if (imported.path.startsWith(".")) {
					pending.push(resolve(dirname(module), imported.path));
				} else if (!imported.path.startsWith("node:")) {
					const packageName = imported.path.startsWith("@")
						? imported.path.split("/").slice(0, 2).join("/")
						: imported.path.split("/")[0];
					if (packageName && !manifest.peerDependencies?.[packageName]) {
						runtimeDependencies.add(packageName);
					}
				}
			}
		}
		expect(Object.keys(manifest.dependencies ?? {}).sort()).toEqual(
			[...runtimeDependencies].sort(),
		);
	});

	test("README install commands track the published package and main", () => {
		const readme = readFileSync(join(projectRoot, "README.md"), "utf8");
		const gitSources = [
			...readme.matchAll(
				/^\s*pi install (git:github\.com\/BlockedPath\/pi-meta-oauth\S*)/gm,
			),
		].map((match) => match[1]);
		expect(gitSources.length).toBeGreaterThan(0);
		for (const source of gitSources) {
			expect(source, `Pinned git install source: ${source}`).not.toMatch(
				/[@#]/,
			);
		}
		const npmSources = [...readme.matchAll(/^\s*pi install npm:(\S+)/gm)].map(
			(match) => match[1],
		);
		expect(npmSources).toEqual([readManifest().name]);
	});
});
