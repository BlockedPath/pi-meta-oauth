/// <reference types="bun-types" />
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	asrEndpoint,
	formatAuthorization,
	pcmAudioLevel,
} from "../extensions/voice.ts";

describe("Meta voice mode", () => {
	test("maps silent and audible PCM into meter levels", () => {
		const silent = Buffer.alloc(3_200);
		const audible = Buffer.alloc(3_200);
		for (let offset = 0; offset < audible.length; offset += 2) {
			audible.writeInt16LE(offset % 4 === 0 ? 8_000 : -8_000, offset);
		}

		expect(pcmAudioLevel(silent)).toBe(0);
		expect(pcmAudioLevel(audible)).toBeGreaterThan(0.5);
		expect(pcmAudioLevel(audible)).toBeLessThanOrEqual(1);
	});

	test("formats the Meta ASR authorization value exactly once", () => {
		expect(formatAuthorization("LLM|example")).toBe("OAuth LLM|example");
		expect(formatAuthorization("OAuth LLM|example")).toBe("OAuth LLM|example");
	});

	test("builds a secure ASR URL with a session id", () => {
		let url: URL;
		try {
			url = new URL(asrEndpoint("session-123"));
		} catch (error) {
			throw new Error("ASR endpoint was not a valid URL", { cause: error });
		}
		expect(url.protocol).toBe("wss:");
		expect(url.hostname).toBe("shortwave.facebook.com");
		expect(url.searchParams.get("sessionId")).toBe("session-123");
	});

	test("ships the macOS helper resources", () => {
		const root = join(
			dirname(fileURLToPath(import.meta.url)),
			"../extensions/voice",
		);
		for (const file of [
			"macos-audio.swift",
			"Info.plist",
			"Entitlements.plist",
		]) {
			expect(existsSync(join(root, file))).toBe(true);
		}
	});

	test("ships the Windows helper resources", () => {
		const root = join(
			dirname(fileURLToPath(import.meta.url)),
			"../extensions/voice",
		);
		for (const file of ["windows-audio.cs", "windows-audio.ps1"]) {
			expect(existsSync(join(root, file))).toBe(true);
		}
	});
});
