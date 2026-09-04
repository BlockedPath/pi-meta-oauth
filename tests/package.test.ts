/// <reference types="bun-types" />
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("OAuth-only package", () => {
	test("registers and ships only the Meta OAuth provider extension", () => {
		const manifest = JSON.parse(
			readFileSync(join(projectRoot, "package.json"), "utf8"),
		) as {
			pi?: { extensions?: string[] };
			peerDependencies?: Record<string, string>;
		};

		expect(manifest.pi?.extensions).toEqual(["./extensions/meta.ts"]);
		expect(readdirSync(join(projectRoot, "extensions")).sort()).toEqual([
			"meta.ts",
		]);
		expect(manifest.peerDependencies).not.toHaveProperty(
			"@earendil-works/pi-tui",
		);
		expect(manifest.peerDependencies).not.toHaveProperty("typebox");
	});
});
