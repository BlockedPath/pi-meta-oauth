import { createHash, randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const DEFAULT_MEDIA_MAX_CHARS = 20_000;
export const MAX_MEDIA_MAX_CHARS = 50_000;
export const DEFAULT_MEDIA_MAX_OUTPUT_TOKENS = 8_000;
export const MIN_MEDIA_MAX_OUTPUT_TOKENS = 4_000;
export const MAX_MEDIA_MAX_OUTPUT_TOKENS = 32_000;
const MAX_INLINE_BYTES = 50 * 1024;
const MAX_INLINE_LINES = 2_000;

export interface MediaOutputDetails {
	path?: string;
	chars: number;
	lines: number;
	truncated: boolean;
	incomplete: boolean;
}

function clampInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
	if (value === undefined) return fallback;
	return Math.max(minimum, Math.min(maximum, Math.trunc(value)));
}

export function mediaMaxChars(value: number | undefined): number {
	return clampInteger(value, DEFAULT_MEDIA_MAX_CHARS, 1_000, MAX_MEDIA_MAX_CHARS);
}

export function mediaMaxOutputTokens(value: number | undefined): number {
	return clampInteger(
		value,
		DEFAULT_MEDIA_MAX_OUTPUT_TOKENS,
		MIN_MEDIA_MAX_OUTPUT_TOKENS,
		MAX_MEDIA_MAX_OUTPUT_TOKENS,
	);
}

function inlineSlice(text: string, maxChars: number): string {
	let slice = text.split("\n").slice(0, MAX_INLINE_LINES).join("\n").slice(0, maxChars);
	if (Buffer.byteLength(slice, "utf8") <= MAX_INLINE_BYTES) return slice;
	const bytes = Buffer.from(slice, "utf8").subarray(0, MAX_INLINE_BYTES);
	slice = new TextDecoder().decode(bytes);
	return slice.endsWith("\uFFFD") ? slice.slice(0, -1) : slice;
}

function responseReason(response: unknown): string | undefined {
	if (!response || typeof response !== "object") return undefined;
	const record = response as Record<string, unknown>;
	const details = record.incomplete_details;
	if (details && typeof details === "object") {
		const reason = (details as Record<string, unknown>).reason;
		if (typeof reason === "string") return reason;
	}
	for (const key of ["finish_reason", "stop_reason"]) {
		if (typeof record[key] === "string") return record[key] as string;
	}
	return record.status === "incomplete" ? "incomplete" : undefined;
}

export function responseHitOutputLimit(response: unknown): boolean {
	const reason = responseReason(response)?.toLowerCase();
	return reason === "max_output_tokens" || reason === "length" || reason === "max_tokens";
}

function outputFilePath(identity: string, text: string): string {
	const hash = createHash("sha256").update(`${identity}\0${text.length}\0${text.slice(0, 1024)}`).digest("hex").slice(0, 16);
	return join(tmpdir(), `pi-meta-media-${hash}.txt`);
}

async function saveFullOutput(identity: string, text: string): Promise<string | undefined> {
	const basePath = outputFilePath(identity, text);
	try {
		await mkdir(tmpdir(), { recursive: true });
		try {
			await writeFile(basePath, text, { encoding: "utf8", flag: "wx", mode: 0o600 });
			return basePath;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			const uniquePath = `${basePath}.${randomBytes(4).toString("hex")}`;
			await writeFile(uniquePath, text, { encoding: "utf8", flag: "wx", mode: 0o600 });
			return uniquePath;
		}
	} catch {
		return undefined;
	}
}

export async function prepareMediaOutput(options: {
	text: string;
	identity: string;
	maxChars?: number;
	response?: unknown;
}): Promise<{ text: string; details: MediaOutputDetails }> {
	const { text, identity, response } = options;
	const slice = inlineSlice(text, mediaMaxChars(options.maxChars));
	const truncated = slice.length < text.length;
	const lines = text.length === 0 ? 0 : text.split("\n").length;
	const incomplete = responseHitOutputLimit(response);
	const savedPath = truncated ? await saveFullOutput(identity, text) : undefined;
	const notes: string[] = [];
	if (truncated) {
		notes.push(
			savedPath
				? `content truncated at ${slice.length} of ${text.length} characters; full content saved to: ${savedPath} (${lines} lines). Use the read tool with offset/limit to continue (offset is a 1-based line number).`
				: `content truncated at ${slice.length} of ${text.length} characters; the full content could not be saved, so continuation is unavailable.`,
		);
	}
	if (incomplete) {
		notes.push("Muse exhausted max_output_tokens, so the analysis may be incomplete. Retry with a larger budget or a narrower prompt.");
	}
	return {
		text: `${slice}${notes.length > 0 ? `\n\n[${notes.join(" ")}]` : ""}`,
		details: {
			...(savedPath ? { path: savedPath } : {}),
			chars: text.length,
			lines,
			truncated,
			incomplete,
		},
	};
}
