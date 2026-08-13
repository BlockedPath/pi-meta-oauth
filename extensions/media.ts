import type { Usage } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	createMetaProviderConfig,
	META_FILES_URL,
	META_API_BASE_URL,
	META_PROVIDER_ID,
} from "./meta.ts";
import { existsSync, statSync, readFileSync } from "node:fs";
import { basename, extname, resolve } from "node:path";
import { readFile } from "node:fs/promises";
import {
	DEFAULT_MEDIA_MAX_CHARS,
	DEFAULT_MEDIA_MAX_OUTPUT_TOKENS,
	MAX_MEDIA_MAX_CHARS,
	MAX_MEDIA_MAX_OUTPUT_TOKENS,
	MIN_MEDIA_MAX_OUTPUT_TOKENS,
	mediaMaxOutputTokens,
	prepareMediaOutput,
} from "./media-output.ts";

// ---------------------------------------------------------------------------
// Meta Files API + Responses API
// Docs: https://dev.meta.ai/docs/file-handling , /video-understanding
// - Inline file_data / file_url / video_url / input_audio : 50 MB limit
// - Files API POST /v1/files purpose=user_data : 1 GiB, 100 GiB/team storage, no expiry by default
// - Uploaded media uses input_file {file_id}; inline/public video uses
//   input_video {video_url}; inline audio uses input_audio {data,format}.
// - Video: video/mp4 only, reads frames + embedded audio together
// - Audio: audio/mpeg (.mp3), audio/wav (.wav)
// - Image: image/png, image/jpeg, image/gif, image/webp, image/x-icon, up to 50/request
// - PDF: application/pdf -> text first 100p + images first 50p (counts to 50-image budget)
// ---------------------------------------------------------------------------

const INLINE_LIMIT_BYTES = 50_000_000;
const FILES_API_LIMIT_BYTES = 1_073_741_824;
// Meta Responses `store=true` (default) has ~20 MB persistence limit even when
// inline limit is 50 MB — a 24 MB base64 payload triggers HTTP 413
// "payload_too_large … with `store=true`". Keep inline only for small files
// and force Files API or `store:false` above this threshold.
const STORE_SAFE_INLINE_BYTES = 15_000_000;
const AUTOMATIC_UPLOAD_EXPIRY_SECONDS = 24 * 60 * 60;
const EXPLICIT_UPLOAD_EXPIRY_SECONDS = 7 * 24 * 60 * 60;
const MIN_UPLOAD_EXPIRY_SECONDS = 3_600;
const MAX_UPLOAD_EXPIRY_SECONDS = 2_592_000;
const MAX_ANALYSIS_SOURCES = 50;

type SupportedMime =
	| "video/mp4"
	| "audio/mpeg"
	| "audio/wav"
	| "application/pdf"
	| "image/png"
	| "image/jpeg"
	| "image/gif"
	| "image/webp"
	| "image/x-icon"
	| "text/plain"
	| "application/json"
	| "application/jsonl";

const EXT_TO_MIME: Record<string, SupportedMime> = {
	".mp4": "video/mp4",
	".m4v": "video/mp4",
	".mp3": "audio/mpeg",
	".wav": "audio/wav",
	".pdf": "application/pdf",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".ico": "image/x-icon",
	".txt": "text/plain",
	".json": "application/json",
	".jsonl": "application/jsonl",
};

function mimeForPath(path: string): SupportedMime | undefined {
	const ext = extname(path).toLowerCase();
	return EXT_TO_MIME[ext];
}

function mimeForDataUrl(dataUrl: string): string | undefined {
	const m = dataUrl.match(/^data:([^;,\s]+)[;,]/);
	return m?.[1]?.toLowerCase();
}

function isVideoMime(m: string | undefined): boolean {
	return m === "video/mp4";
}
function isAudioMime(m: string | undefined): boolean {
	return (
		m === "audio/mpeg" ||
		m === "audio/mp3" ||
		m === "audio/wav" ||
		m === "audio/x-wav"
	);
}
function isPdfMime(m: string | undefined): boolean {
	return m === "application/pdf";
}
function isImageMime(m: string | undefined): boolean {
	return !!m && m.startsWith("image/");
}

function filenameForMime(
	mime: string | undefined,
	fallback = "file.bin",
): string {
	switch (mime) {
		case "video/mp4":
			return "video.mp4";
		case "audio/mpeg":
		case "audio/mp3":
			return "audio.mp3";
		case "audio/wav":
		case "audio/x-wav":
			return "audio.wav";
		case "application/pdf":
			return "document.pdf";
		default:
			return fallback;
	}
}

function audioFormatForMime(mime: string | undefined): "wav" | "mp3" {
	return mime === "audio/wav" || mime === "audio/x-wav" ? "wav" : "mp3";
}

/** Build a generic Meta Responses input_file block. */
function inputFileFromSource(
	source: string,
	filename?: string,
): ResponsesContentBlock {
	if (source.startsWith("https://")) {
		return { type: "input_file", file_url: source };
	}
	if (source.startsWith("data:")) {
		const mime = mimeForDataUrl(source);
		return {
			type: "input_file",
			file_data: source,
			filename: filename ?? filenameForMime(mime),
		};
	}
	// Bare file_id (file-...)
	return { type: "input_file", file_id: source };
}

function mimeForSource(source: string): string | undefined {
	if (source.startsWith("data:")) return mimeForDataUrl(source);
	if (source.startsWith("https://")) {
		try {
			return mimeForPath(new URL(source).pathname);
		} catch {
			return undefined;
		}
	}
	return mimeForPath(source);
}

/** Build the typed content block required by Meta for each media kind. */
export function mediaInputFromSource(
	source: string,
	filename?: string,
	expectedMime?: string,
): ResponsesContentBlock {
	if (!source.startsWith("data:") && !source.startsWith("https://")) {
		return { type: "input_file", file_id: source };
	}
	const mime = expectedMime ?? mimeForSource(source);
	if (isVideoMime(mime)) {
		return { type: "input_video", video_url: source };
	}
	if (isAudioMime(mime) && source.startsWith("data:")) {
		return {
			type: "input_audio",
			input_audio: {
				data: base64FromDataUrl(source),
				format: audioFormatForMime(mime),
			},
		};
	}
	return inputFileFromSource(source, filename);
}

function base64FromDataUrl(dataUrl: string): string {
	const comma = dataUrl.indexOf(",");
	return comma === -1 ? "" : dataUrl.slice(comma + 1);
}

function base64ByteLength(base64: string): number {
	const normalized = base64.replace(/\s/g, "");
	if (!normalized) return 0;
	const padding = normalized.endsWith("==")
		? 2
		: normalized.endsWith("=")
			? 1
			: 0;
	return Math.max(0, Math.floor((normalized.length * 3) / 4) - padding);
}

function safeNotify(
	ctx:
		| ExtensionContext
		| { ui: { notify: (msg: string, level?: string) => void } },
	message: string,
	level: "info" | "warning" | "error" = "info",
): void {
	try {
		ctx.ui.notify(message, level as never);
	} catch (error) {
		const msg = String(error);
		if (
			msg.includes("stale after session replacement") ||
			msg.includes("Extension ctx is stale")
		)
			return;
		throw error;
	}
}

async function safeGetMetaApiKey(ctx: ExtensionContext): Promise<string> {
	try {
		return await getMetaApiKey(ctx);
	} catch (error) {
		if (String(error).includes("stale after session replacement"))
			throw new Error("Session was replaced — please retry the command");
		throw error;
	}
}

async function getMetaApiKey(ctx: ExtensionContext): Promise<string> {
	const key = await ctx.modelRegistry.getApiKeyForProvider(META_PROVIDER_ID);
	if (!key)
		throw new Error(
			`Meta credentials unavailable — run /login ${META_PROVIDER_ID}`,
		);
	return key;
}

