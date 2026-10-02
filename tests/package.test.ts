/// <reference types="bun-types" />
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

interface PackageManifest {
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
});
