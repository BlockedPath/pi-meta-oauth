/// <reference types="bun-types" />
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import {
	mediaMaxOutputTokens,
	prepareMediaOutput,
	responseHitOutputLimit,
} from "../extensions/media-output.ts";

const createdPaths: string[] = [];

afterEach(() => {
	for (const path of createdPaths.splice(0)) rmSync(path, { force: true });
});

describe("Meta media output continuation", () => {
	test("returns short output inline without creating a continuation file", async () => {
		const result = await prepareMediaOutput({ text: "short answer", identity: "short" });
		expect(result.text).toBe("short answer");
		expect(result.details).toMatchObject({ truncated: false, incomplete: false });
		expect(result.details.path).toBeUndefined();
	});

	test("saves long output and gives a read offset/limit continuation", async () => {
		const fullText = Array.from({ length: 120 }, (_, index) => `line ${index + 1}: ${"x".repeat(40)}`).join("\n");
		const result = await prepareMediaOutput({ text: fullText, identity: "long", maxChars: 1_000 });
		const path = result.details.path;
		expect(result.details.truncated).toBe(true);
		expect(result.text).toContain("Use the read tool with offset/limit");
		expect(result.text).toContain("offset is a 1-based line number");
		expect(path && existsSync(path)).toBe(true);
		if (path) {
			createdPaths.push(path);
			expect(readFileSync(path, "utf8")).toBe(fullText);
		}
	});

	test("warns when Muse exhausts its generation budget", async () => {
		expect(responseHitOutputLimit({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" } })).toBe(true);
		const result = await prepareMediaOutput({
			text: "partial",
			identity: "incomplete",
			response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } },
		});
		expect(result.details.incomplete).toBe(true);
		expect(result.text).toContain("analysis may be incomplete");
	});

	test("normalizes generation budgets to the supported range", () => {
		expect(mediaMaxOutputTokens(undefined)).toBe(8_000);
		expect(mediaMaxOutputTokens(100)).toBe(4_000);
		expect(mediaMaxOutputTokens(99_999)).toBe(32_000);
	});
});