async function getMetaApiKeyFromRegistry(
	_api: ExtensionAPI,
): Promise<string | undefined> {
	// For tools that receive ExtensionContext we prefer ctx.modelRegistry; this is fallback for non-context paths.
	return undefined;
}

interface UploadResult {
	id: string;
	filename: string;
	bytes: number;
	purpose: string;
	status: string;
	expires_at?: number;
}

async function uploadMetaFile(
	apiKey: string,
	filePath: string,
	expiresAfter?: { anchor: "created_at"; seconds: number },
): Promise<UploadResult> {
	const data = await readFile(filePath);
	if (data.byteLength > FILES_API_LIMIT_BYTES) {
		throw new Error(
			`File too large for Files API (${data.byteLength} bytes > 1 GiB)`,
		);
	}
	const mime = mimeForPath(filePath) ?? "application/octet-stream";
	const blob = new Blob([data], { type: mime });
	const form = new FormData();
	// OpenAI SDK uses `file` field name; Meta docs show same.
	form.append("file", blob, basename(filePath));
	form.append("purpose", "user_data");
	if (expiresAfter) {
		form.append("expires_after[anchor]", expiresAfter.anchor);
		form.append("expires_after[seconds]", String(expiresAfter.seconds));
	}
	const res = await fetch(META_FILES_URL, {
		method: "POST",
		headers: { Authorization: `Bearer ${apiKey}` },
		body: form,
	});
	const bodyText = await res.text();
	let body: Record<string, unknown> = {};
	try {
		body = bodyText ? (JSON.parse(bodyText) as Record<string, unknown>) : {};
	} catch (error) {
		// Non-JSON body — keep empty and use raw text for error detail
		void error;
	}
	if (!res.ok) {
		const detail =
			typeof body.error === "string"
				? body.error
				: typeof (body as { message?: unknown }).message === "string"
					? (body as { message?: string }).message
					: typeof (body as { error_description?: unknown })
								.error_description === "string"
						? (body as { error_description?: string }).error_description
						: bodyText.slice(0, 500);
		if (
			res.status === 400 &&
			typeof detail === "string" &&
			detail.includes("storage")
		) {
			throw new Error(
				`Meta Files storage limit reached (100 GiB/team). Delete old files via DELETE /v1/files/{id}. Detail: ${detail}`,
			);
		}
		throw new Error(
			`Meta Files upload failed (HTTP ${res.status}): ${detail || res.statusText}`,
		);
	}
	const id =
		typeof body.id === "string"
			? body.id
			: typeof (body as { file_id?: unknown }).file_id === "string"
				? (body as { file_id: string }).file_id
				: undefined;
	if (!id)
		throw new Error(
			`Meta Files upload returned no id: ${bodyText.slice(0, 500)}`,
		);
	return {
		id,
		filename: (typeof body.filename === "string"
			? body.filename
			: basename(filePath)) as string,
		bytes: typeof body.bytes === "number" ? body.bytes : data.byteLength,
		purpose: typeof body.purpose === "string" ? body.purpose : "user_data",
		status: typeof body.status === "string" ? body.status : "uploaded",
		expires_at:
			typeof body.expires_at === "number" ? body.expires_at : undefined,
	};
}

const ALLOWED_PURPOSES = ["user_data", "batch"] as const;

async function listMetaFiles(
	apiKey: string,
	purpose = "user_data",
): Promise<unknown> {
	if (!(ALLOWED_PURPOSES as readonly string[]).includes(purpose)) {
		throw new Error(`Invalid purpose: ${purpose}`);
	}
	const options = { headers: { Authorization: `Bearer ${apiKey}` } };
	const res =
		purpose === "batch"
			? await fetch("https://api.meta.ai/v1/files?purpose=batch", options)
			: await fetch("https://api.meta.ai/v1/files?purpose=user_data", options);
	const text = await res.text();
	if (!res.ok)
		throw new Error(
			`List files failed (HTTP ${res.status}): ${text.slice(0, 1000)}`,
		);
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

async function deleteMetaFile(
	apiKey: string,
	fileId: string,
): Promise<unknown> {
	if (!/^file-[a-zA-Z0-9_-]+$/.test(fileId))
		throw new Error(`Invalid file ID: ${fileId}`);
	let fileUrl: string;
	try {
		fileUrl = `${new URL(META_FILES_URL).toString()}/${encodeURIComponent(fileId)}`;
	} catch (error) {
		throw new Error(`Invalid file URL: ${String(error)}`);
	}
	if (!fileUrl.startsWith("https://api.meta.ai/"))
		throw new Error(`Unexpected file delete URL: ${fileUrl}`);
	const res = await fetch(fileUrl, {
		method: "DELETE",
		headers: { Authorization: `Bearer ${apiKey}` },
	});
	const text = await res.text();
	if (!res.ok)
		throw new Error(
			`Delete ${fileId} failed (HTTP ${res.status}): ${text.slice(0, 1000)}`,
		);
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

function responsesUrl(): string {
	return `${META_API_BASE_URL}/responses`;
}

interface ResponsesContentBlock {
	type: string;
	[key: string]: unknown;
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object"
		? (value as Record<string, unknown>)
		: undefined;
}

function tokenCount(...values: unknown[]): number | undefined {
	for (const value of values) {
		const numeric =
			typeof value === "number"
				? value
				: typeof value === "string" && value.trim()
					? Number(value)
					: Number.NaN;
		if (Number.isFinite(numeric)) return Math.max(0, Math.trunc(numeric));
	}
	return undefined;
}

/** Convert a Meta Responses API usage block into Pi's nested-tool usage shape. */
export function extractMetaResponseUsage(
	response: unknown,
	modelId = "muse-spark-1.2",
): Usage | undefined {
	const usage = record(record(response)?.usage);
	if (!usage) return undefined;

	const inputDetails = record(
		usage.input_tokens_details ?? usage.inputTokensDetails,
	);
	const outputDetails = record(
		usage.output_tokens_details ?? usage.outputTokensDetails,
	);
	const inputTotal = tokenCount(
		usage.input_tokens,
		usage.inputTokens,
		usage.prompt_tokens,
		usage.promptTokens,
		usage.input,
	);
	const output = tokenCount(
		usage.output_tokens,
		usage.outputTokens,
		usage.completion_tokens,
		usage.completionTokens,
		usage.output,
	);
	if (inputTotal === undefined && output === undefined) return undefined;

	const reportedInput = inputTotal ?? 0;
	const cacheRead = Math.min(
		reportedInput,
		tokenCount(inputDetails?.cached_tokens, inputDetails?.cachedTokens) ?? 0,
	);
	const cacheWrite = Math.min(
		reportedInput - cacheRead,
		tokenCount(
			inputDetails?.cache_write_tokens,
			inputDetails?.cacheWriteTokens,
		) ?? 0,
	);
	const uncachedInput = Math.max(0, reportedInput - cacheRead - cacheWrite);
	const outputTokens = output ?? 0;
	const reasoning = Math.min(
		outputTokens,
		tokenCount(
			outputDetails?.reasoning_tokens,
			outputDetails?.reasoningTokens,
		) ?? 0,
	);
	const totalTokens =
		tokenCount(usage.total_tokens, usage.totalTokens) ??
		uncachedInput + cacheRead + cacheWrite + outputTokens;
	const model = createMetaProviderConfig().models?.find(
		(candidate) => candidate.id === modelId,
	);
	const rates = model?.cost;
	const cost = {
		input: (uncachedInput * (rates?.input ?? 0)) / 1_000_000,
		output: (outputTokens * (rates?.output ?? 0)) / 1_000_000,
		cacheRead: (cacheRead * (rates?.cacheRead ?? 0)) / 1_000_000,
		cacheWrite: (cacheWrite * (rates?.cacheWrite ?? 0)) / 1_000_000,
		total: 0,
	};
	cost.total = cost.input + cost.output + cost.cacheRead + cost.cacheWrite;

	return {
		input: uncachedInput,
		output: outputTokens,
		cacheRead,
		cacheWrite,
		reasoning,
		totalTokens,
		cost,
	};
}

export function formatMetaResponseUsage(usage: Usage): string {
	const parts = [`${usage.input.toLocaleString()} input`];
	if (usage.cacheRead)
		parts.push(`${usage.cacheRead.toLocaleString()} cache read`);
	if (usage.cacheWrite)
		parts.push(`${usage.cacheWrite.toLocaleString()} cache write`);
	parts.push(`${usage.output.toLocaleString()} output`);
	if (usage.reasoning)
		parts.push(`${usage.reasoning.toLocaleString()} reasoning`);
	return `Video token usage: ${usage.totalTokens.toLocaleString()} total (${parts.join(", ")})`;
}

// Helper to extract output_text from Responses API response (covers streamed and non-streamed shapes)
export function extractResponsesText(json: unknown): string {
	if (!json || typeof json !== "object") return "";
	const j = json as Record<string, unknown>;
	// Some Meta responses include an empty output_text alongside populated output blocks.
	if (typeof j.output_text === "string" && j.output_text.trim())
		return j.output_text;
	const output = j.output as unknown;
	if (Array.isArray(output)) {
		const texts: string[] = [];
		for (const item of output as Record<string, unknown>[]) {
			if (!item || typeof item !== "object" || item.type !== "message")
				continue;
			if (typeof item.content === "string" && item.content.trim())
				texts.push(item.content);
			if (Array.isArray(item.content)) {
				for (const c of item.content as Record<string, unknown>[]) {
					if (
						(c.type === "output_text" || c.type === "text") &&
						typeof c.text === "string" &&
						c.text.trim()
					)
						texts.push(c.text);
					if (
						c.type === "refusal" &&
						typeof c.refusal === "string" &&
						c.refusal.trim()
					)
						texts.push(c.refusal);
				}
			}
		}
		if (texts.length) return texts.join("\n\n");
	}
	if (typeof j.text === "string" && j.text.trim()) return j.text;
	return JSON.stringify(json, null, 2).slice(0, 8000);
}

async function callMetaResponses(
	apiKey: string,
	payload: Record<string, unknown>,
	signal?: AbortSignal,
): Promise<{ text: string; raw: unknown }> {
	// Force store:false for media payloads to avoid the ~20 MB
	// persistence limit (413 payload_too_large with store=true). Files API
	// is the correct path for large media per /docs/file-handling.
	payload.store = false;
	const doFetch = async (body: Record<string, unknown>) =>
		await fetch(responsesUrl(), {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
				"x-api-version": "1.0.0",
			},
			body: JSON.stringify(body),
			signal,
		});
	let res = await doFetch(payload);
	let text = await res.text();
	let json: unknown;
	try {
		json = text ? (JSON.parse(text) as unknown) : {};
	} catch {
		json = text;
	}
	if (!res.ok) {
		const detail =
			(json &&
			typeof json === "object" &&
			"error" in (json as Record<string, unknown>)
				? JSON.stringify((json as Record<string, unknown>).error).slice(0, 1000)
				: typeof json === "object" &&
						json !== null &&
						"message" in (json as Record<string, unknown>)
					? String((json as Record<string, unknown>).message).slice(0, 1000)
					: text.slice(0, 1000)) || res.statusText;
		// Auto-retry once with store:false if the error is the ~20 MB
		// persistence limit (413 with store=true) and we haven't already set it.
		const isStoreLimit =
			res.status === 413 &&
			String(detail).includes("store=true") &&
			payload.store !== false;
		if (isStoreLimit) {
			res = await doFetch({ ...payload, store: false });
			text = await res.text();
			try {
				json = text ? (JSON.parse(text) as unknown) : {};
			} catch {
				json = text;
			}
			if (res.ok) return { text: extractResponsesText(json), raw: json };
		}
		throw new Error(`Meta Responses failed (HTTP ${res.status}): ${detail}`);
	}
	return { text: extractResponsesText(json), raw: json };
}

function dataUrlForFile(path: string): {
	dataUrl: string;
	mime: string;
	bytes: number;
} {
	const data = readFileSync(path);
	const mime = mimeForPath(path) ?? "application/octet-stream";
	const b64 = data.toString("base64");
	return {
		dataUrl: `data:${mime};base64,${b64}`,
		mime,
		bytes: data.byteLength,
	};
}

type AnalysisSource = { source: string; label?: string };

const automaticExpiry = () => ({
	anchor: "created_at" as const,
	seconds: AUTOMATIC_UPLOAD_EXPIRY_SECONDS,
});

function mediaToolError(tool: string, error: unknown): never {
	if (error instanceof Error && error.name === "AbortError") throw error;
	const message = error instanceof Error ? error.message : String(error);
	throw new Error(`${tool} failed: ${message}`, { cause: error });
}

async function resolveGenericMediaSource(
	apiKey: string,
	cwd: string,
	source: string,
): Promise<ResponsesContentBlock> {
	if (/^file-[a-zA-Z0-9_-]+$/.test(source)) {
		return { type: "input_file", file_id: source };
	}
	if (source.startsWith("https://") || source.startsWith("data:")) {
		return mediaInputFromSource(source);
	}
	const absolute = resolve(cwd, source.replace(/^@/, ""));
	if (!existsSync(absolute)) throw new Error(`File not found: ${absolute}`);
	const stat = statSync(absolute);
	if (stat.size > FILES_API_LIMIT_BYTES) {
		throw new Error(`File too large (1 GiB limit): ${source}`);
	}
	if (stat.size > STORE_SAFE_INLINE_BYTES) {
		const upload = await uploadMetaFile(apiKey, absolute, automaticExpiry());
		return { type: "input_file", file_id: upload.id };
	}
	const { dataUrl, mime } = dataUrlForFile(absolute);
	return mediaInputFromSource(dataUrl, basename(absolute), mime);
}

function sourceLabel(source: AnalysisSource, index: number): string {
	return source.label?.trim() || `Source ${index + 1}`;
}

// ---------------------------------------------------------------------------
// Before-provider-request rewrite (Option B)
// Makes @video.mp4 / @audio.wav / @doc.pdf work transparently even though
// pi-ai's UserMessage is still string | (TextContent | ImageContent)[].
// We smuggle video/audio/pdf as ImageContent (data:video/..., data:audio/..., data:application/pdf...)
// via the input handler or via read tool results; this hook rewrites the
// resulting {type:"input_image", image_url:"data:video/..."} into the typed
// input_video/input_audio/input_file block required by Meta before the request is sent.
// Also handles https://... media URLs and large inline payloads via Files API.
// Enable/disable via PI_META_NATIVE_ATTACHMENTS env (default: on).
// ---------------------------------------------------------------------------

function shouldEnableNativeRewrite(): boolean {
	const v =
		process.env.PI_META_NATIVE_ATTACHMENTS ?? process.env.PI_META_MEDIA_NATIVE;
	if (v === undefined) return true; // default on — set to "0"/"false" to disable
	return v !== "0" && v.toLowerCase() !== "false" && v.toLowerCase() !== "off";
}

function isInputImageBlock(b: Record<string, unknown>): boolean {
	return b.type === "input_image" && typeof b.image_url === "string";
}

function rewriteBlock(
	block: Record<string, unknown>,
): Record<string, unknown> | null {
	if (!isInputImageBlock(block)) return null;
	const url = block.image_url as string;
	const mime = mimeForDataUrl(url);
	// Also handle https URLs ending with .mp4/.wav/.mp3/.pdf
	const lowerUrl = url.toLowerCase();
	const isHttpsVideo =
		url.startsWith("https://") &&
		(lowerUrl.endsWith(".mp4") || lowerUrl.endsWith(".m4v"));
	const isHttpsAudio =
		url.startsWith("https://") &&
		(lowerUrl.endsWith(".mp3") || lowerUrl.endsWith(".wav"));
	const isHttpsPdf = url.startsWith("https://") && lowerUrl.endsWith(".pdf");
	const isHttpsImage =
		url.startsWith("https://") &&
		(lowerUrl.endsWith(".png") ||
			lowerUrl.endsWith(".jpg") ||
			lowerUrl.endsWith(".jpeg") ||
			lowerUrl.endsWith(".gif") ||
			lowerUrl.endsWith(".webp"));

	if (isHttpsImage || isImageMime(mime)) return null; // keep as image

	if (isVideoMime(mime) || isHttpsVideo) {
		return mediaInputFromSource(url, "video.mp4", "video/mp4") as Record<
			string,
			unknown
		>;
	}
	if (isAudioMime(mime) || isHttpsAudio) {
		const effectiveMime =
			typeof mime === "string"
				? mime
				: lowerUrl.endsWith(".wav")
					? "audio/wav"
					: "audio/mpeg";
		return mediaInputFromSource(
			url,
			filenameForMime(effectiveMime, "audio.bin"),
			effectiveMime,
		) as Record<string, unknown>;
	}
	if (isPdfMime(mime) || isHttpsPdf) {
		return mediaInputFromSource(
			url,
			"document.pdf",
			"application/pdf",
		) as Record<string, unknown>;
	}
	return null;
}

/** Rewrite smuggled media image_url blocks into Meta-supported typed blocks. */
export function rewriteResponsesPayload(payload: unknown): {
	rewritten: boolean;
	payload: unknown;
} {
	if (!payload || typeof payload !== "object")
		return { rewritten: false, payload };
	const p = payload as Record<string, unknown>;
	const input = p.input;
	if (!Array.isArray(input)) return { rewritten: false, payload };
	let rewritten = false;
	const newInput = input.map((entry) => {
		if (!entry || typeof entry !== "object") return entry;
		const e = entry as Record<string, unknown>;
		// case 1: user message {role:"user", content:[...]}
		if (Array.isArray(e.content)) {
			const newContent = (e.content as Record<string, unknown>[]).map(
				(block) => {
					const r = rewriteBlock(block as Record<string, unknown>);
					if (r) {
						rewritten = true;
						return r;
					}
					return block;
				},
			);
			if (newContent !== e.content) return { ...e, content: newContent };
		}
		// case 2: function_call_output {type:"function_call_output", output:[...]} where output contains input_image blocks
		if (e.type === "function_call_output" && Array.isArray(e.output)) {
			const newOutput = (e.output as Record<string, unknown>[]).map((block) => {
				// output blocks are like {type:"input_text", text} or {type:"input_image", image_url}
				if (
					block.type === "input_image" &&
					typeof block.image_url === "string"
				) {
					const r = rewriteBlock(block as Record<string, unknown>);
					if (r) {
						rewritten = true;
						// tool outputs use same types as user content; return rewritten block
						return r;
					}
				}
				return block;
			});
			if (newOutput !== e.output) return { ...e, output: newOutput };
		}
		// case 3: custom_tool_call_output similar
		if (e.type === "custom_tool_call_output" && Array.isArray(e.output)) {
			const newOutput = (e.output as Record<string, unknown>[]).map((block) => {
				if (
					block.type === "input_image" &&
					typeof block.image_url === "string"
				) {
					const r = rewriteBlock(block as Record<string, unknown>);
					if (r) {
						rewritten = true;
						return r;
					}
				}
				return block;
			});
			if (newOutput !== e.output) return { ...e, output: newOutput };
		}
		return e;
	});
	if (!rewritten) return { rewritten: false, payload };
	return { rewritten: true, payload: { ...p, input: newInput } };
}

async function uploadInlineMedia(
	apiKey: string,
	base64: string,
	mime: string,
	filename: string,
): Promise<string> {
	const blob = new Blob([Buffer.from(base64, "base64")], { type: mime });
	const form = new FormData();
	form.append("file", blob, filename);
	form.append("purpose", "user_data");
	form.append("expires_after[anchor]", "created_at");
	form.append("expires_after[seconds]", String(AUTOMATIC_UPLOAD_EXPIRY_SECONDS));
	const res = await fetch(META_FILES_URL, {
		method: "POST",
		headers: { Authorization: `Bearer ${apiKey}` },
		body: form,
	});
	const text = await res.text();
	if (!res.ok) {
		throw new Error(
			`Files upload for large inline media failed: ${text.slice(0, 500)}`,
		);
	}
	let json: Record<string, unknown>;
	try {
		json = JSON.parse(text) as Record<string, unknown>;
	} catch (error) {
		throw new Error(`Files upload returned invalid JSON: ${String(error)}`);
	}
	if (typeof json.id !== "string" || !json.id) {
		throw new Error(`Files upload returned no id: ${text.slice(0, 500)}`);
	}
	return json.id;
}

// Promote inline media above the store-safe threshold to the Files API. Typed
// input_video/input_audio blocks stay inline below the threshold.
export async function maybeUploadLargeInlineBlocks(
	payload: unknown,
	apiKey: string | undefined,
	uploadThresholdBytes = STORE_SAFE_INLINE_BYTES,
): Promise<{ payload: unknown; uploaded: number }> {
	if (!apiKey) return { payload, uploaded: 0 };
	if (!payload || typeof payload !== "object") return { payload, uploaded: 0 };
	const p = payload as Record<string, unknown>;
	const input = p.input;
	if (!Array.isArray(input)) return { payload, uploaded: 0 };
	let uploaded = 0;
	let needsStoreFalse = false;
	const newInput: unknown[] = [];

	for (const entry of input as Record<string, unknown>[]) {
		if (!entry || typeof entry !== "object" || !Array.isArray(entry.content)) {
			newInput.push(entry);
			continue;
		}
		const content = entry.content as Record<string, unknown>[];
		const newContent: Record<string, unknown>[] = [];
		for (const block of content) {
			let inline:
				| { base64: string; mime: string; filename: string }
				| undefined;
			if (
				block.type === "input_video" &&
				typeof block.video_url === "string" &&
				block.video_url.startsWith("data:")
			) {
				inline = {
					base64: base64FromDataUrl(block.video_url),
					mime: mimeForDataUrl(block.video_url) ?? "video/mp4",
					filename: "video.mp4",
				};
			} else if (block.type === "input_audio") {
				const audio = record(block.input_audio);
				if (typeof audio?.data === "string") {
					const format = audio.format === "wav" ? "wav" : "mp3";
					inline = {
						base64: audio.data.startsWith("data:")
							? base64FromDataUrl(audio.data)
							: audio.data,
						mime: format === "wav" ? "audio/wav" : "audio/mpeg",
						filename: `audio.${format}`,
					};
				}
			} else if (
				block.type === "input_file" &&
				typeof block.file_data === "string" &&
				block.file_data.startsWith("data:")
			) {
				const mime =
					mimeForDataUrl(block.file_data) ?? "application/octet-stream";
				inline = {
					base64: base64FromDataUrl(block.file_data),
					mime,
					filename:
						typeof block.filename === "string" && block.filename
							? block.filename
							: filenameForMime(mime),
				};
			}

			if (inline) {
				needsStoreFalse = true;
				if (base64ByteLength(inline.base64) > uploadThresholdBytes) {
					const id = await uploadInlineMedia(
						apiKey,
						inline.base64,
						inline.mime,
						inline.filename,
					);
					uploaded++;
					newContent.push({ type: "input_file", file_id: id });
					continue;
				}
			}
			newContent.push(block);
		}
		newInput.push({ ...entry, content: newContent });
	}

	if (uploaded === 0) {
		return needsStoreFalse
			? { payload: { ...p, store: false }, uploaded: 0 }
			: { payload, uploaded: 0 };
	}
	return { payload: { ...p, input: newInput, store: false }, uploaded };
}

// ---------------------------------------------------------------------------
// Main extension
// ---------------------------------------------------------------------------

export default function metaMedia(pi: ExtensionAPI): void {
	// --- Before provider request rewrite (Option B transparent path) ---
	if (shouldEnableNativeRewrite()) {
		pi.on("before_provider_request", async (event, ctx) => {
			if (ctx.model?.provider !== META_PROVIDER_ID) return undefined;
			const original = event.payload as Record<string, unknown>;
			const { rewritten, payload: rewrittenPayload } =
				rewriteResponsesPayload(original);
			// Even without rewrite, large inline media in the original payload
			// (e.g. drag-dropped video) can hit the 413 store=true limit —
			// ensure store:false and try Files API upload.
			const payloadToCheck = rewritten ? rewrittenPayload : original;
			const hasMedia = (() => {
				if (!payloadToCheck || typeof payloadToCheck !== "object") return false;
				const input = (payloadToCheck as Record<string, unknown>).input;
				if (!Array.isArray(input)) return false;
				for (const e of input as Record<string, unknown>[]) {
					if (!e || typeof e !== "object" || !Array.isArray(e.content))
						continue;
					for (const b of e.content as Record<string, unknown>[]) {
						if (
							b.type === "input_file" ||
							b.type === "input_image" ||
							b.type === "input_video" ||
							b.type === "input_audio"
						)
							return true;
					}
				}
				return false;
			})();
			if (!rewritten && !hasMedia) return undefined;
			// Resolve the same stored Meta credential used by the active provider. This is
			// essential for @file drag-drop, where the key usually is not in process.env.
			let apiKey =
				process.env.MODEL_API_KEY ?? process.env.META_API_KEY ?? undefined;
			if (!apiKey) {
				try {
					apiKey =
						(await ctx.modelRegistry.getApiKeyForProvider(META_PROVIDER_ID)) ??
						undefined;
				} catch {
					// Fall back to typed inline media with store:false below.
				}
			}
			if (apiKey) {
				try {
					const { payload: uploadedPayload } =
						await maybeUploadLargeInlineBlocks(payloadToCheck, apiKey);
					return uploadedPayload as unknown;
				} catch {
					// fall back without upload — at least force store:false
					const fallback = payloadToCheck as Record<string, unknown>;
					return { ...fallback, store: false } as unknown;
				}
			}
			// No apiKey available for upload — force store:false to avoid 413
			return {
				...(payloadToCheck as Record<string, unknown>),
				store: false,
			} as unknown;
		});
	}

	// --- Input handler: let @video.mp4 / @audio.wav / @doc.pdf be pasted like @image.png ---
	// Pi's TUI already turns @image.png into ImageContent; for other types event.text still
	// contains the literal path and images is empty. We turn those paths into pseudo-ImageContent
	// so the before_provider_request hook can rewrite them.
	pi.on("input", async (event, ctx) => {
		if (!shouldEnableNativeRewrite()) return undefined;
		// Only Meta's request hook knows how to rewrite these pseudo-images into
		// typed video/audio/file blocks. Other providers (notably Codex) reject a
		// video/mp4 ImageContent before the Meta tools can be called, so leave the
		// path as text and let the active model invoke the direct Meta media tool.
		if (ctx.model?.provider !== META_PROVIDER_ID) return undefined;
		const text = event.text ?? "";
		// Match @/path/to/file.mp4, @./file.wav, /abs/file.pdf, ./file.mp3 — conservative.
		const filePattern =
			/(?:^|\s)@?((?:[~.]?\/[^\s]+\.(?:mp4|m4v|mp3|wav|pdf))|(?:[^\s]+\.(?:mp4|m4v|mp3|wav|pdf)))/gi;
		const matches = [...text.matchAll(filePattern)];
		if (matches.length === 0) return undefined;
		const cwd = (ctx as unknown as { cwd?: string }).cwd ?? process.cwd();
		const newImages: { type: "image"; data: string; mimeType: string }[] = [
			...(event.images ?? []),
		] as typeof newImages;
		let newText = text;
		let touched = false;
		for (const m of matches) {
			const rawPath = m[1];
			if (!rawPath) continue;
			// Resolve relative to cwd, expand ~, strip @
			const clean = rawPath.replace(/^@/, "");
			const expanded = clean.startsWith("~/")
				? clean.replace("~", process.env.HOME ?? "")
				: clean;
			const absolute = resolve(cwd, expanded);
			if (!existsSync(absolute)) continue;
			const mime = mimeForPath(absolute);
			if (!mime) continue;
			const stat = statSync(absolute);
			if (stat.size > FILES_API_LIMIT_BYTES) {
				safeNotify(
					ctx,
					`Skipping ${basename(absolute)} — too large for Meta Files API (1 GiB limit)`,
					"warning",
				);
				continue;
			}
			// Files API is required for reliability — inline base64 hits the
			// ~20 MB `store=true` persistence limit (24 MB → 413). We keep inline
			// only for small files (<15 MB); larger files will be uploaded via
			// Files API in before_provider_request or via /meta-video.
			if (stat.size > STORE_SAFE_INLINE_BYTES) {
				if (stat.size > INLINE_LIMIT_BYTES) {
					safeNotify(
						ctx,
						`Large file ${basename(absolute)} (${(stat.size / 1_000_000).toFixed(1)} MB) — use /meta-video or /meta-audio for Files API upload (50MB inline / 15MB store-safe limit)`,
						"info",
					);
					continue;
				}
				// 15-50 MB: still smuggle inline but before_provider_request
				// will promote to Files API (if apiKey available) and set store:false
			}
			try {
				const { dataUrl } = dataUrlForFile(absolute);
				const b64 = base64FromDataUrl(dataUrl);
				// Smuggle as ImageContent with video/audio/pdf mime — before_provider_request will rewrite.
				// pi-ai types allow any mimeType string, so video/mp4 is fine at runtime even though Model.input is cast.
				newImages.push({ type: "image", data: b64, mimeType: mime });
				// Remove the path from text so LLM doesn't see a stray filename; keep a placeholder for UX
				newText = newText.replace(rawPath, `[attached ${basename(absolute)}]`);
				touched = true;
			} catch (e) {
				safeNotify(
					ctx,
					`Failed to attach ${basename(absolute)}: ${e instanceof Error ? e.message : String(e)}`,
					"error",
				);
			}
		}
		if (!touched) return undefined;
		return {
			action: "transform",
			text: newText,
			images: newImages as unknown as typeof event.images,
		};
	});

	// -----------------------------------------------------------------------
	// Tools — the reliable path that works even when UserMessage types are limited.
	// These call Meta's Responses API directly with the stored OAuth key, so they
	// don't depend on pi-ai's ImageContent union. Use when @file paste isn't enough
	// or for large/reused files.
	// -----------------------------------------------------------------------

	pi.registerTool({
		name: "meta_describe_video",
		label: "Meta Video Describe",
		description:
			"Analyze an MP4 video with Muse Spark, including visuals and embedded speech. Accepts a local path, public HTTPS/data URL, or Meta file_id. Results are capped by max_chars; when truncated, the full text is saved to a temp file for continuation with read offset/limit.",
		promptSnippet: "Inspect video and embedded audio when the active model cannot",
		promptGuidelines: [
			"Use meta_describe_video when the task depends on an MP4 video the active model cannot inspect directly.",
			"Give meta_describe_video a task-specific prompt that asks for the exact visual, transcript, timestamp, or defect evidence needed next.",
			"When a Meta media result is truncated, continue from its saved temp file with read using offset/limit.",
		],
		parameters: Type.Object(
			{
				path: Type.Optional(Type.String({ description: "Local .mp4/.m4v path, relative to cwd or absolute" })),
				url: Type.Optional(Type.String({ description: "Public HTTPS or data:video/mp4 URL" })),
				file_id: Type.Optional(Type.String({ description: "Existing Meta Files API id" })),
				prompt: Type.String({ description: "What evidence to extract from the video" }),
				model: Type.Optional(Type.String({ description: "Muse model id, default muse-spark-1.2" })),
				max_output_tokens: Type.Optional(Type.Integer({
					minimum: MIN_MEDIA_MAX_OUTPUT_TOKENS,
					maximum: MAX_MEDIA_MAX_OUTPUT_TOKENS,
					description: `Muse generation budget, default ${DEFAULT_MEDIA_MAX_OUTPUT_TOKENS}`,
				})),
				max_chars: Type.Optional(Type.Integer({
					minimum: 1_000,
					maximum: MAX_MEDIA_MAX_CHARS,
					description: `Maximum result characters returned inline, default ${DEFAULT_MEDIA_MAX_CHARS}`,
				})),
			},
			{ additionalProperties: false },
		),
		async execute(toolCallId, params, signal, _onUpdate, ctx) {
			const { path, url, file_id, prompt, model, max_output_tokens, max_chars } = params as {
				path?: string; url?: string; file_id?: string; prompt: string; model?: string;
				max_output_tokens?: number; max_chars?: number;
			};
			if ([path, url, file_id].filter(Boolean).length !== 1) {
				throw new Error("meta_describe_video requires exactly one of path, url, or file_id");
			}
			try {
				const apiKey = await safeGetMetaApiKey(ctx as ExtensionContext);
				let videoBlock: ResponsesContentBlock;
				if (file_id) videoBlock = { type: "input_file", file_id };
				else if (url) videoBlock = mediaInputFromSource(url, "video.mp4", "video/mp4");
				else {
					const absolute = resolve(ctx.cwd, path as string);
					if (!existsSync(absolute)) throw new Error(`File not found: ${absolute}`);
					const stat = statSync(absolute);
					if (stat.size > FILES_API_LIMIT_BYTES) throw new Error(`File too large (1 GiB limit): ${path}`);
					if (stat.size > STORE_SAFE_INLINE_BYTES) {
						const upload = await uploadMetaFile(apiKey, absolute, automaticExpiry());
						videoBlock = { type: "input_file", file_id: upload.id };
					} else {
						videoBlock = mediaInputFromSource(dataUrlForFile(absolute).dataUrl, basename(absolute), "video/mp4");
					}
				}
				const selectedModel = model ?? "muse-spark-1.2";
				const { text, raw } = await callMetaResponses(apiKey, {
					model: selectedModel,
					store: false,
					input: [{ type: "message", role: "user", content: [
						{ type: "input_text", text: prompt },
						videoBlock as Record<string, unknown>,
					] }],
					max_output_tokens: mediaMaxOutputTokens(max_output_tokens),
				}, signal);
				const output = await prepareMediaOutput({ text, response: raw, identity: toolCallId, maxChars: max_chars });
				const usage = extractMetaResponseUsage(raw, selectedModel);
				return {
					content: [{ type: "text", text: output.text }],
					details: { raw, videoBlock, ...output.details },
					usage,
				};
			} catch (error) {
				mediaToolError("Video analysis", error);
			}
		},
	});

	pi.registerTool({
		name: "meta_transcribe_audio",
		label: "Meta Audio Transcribe",
		description:
			"Transcribe MP3 or WAV audio with Muse Spark from a local path, public URL, or Meta file_id. Results are capped by max_chars; when truncated, the full transcript is saved to a temp file for continuation with read offset/limit.",
		promptSnippet: "Transcribe audio when the active model cannot",
		promptGuidelines: [
			"Use meta_transcribe_audio when the task depends on MP3 or WAV speech the active model cannot inspect directly.",
			"When a Meta media result is truncated, continue from its saved temp file with read using offset/limit.",
		],
		parameters: Type.Object(
			{
				path: Type.Optional(Type.String({ description: "Local .wav/.mp3 path" })),
				url: Type.Optional(Type.String({ description: "Public HTTPS or data audio URL" })),
				file_id: Type.Optional(Type.String({ description: "Existing Meta Files API id" })),
				prompt: Type.Optional(Type.String({ description: "Transcription or audio-analysis instruction" })),
				model: Type.Optional(Type.String({ description: "Muse model id, default muse-spark-1.2" })),
				max_output_tokens: Type.Optional(Type.Integer({
					minimum: MIN_MEDIA_MAX_OUTPUT_TOKENS,
					maximum: MAX_MEDIA_MAX_OUTPUT_TOKENS,
					description: `Muse generation budget, default ${DEFAULT_MEDIA_MAX_OUTPUT_TOKENS}`,
				})),
				max_chars: Type.Optional(Type.Integer({
					minimum: 1_000,
					maximum: MAX_MEDIA_MAX_CHARS,
					description: `Maximum transcript characters returned inline, default ${DEFAULT_MEDIA_MAX_CHARS}`,
				})),
			},
			{ additionalProperties: false },
		),
		async execute(toolCallId, params, signal, _onUpdate, ctx) {
			const { path, url, file_id, prompt, model, max_output_tokens, max_chars } = params as {
				path?: string; url?: string; file_id?: string; prompt?: string; model?: string;
				max_output_tokens?: number; max_chars?: number;
			};
			if ([path, url, file_id].filter(Boolean).length !== 1) {
				throw new Error("meta_transcribe_audio requires exactly one of path, url, or file_id");
			}
			try {
				const apiKey = await safeGetMetaApiKey(ctx as ExtensionContext);
				let audioBlock: ResponsesContentBlock;
				if (file_id) audioBlock = { type: "input_file", file_id };
				else if (url) audioBlock = mediaInputFromSource(url, "audio.bin");
				else {
					const absolute = resolve(ctx.cwd, path as string);
					if (!existsSync(absolute)) throw new Error(`File not found: ${absolute}`);
					const stat = statSync(absolute);
					if (stat.size > FILES_API_LIMIT_BYTES) throw new Error("Audio too large (1 GiB limit)");
					const mime = mimeForPath(absolute);
					if (mime !== undefined && !isAudioMime(mime)) {
						throw new Error(`Unsupported audio type for ${path}; use MP3 or WAV`);
					}
					if (stat.size > STORE_SAFE_INLINE_BYTES) {
						const upload = await uploadMetaFile(apiKey, absolute, automaticExpiry());
						audioBlock = { type: "input_file", file_id: upload.id };
					} else {
						audioBlock = mediaInputFromSource(dataUrlForFile(absolute).dataUrl, basename(absolute), mime);
					}
				}
				const selectedModel = model ?? "muse-spark-1.2";
				const { text, raw } = await callMetaResponses(apiKey, {
					model: selectedModel,
					store: false,
					input: [{ type: "message", role: "user", content: [
						{ type: "input_text", text: prompt ?? "Transcribe this audio. Return only the transcript." },
						audioBlock as Record<string, unknown>,
					] }],
					max_output_tokens: mediaMaxOutputTokens(max_output_tokens),
				}, signal);
				const output = await prepareMediaOutput({ text, response: raw, identity: toolCallId, maxChars: max_chars });
				const usage = extractMetaResponseUsage(raw, selectedModel);
				return {
					content: [{ type: "text", text: output.text }],
					details: { raw, audioBlock, ...output.details },
					usage,
				};
			} catch (error) {
				mediaToolError("Audio transcription", error);
			}
		},
	});

	pi.registerTool({
		name: "meta_upload_file",
		label: "Meta Files Upload",
		description:
			"Upload a local file to Meta Files API for reuse. Uploads expire after seven days by default. Set expires_after_seconds to choose 3600..2592000 seconds, or retain=true to opt into no expiry.",
		parameters: Type.Object(
			{
				path: Type.String({ description: "Local file path to upload" }),
				expires_after_seconds: Type.Optional(Type.Integer({
					minimum: MIN_UPLOAD_EXPIRY_SECONDS,
					maximum: MAX_UPLOAD_EXPIRY_SECONDS,
					description: `Expiry in seconds, default ${EXPLICIT_UPLOAD_EXPIRY_SECONDS} (7 days)`,
				})),
				retain: Type.Optional(Type.Boolean({ description: "Keep indefinitely instead of applying an expiry" })),
			},
			{ additionalProperties: false },
		),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const { path, expires_after_seconds, retain } = params as {
				path: string; expires_after_seconds?: number; retain?: boolean;
			};
			if (retain && expires_after_seconds !== undefined) {
				throw new Error("meta_upload_file accepts either retain=true or expires_after_seconds, not both");
			}
			try {
				const apiKey = await safeGetMetaApiKey(ctx as ExtensionContext);
				const absolute = resolve(ctx.cwd, path);
				if (!existsSync(absolute)) throw new Error(`File not found: ${absolute}`);
				const expiresAfter = retain ? undefined : {
					anchor: "created_at" as const,
					seconds: expires_after_seconds ?? EXPLICIT_UPLOAD_EXPIRY_SECONDS,
				};
				const result = await uploadMetaFile(apiKey, absolute, expiresAfter);
				const retention = retain
					? "retained without expiry"
					: result.expires_at
						? `expires_at ${result.expires_at}`
						: `expires after ${expiresAfter?.seconds} seconds`;
				return {
					content: [{ type: "text", text: `Uploaded ${basename(absolute)} to ${result.id} (${result.bytes} bytes, ${retention}).` }],
					details: result,
				};
			} catch (error) {
				mediaToolError("File upload", error);
			}
		},
	});

	pi.registerTool({
		name: "meta_analyze_file",
		label: "Meta File Analyze",
		description:
			"Analyze one or more images, PDFs, videos, or audio files with Muse Spark. Use path/url/file_id for one source, or ordered sources for comparisons. Images and PDF pages share Meta's 50-image budget; PDFs include text from the first 100 pages and images from the first 50 pages. Truncated text is saved for continuation with read offset/limit.",
		promptSnippet: "Inspect images, PDFs, or mixed media when the active model cannot",
		promptGuidelines: [
			"Use meta_analyze_file when the task depends on an image, PDF, or generic media file the active model cannot inspect directly.",
			"Give meta_analyze_file a task-specific prompt that asks for the exact visible text, layout, comparison, defect, or action evidence needed next.",
			"When a Meta media result is truncated, continue from its saved temp file with read using offset/limit.",
		],
		parameters: Type.Object(
			{
				path: Type.Optional(Type.String({ description: "Single local file path" })),
				url: Type.Optional(Type.String({ description: "Single public HTTPS or data URL" })),
				file_id: Type.Optional(Type.String({ description: "Single existing Meta file_id" })),
				sources: Type.Optional(Type.Array(Type.Object({
					source: Type.String({ description: "Local path, HTTPS/data URL, or Meta file_id" }),
					label: Type.Optional(Type.String({ description: "Human-readable label such as Before or After" })),
				}, { additionalProperties: false }), {
					minItems: 1,
					maxItems: MAX_ANALYSIS_SOURCES,
					description: "Ordered sources for comparison or combined analysis",
				})),
				prompt: Type.String({ description: "What evidence to extract or compare" }),
				model: Type.Optional(Type.String({ description: "Muse model id, default muse-spark-1.2" })),
				max_output_tokens: Type.Optional(Type.Integer({
					minimum: MIN_MEDIA_MAX_OUTPUT_TOKENS,
					maximum: MAX_MEDIA_MAX_OUTPUT_TOKENS,
					description: `Muse generation budget, default ${DEFAULT_MEDIA_MAX_OUTPUT_TOKENS}`,
				})),
				max_chars: Type.Optional(Type.Integer({
					minimum: 1_000,
					maximum: MAX_MEDIA_MAX_CHARS,
					description: `Maximum result characters returned inline, default ${DEFAULT_MEDIA_MAX_CHARS}`,
				})),
			},
			{ additionalProperties: false },
		),
		async execute(toolCallId, params, signal, _onUpdate, ctx) {
			const { path, url, file_id, sources, prompt, model, max_output_tokens, max_chars } = params as {
				path?: string; url?: string; file_id?: string; sources?: AnalysisSource[];
				prompt: string; model?: string; max_output_tokens?: number; max_chars?: number;
			};
			const legacySources = [path, url, file_id].filter((value): value is string => Boolean(value));
			if (legacySources.length > 1 || (legacySources.length === 1 && sources) || (legacySources.length === 0 && !sources)) {
				throw new Error("meta_analyze_file requires exactly one path/url/file_id or a sources array");
			}
			if (sources && sources.length > MAX_ANALYSIS_SOURCES) {
				throw new Error(`meta_analyze_file supports at most ${MAX_ANALYSIS_SOURCES} sources`);
			}
			try {
				const apiKey = await safeGetMetaApiKey(ctx as ExtensionContext);
				const requestedSources: AnalysisSource[] = sources ?? [{ source: legacySources[0] as string }];
				const content: ResponsesContentBlock[] = [{ type: "input_text", text: prompt }];
				for (const [index, item] of requestedSources.entries()) {
					if (requestedSources.length > 1 || item.label) {
						content.push({ type: "input_text", text: `${sourceLabel(item, index)}:` });
					}
					content.push(await resolveGenericMediaSource(apiKey, ctx.cwd, item.source));
				}
				const selectedModel = model ?? "muse-spark-1.2";
				const { text, raw } = await callMetaResponses(apiKey, {
					model: selectedModel,
					store: false,
					input: [{ type: "message", role: "user", content: content as Record<string, unknown>[] }],
					max_output_tokens: mediaMaxOutputTokens(max_output_tokens),
				}, signal);
				const output = await prepareMediaOutput({ text, response: raw, identity: toolCallId, maxChars: max_chars });
				const usage = extractMetaResponseUsage(raw, selectedModel);
				return {
					content: [{ type: "text", text: output.text }],
					details: { raw, sourceCount: requestedSources.length, ...output.details },
					usage,
				};
			} catch (error) {
				mediaToolError("File analysis", error);
			}
		},
	});

	// -----------------------------------------------------------------------
	// Slash commands (human-in-the-loop)
	// -----------------------------------------------------------------------

	pi.registerCommand("meta-video", {
		description:
			"Analyze a video with Muse Spark (mp4). Usage: /meta-video <path|url|file_id> [prompt]",
		handler: async (args, ctx) => {
			const cwd = ctx.cwd;
			const trimmed = (args ?? "").trim();
			if (!trimmed) {
				safeNotify(
					ctx,
					'Usage: /meta-video <path|url|file_id> [prompt — default "Describe what happens"]',
					"info",
				);
				return;
			}
			const firstSpace = trimmed.indexOf(" ");
			const source = firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace);
			const prompt =
				firstSpace === -1
					? "Summarize what happens in this video in detail. Transcribe any speech verbatim. List key visual moments in 5 bullet points."
					: trimmed.slice(firstSpace + 1).trim() ||
						"Summarize what happens in this video in detail. Transcribe any speech verbatim.";
			const isFileId = source.startsWith("file-");
			const isUrl = source.startsWith("https://") || source.startsWith("data:");
			const toolArgs: Record<string, unknown> = { prompt };
			if (isFileId) toolArgs.file_id = source;
			else if (isUrl) toolArgs.url = source;
			else toolArgs.path = source;
			safeNotify(ctx, `Analyzing video: ${source}`, "info");
			// Dispatch via LLM tool path by sending a follow-up that triggers the tool
			// For direct command path, call the API directly:
			try {
				const apiKey = await safeGetMetaApiKey(
					ctx as unknown as ExtensionContext,
				);
				let block: ResponsesContentBlock;
				if (isFileId) block = { type: "input_file", file_id: source };
				else if (isUrl)
					block = mediaInputFromSource(source, "video.mp4", "video/mp4");
				else {
					const abs = resolve(cwd, source);
					if (!existsSync(abs)) throw new Error(`File not found: ${abs}`);
					const stat = statSync(abs);
					if (stat.size > STORE_SAFE_INLINE_BYTES) {
						const up = await uploadMetaFile(apiKey, abs, automaticExpiry());
						block = { type: "input_file", file_id: up.id };
					} else {
						const { dataUrl } = dataUrlForFile(abs);
						block = mediaInputFromSource(dataUrl, basename(abs), "video/mp4");
					}
				}
				const model = "muse-spark-1.2";
				const { text, raw } = await callMetaResponses(apiKey, {
					model,
					store: false,
					input: [
						{
							type: "message",
							role: "user",
							content: [
								{ type: "input_text", text: prompt },
								block as unknown as Record<string, unknown>,
							],
						},
					],
					max_output_tokens: 8000,
				});
				const usage = extractMetaResponseUsage(raw, model);
				const usageText = usage ? `\n\n${formatMetaResponseUsage(usage)}` : "";
				const displayText = text.trim()
					? text.slice(0, 4000)
					: `No summary returned (raw preview: ${JSON.stringify(raw).slice(0, 1500)})`;
				safeNotify(ctx, `${displayText}${usageText}`, "info");
			} catch (e) {
				safeNotify(
					ctx,
					`Video analysis failed: ${e instanceof Error ? e.message : String(e)}`,
					"error",
				);
			}
		},
	});

	pi.registerCommand("meta-audio", {
		description:
			"Transcribe audio with Muse Spark (wav/mp3). Usage: /meta-audio <path|url|file_id> [prompt]",
		handler: async (args, ctx) => {
			const cwd = ctx.cwd;
			const trimmed = (args ?? "").trim();
			if (!trimmed) {
				safeNotify(
					ctx,
					"Usage: /meta-audio <path|url|file_id> [prompt]",
					"info",
				);
				return;
			}
			const firstSpace = trimmed.indexOf(" ");
			const source = firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace);
			const prompt =
				firstSpace === -1
					? "Transcribe this audio. Return only the transcript."
					: trimmed.slice(firstSpace + 1).trim() ||
						"Transcribe this audio. Return only the transcript.";
			const isFileId = source.startsWith("file-");
			const isUrl = source.startsWith("https://");
			try {
				const apiKey = await safeGetMetaApiKey(
					ctx as unknown as ExtensionContext,
				);
				let block: ResponsesContentBlock;
				if (isFileId) block = { type: "input_file", file_id: source };
				else if (isUrl) block = mediaInputFromSource(source, "audio.bin");
				else {
					const abs = resolve(cwd, source);
					if (!existsSync(abs)) throw new Error(`File not found: ${abs}`);
					const stat = statSync(abs);
					if (stat.size > STORE_SAFE_INLINE_BYTES) {
						const up = await uploadMetaFile(apiKey, abs, automaticExpiry());
						block = { type: "input_file", file_id: up.id };
					} else {
						const { dataUrl, mime } = dataUrlForFile(abs);
						block = mediaInputFromSource(dataUrl, basename(abs), mime);
					}
				}
				const { text } = await callMetaResponses(apiKey, {
					model: "muse-spark-1.2",
					store: false,
					input: [
						{
							type: "message",
							role: "user",
							content: [
								{ type: "input_text", text: prompt },
								block as unknown as Record<string, unknown>,
							],
						},
					],
					max_output_tokens: 4000,
				});
				safeNotify(ctx, text.slice(0, 4000), "info");
			} catch (e) {
				safeNotify(
					ctx,
					`Audio transcription failed: ${e instanceof Error ? e.message : String(e)}`,
					"error",
				);
			}
		},
	});

	pi.registerCommand("meta-file", {
		description:
			"Analyze any single file (pdf/image/video/audio) with Muse Spark. Usage: /meta-file <path|url|file_id> <prompt> — e.g. /meta-file ./report.pdf summarize",
		handler: async (args, ctx) => {
			const cwd = ctx.cwd;
			const trimmed = (args ?? "").trim();
			if (!trimmed) {
				safeNotify(
					ctx,
					"Usage: /meta-file <path|url|file_id> <prompt>",
					"info",
				);
				return;
			}
			const firstSpace = trimmed.indexOf(" ");
			if (firstSpace === -1) {
				safeNotify(ctx, "Provide a prompt after the file source.", "warning");
				return;
			}
			const source = trimmed.slice(0, firstSpace);
			const prompt = trimmed.slice(firstSpace + 1).trim();
			const isFileId = source.startsWith("file-");
			const isUrl = source.startsWith("https://");
			try {
				const apiKey = await safeGetMetaApiKey(
					ctx as unknown as ExtensionContext,
				);
				let block: ResponsesContentBlock;
				if (isFileId) block = { type: "input_file", file_id: source };
				else if (isUrl) block = mediaInputFromSource(source);
				else {
					const abs = resolve(cwd, source);
					if (!existsSync(abs)) throw new Error(`File not found: ${abs}`);
					const stat = statSync(abs);
					if (stat.size > STORE_SAFE_INLINE_BYTES) {
						const up = await uploadMetaFile(apiKey, abs, automaticExpiry());
						block = { type: "input_file", file_id: up.id };
					} else {
						const { dataUrl, mime } = dataUrlForFile(abs);
						block = mediaInputFromSource(dataUrl, basename(abs), mime);
					}
				}
				const { text } = await callMetaResponses(apiKey, {
					model: "muse-spark-1.2",
					store: false,
					input: [
						{
							type: "message",
							role: "user",
							content: [
								{ type: "input_text", text: prompt },
								block as unknown as Record<string, unknown>,
							],
						},
					],
					max_output_tokens: 4000,
				});
				safeNotify(ctx, text.slice(0, 4000), "info");
			} catch (e) {
				safeNotify(
					ctx,
					`File analysis failed: ${e instanceof Error ? e.message : String(e)}`,
					"error",
				);
			}
		},
	});

	pi.registerCommand("meta-media-help", {
		description: "Show Meta media (video/audio/file) capabilities",
		handler: async (_args, ctx) => {
			safeNotify(
				ctx,
				[
					"Meta media — video (mp4), audio (mp3/wav), pdf, images via Muse Spark",
					"  Tools (LLM): meta_describe_video, meta_transcribe_audio, meta_upload_file, meta_analyze_file",
					"  Commands: /meta-video <path|url|file_id> [prompt]  — analyze video + embedded audio",
					"            /meta-audio <path|url|file_id> [prompt]  — transcribe",
					"            /meta-file <path|url|file_id> <prompt>   — generic (pdf/images too)",
					"  Transparent: @clip.mp4 / @meeting.wav / @doc.pdf pasted like @photo.jpg — uses Files API (1 GiB) or inline (50 MB). Disable with PI_META_NATIVE_ATTACHMENTS=0",
					"  Tips: max_output_tokens ≥4000 for transcription; video without audio is valid; PDFs: first 100p text + 50p images",
				].join("\n"),
				"info",
			);
		},
	});
}
