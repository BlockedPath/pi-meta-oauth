import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { META_FILES_URL, META_API_BASE_URL, META_PROVIDER_ID } from "./meta.ts";
import { existsSync, statSync, readFileSync } from "node:fs";
import { basename, extname, resolve } from "node:path";
import { readFile } from "node:fs/promises";

// ---------------------------------------------------------------------------
// Meta Files API + Responses API
// Docs: https://dev.meta.ai/docs/file-handling , /video-understanding
// - Inline file_data / file_url / video_url / audio : 50 MB limit
// - Files API POST /v1/files purpose=user_data : 1 GiB, 100 GiB/team storage, no expiry by default
// - Video: video/mp4 only, reads frames + embedded audio together
// - Audio: audio/mpeg (.mp3), audio/wav (.wav) via input_audio {data, format}
// - Image: image/png, image/jpeg, image/gif, image/webp, image/x-icon, up to 50/request
// - PDF: application/pdf -> text first 100p + images first 50p (counts to 50-image budget)
// ---------------------------------------------------------------------------

const INLINE_LIMIT_BYTES = 50_000_000;
const FILES_API_LIMIT_BYTES = 1_073_741_824;

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

function audioFormatForMime(mime: string): "wav" | "mp3" {
	const lower = mime.toLowerCase();
	if (lower === "audio/wav" || lower === "audio/x-wav") return "wav";
	return "mp3"; // audio/mpeg, audio/mp3
}

function base64FromDataUrl(dataUrl: string): string {
	const comma = dataUrl.indexOf(",");
	return comma === -1 ? "" : dataUrl.slice(comma + 1);
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

const ALLOWED_META_HOSTS = ["api.meta.ai"] as const;
const ALLOWED_PURPOSES = ["user_data", "batch"] as const;

async function listMetaFiles(
	apiKey: string,
	purpose = "user_data",
): Promise<unknown> {
	if (purpose && !(ALLOWED_PURPOSES as readonly string[]).includes(purpose)) {
		throw new Error(`Invalid purpose: ${purpose}`);
	}
	let url: URL;
	try {
		url = new URL(META_FILES_URL);
	} catch (error) {
		throw new Error(`Invalid Meta Files URL: ${String(error)}`);
	}
	if (!(ALLOWED_META_HOSTS as readonly string[]).includes(url.hostname))
		throw new Error(`Unexpected Files API host: ${url.hostname}`);
	if (purpose) url.searchParams.set("purpose", purpose);
	const res = await fetch(url.toString(), {
		headers: { Authorization: `Bearer ${apiKey}` },
	});
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

// Helper to extract output_text from Responses API response (covers streamed and non-streamed shapes)
function extractResponsesText(json: unknown): string {
	if (!json || typeof json !== "object") return "";
	const j = json as Record<string, unknown>;
	// SDK shape: output_text
	if (typeof j.output_text === "string") return j.output_text;
	// output array
	const output = j.output as unknown;
	if (Array.isArray(output)) {
		const texts: string[] = [];
		for (const item of output as Record<string, unknown>[]) {
			if (!item || typeof item !== "object") continue;
			if (item.type === "message" && Array.isArray(item.content)) {
				for (const c of item.content as Record<string, unknown>[]) {
					if (c.type === "output_text" && typeof c.text === "string")
						texts.push(c.text);
					if (c.type === "refusal" && typeof c.refusal === "string")
						texts.push(c.refusal);
				}
			}
		}
		if (texts.length) return texts.join("\n\n");
	}
	if (typeof j.text === "string") return j.text;
	return JSON.stringify(json, null, 2).slice(0, 8000);
}

async function callMetaResponses(
	apiKey: string,
	payload: Record<string, unknown>,
	signal?: AbortSignal,
): Promise<{ text: string; raw: unknown }> {
	const res = await fetch(responsesUrl(), {
		method: "POST",
		headers: {
			Authorization: `Bearer ${apiKey}`,
			"Content-Type": "application/json",
			"x-api-version": "1.0.0",
		},
		body: JSON.stringify(payload),
		signal,
	});
	const text = await res.text();
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

// ---------------------------------------------------------------------------
// Before-provider-request rewrite (Option B)
// Makes @video.mp4 / @audio.wav / @doc.pdf work transparently even though
// pi-ai's UserMessage is still string | (TextContent | ImageContent)[].
// We smuggle video/audio/pdf as ImageContent (data:video/..., data:audio/..., data:application/pdf...)
// via the input handler or via read tool results; this hook rewrites the
// resulting {type:"input_image", image_url:"data:video/..."} into the correct
// {type:"input_video", video_url:...} / {type:"input_audio", input_audio:{data,format}} /
// {type:"input_file", file_data:...} blocks before the request is sent.
// Also handles https://... video URLs and large inline payloads by uploading via Files API.
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
		// input_video with video_url supports both https and data: URLs per docs
		return { type: "input_video", video_url: url };
	}
	if (isAudioMime(mime) || isHttpsAudio) {
		const data = url.startsWith("data:") ? base64FromDataUrl(url) : url;
		const effectiveMime =
			typeof mime === "string"
				? mime
				: lowerUrl.endsWith(".wav")
					? "audio/wav"
					: "audio/mpeg";
		const format = audioFormatForMime(effectiveMime);
		// Responses API input_audio shape: {type:"input_audio", input_audio:{data, format}}
		if (url.startsWith("data:")) {
			return { type: "input_audio", input_audio: { data, format } };
		}
		// For https audio URL, use input_audio with audio_url-like fallback? Docs: input_audio can be file_id or audio_url data URI or inline.
		// For public https audio, the cleanest is input_audio with audio_url is not documented for responses; use file_url via input_file if needed.
		// Fallback: treat as input_file file_url
		return { type: "input_file", file_url: url };
	}
	if (isPdfMime(mime) || isHttpsPdf) {
		if (url.startsWith("https://")) {
			return { type: "input_file", file_url: url };
		}
		// data:application/pdf;base64,... -> file_data
		return { type: "input_file", file_data: url, filename: "document.pdf" };
	}
	return null;
}

function rewriteResponsesPayload(payload: unknown): {
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

// For large inline data URLs (>50MB) we should upload via Files API instead of sending inline.
// This is async and needs apiKey. We do it lazily in before_provider_request if we can get a key.
// To avoid blocking forever we only upload when we can resolve a key from env or fallback.
async function maybeUploadLargeInlineBlocks(
	payload: unknown,
	apiKey: string | undefined,
): Promise<{ payload: unknown; uploaded: number }> {
	if (!apiKey) return { payload, uploaded: 0 };
	if (!payload || typeof payload !== "object") return { payload, uploaded: 0 };
	const p = payload as Record<string, unknown>;
	const input = p.input;
	if (!Array.isArray(input)) return { payload, uploaded: 0 };
	let uploaded = 0;
	// Need to handle both rewritten and original blocks — check all input_* that carry inline data
	const newInput: unknown[] = [];
	for (const entry of input as Record<string, unknown>[]) {
		if (
			!entry ||
			typeof entry !== "object" ||
			!Array.isArray((entry as Record<string, unknown>).content)
		) {
			newInput.push(entry);
			continue;
		}
		const e = entry as Record<string, unknown>;
		const content = e.content as Record<string, unknown>[];
		const newContent: Record<string, unknown>[] = [];
		for (const block of content) {
			if (
				block.type === "input_video" &&
				typeof block.video_url === "string" &&
				block.video_url.startsWith("data:")
			) {
				const b64 = base64FromDataUrl(block.video_url as string);
				const bytes = Math.floor((b64.length * 3) / 4);
				if (bytes > INLINE_LIMIT_BYTES) {
					// upload: create temp file? Instead, upload directly via fetch with blob
					const mime = mimeForDataUrl(block.video_url as string) ?? "video/mp4";
					const blob = new Blob([Buffer.from(b64, "base64")], { type: mime });
					const form = new FormData();
					form.append(
						"file",
						blob,
						`video${mime === "video/mp4" ? ".mp4" : ""}`,
					);
					form.append("purpose", "user_data");
					const res = await fetch(META_FILES_URL, {
						method: "POST",
						headers: { Authorization: `Bearer ${apiKey}` },
						body: form,
					});
					const text = await res.text();
					if (!res.ok)
						throw new Error(
							`Files upload for large video failed: ${text.slice(0, 500)}`,
						);
					let j: Record<string, unknown>;
					try {
						j = JSON.parse(text) as Record<string, unknown>;
					} catch (error) {
						throw new Error(
							`Files upload returned invalid JSON: ${String(error)}`,
						);
					}
					const id = typeof j.id === "string" ? j.id : "";
					if (!id)
						throw new Error(`Upload returned no id: ${text.slice(0, 500)}`);
					uploaded++;
					newContent.push({ type: "input_file", file_id: id });
					continue;
				}
			}
			if (
				block.type === "input_file" &&
				typeof block.file_data === "string" &&
				block.file_data.startsWith("data:")
			) {
				const b64 = base64FromDataUrl(block.file_data as string);
				const bytes = Math.floor((b64.length * 3) / 4);
				if (bytes > INLINE_LIMIT_BYTES) {
					const mime =
						mimeForDataUrl(block.file_data as string) ??
						"application/octet-stream";
					const blob = new Blob([Buffer.from(b64, "base64")], { type: mime });
					const form = new FormData();
					form.append(
						"file",
						blob,
						`file${extname("file." + (mime.split("/")[1] || ""))}`,
					);
					form.append("purpose", "user_data");
					const res = await fetch(META_FILES_URL, {
						method: "POST",
						headers: { Authorization: `Bearer ${apiKey}` },
						body: form,
					});
					const text = await res.text();
					if (!res.ok)
						throw new Error(
							`Files upload for large file failed: ${text.slice(0, 500)}`,
						);
					let j: Record<string, unknown>;
					try {
						j = JSON.parse(text) as Record<string, unknown>;
					} catch (error) {
						throw new Error(
							`Files upload returned invalid JSON: ${String(error)}`,
						);
					}
					const id = typeof j.id === "string" ? j.id : "";
					if (id) {
						uploaded++;
						newContent.push({ type: "input_file", file_id: id });
						continue;
					}
				}
			}
			if (
				block.type === "input_audio" &&
				block.input_audio &&
				typeof (block.input_audio as Record<string, unknown>).data === "string"
			) {
				const data = (block.input_audio as Record<string, unknown>)
					.data as string;
				const bytes = Math.floor((data.length * 3) / 4);
				if (bytes > INLINE_LIMIT_BYTES) {
					const format = (block.input_audio as Record<string, unknown>)
						.format as string;
					const mime = format === "wav" ? "audio/wav" : "audio/mpeg";
					const blob = new Blob([Buffer.from(data, "base64")], { type: mime });
					const form = new FormData();
					form.append("file", blob, `audio.${format}`);
					form.append("purpose", "user_data");
					const res = await fetch(META_FILES_URL, {
						method: "POST",
						headers: { Authorization: `Bearer ${apiKey}` },
						body: form,
					});
					const text = await res.text();
					if (!res.ok)
						throw new Error(
							`Files upload for large audio failed: ${text.slice(0, 500)}`,
						);
					let j: Record<string, unknown>;
					try {
						j = JSON.parse(text) as Record<string, unknown>;
					} catch (error) {
						throw new Error(
							`Files upload returned invalid JSON: ${String(error)}`,
						);
					}

					const id = typeof j.id === "string" ? j.id : "";
					if (id) {
						uploaded++;
						newContent.push({ type: "input_file", file_id: id });
						continue;
					}
				}
			}
			newContent.push(block);
		}
		newInput.push({ ...e, content: newContent });
	}
	if (uploaded === 0) return { payload, uploaded: 0 };
	return { payload: { ...p, input: newInput }, uploaded };
}

// ---------------------------------------------------------------------------
// Main extension
// ---------------------------------------------------------------------------

export default function metaMedia(pi: ExtensionAPI): void {
	// --- Before provider request rewrite (Option B transparent path) ---
	if (shouldEnableNativeRewrite()) {
		pi.on("before_provider_request", async (event) => {
			const original = event.payload;
			const { rewritten, payload: rewrittenPayload } =
				rewriteResponsesPayload(original);
			if (!rewritten) return undefined;
			// Try to also handle large inline → Files API upload if we can get a key.
			// We attempt to read key from env-adjacent modelRegistry is not available in this event's ctx,
			// so we best-effort fetch from process env or skip.
			// The tool path always uses explicit ctx.modelRegistry, so this is only for @file drag-drop.
			const apiKey =
				process.env.MODEL_API_KEY ?? process.env.META_API_KEY ?? undefined;
			if (apiKey) {
				try {
					const { payload: uploadedPayload } =
						await maybeUploadLargeInlineBlocks(rewrittenPayload, apiKey);
					return uploadedPayload as unknown;
				} catch {
					// fall back to rewritten without upload
					return rewrittenPayload as unknown;
				}
			}
			return rewrittenPayload as unknown;
		});
	}

	// --- Input handler: let @video.mp4 / @audio.wav / @doc.pdf be pasted like @image.png ---
	// Pi's TUI already turns @image.png into ImageContent; for other types event.text still
	// contains the literal path and images is empty. We turn those paths into pseudo-ImageContent
	// so the before_provider_request hook can rewrite them.
	pi.on("input", async (event, ctx) => {
		if (!shouldEnableNativeRewrite()) return undefined;
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
			// For large files (>50MB) we could upload here, but we lack apiKey in input context sometimes.
			// Instead smuggle as data URL and let before_provider_request upload if needed.
			// To avoid OOM on huge files, skip inline if >50MB and notify to use /meta-video which does Files API.
			if (stat.size > INLINE_LIMIT_BYTES) {
				safeNotify(
					ctx,
					`Large file ${basename(absolute)} (${(stat.size / 1_000_000).toFixed(1)} MB) — use /meta-video or /meta-audio for Files API upload (50MB inline limit)`,
					"info",
				);
				continue;
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
			"Analyze an MP4 video with Muse Spark — summarizes visuals and transcribes embedded speech in one call. Provide a local path, public https URL, or existing file_id (from Files API). Handles Files API upload for large files and inline data URLs for small files. Use for: describe what happens in a clip, answer questions about footage, extract structured details. Video without audio (screen recordings) is also valid. Supports 50MB inline, 1GiB via Files API.",
		parameters: Type.Object({
			path: Type.Optional(
				Type.String({
					description:
						"Local .mp4/.m4v file path (relative to cwd or absolute)",
				}),
			),
			url: Type.Optional(
				Type.String({
					description:
						"Public https:// URL or data:video/mp4;base64,... URL (skips upload)",
				}),
			),
			file_id: Type.Optional(
				Type.String({
					description:
						"Existing Files API id like file-842549258569145 (skips upload)",
				}),
			),
			prompt: Type.String({
				description:
					"What to ask about the video (e.g. 'Describe what happens', 'Transcribe speech and list action items')",
			}),
			model: Type.Optional(
				Type.String({ description: "Muse model id, default muse-spark-1.2" }),
			),
			max_output_tokens: Type.Optional(
				Type.Number({
					description:
						"Default 4000 — reasoning shares budget, lower values can return empty with finish_reason:length",
				}),
			),
		}),
		async execute(toolCallId, params, signal, _onUpdate, ctx) {
			const { path, url, file_id, prompt, model, max_output_tokens } =
				params as {
					path?: string;
					url?: string;
					file_id?: string;
					prompt: string;
					model?: string;
					max_output_tokens?: number;
				};
			if (!path && !url && !file_id) {
				return {
					content: [
						{
							type: "text",
							text: "Provide one of: path (local .mp4), url (https://...), or file_id (file-...).",
						},
					],
					details: { error: "missing source" },
				};
			}
			try {
				const apiKey = await safeGetMetaApiKey(
					ctx as unknown as ExtensionContext,
				);
				let videoBlock: ResponsesContentBlock;
				if (file_id) {
					videoBlock = { type: "input_file", file_id };
				} else if (url) {
					videoBlock = { type: "input_video", video_url: url };
				} else if (path) {
					const absolute = resolve(
						(ctx as unknown as { cwd?: string }).cwd ?? process.cwd(),
						path,
					);
					if (!existsSync(absolute))
						throw new Error(`File not found: ${absolute}`);
					const stat = statSync(absolute);
					if (stat.size > FILES_API_LIMIT_BYTES)
						throw new Error(`File too large (1 GiB limit): ${path}`);
					if (stat.size > INLINE_LIMIT_BYTES) {
						const up = await uploadMetaFile(apiKey, absolute);
						videoBlock = { type: "input_file", file_id: up.id };
					} else {
						const { dataUrl } = dataUrlForFile(absolute);
						// Prefer input_file with file_data for small inline? Docs show input_file file_data and input_video video_url both work.
						// Use input_video with data URL for clarity.
						videoBlock = { type: "input_video", video_url: dataUrl };
					}
				} else {
					throw new Error("No source");
				}
				const payload: Record<string, unknown> = {
					model: model ?? "muse-spark-1.2",
					input: [
						{
							type: "message",
							role: "user",
							content: [
								{ type: "input_text", text: prompt },
								videoBlock as unknown as Record<string, unknown>,
							],
						},
					],
					max_output_tokens: Math.max(max_output_tokens ?? 4000, 4000),
				};
				const { text, raw } = await callMetaResponses(apiKey, payload, signal);
				return {
					content: [{ type: "text", text }],
					details: { raw, videoBlock },
				};
			} catch (e) {
				return {
					content: [
						{
							type: "text",
							text: `Video analysis failed: ${e instanceof Error ? e.message : String(e)}`,
						},
					],
					details: { error: String(e) },
				};
			}
		},
	});

	pi.registerTool({
		name: "meta_transcribe_audio",
		label: "Meta Audio Transcribe",
		description:
			"Transcribe speech from a standalone audio file (wav, mp3) via Muse Spark. Provide local path, public URL, or file_id. Handles Files API for large files, inline base64 for small. Tip: always use max_output_tokens ≥4000 and stream for long clips to avoid empty length finish.",
		parameters: Type.Object({
			path: Type.Optional(Type.String({ description: "Local .wav/.mp3 path" })),
			url: Type.Optional(
				Type.String({ description: "Public https:// URL to audio" }),
			),
			file_id: Type.Optional(Type.String({ description: "Existing file_id" })),
			prompt: Type.Optional(
				Type.String({
					description:
						"Custom prompt, default 'Transcribe this audio. Return only the transcript.'",
				}),
			),
			model: Type.Optional(
				Type.String({ description: "Model id, default muse-spark-1.2" }),
			),
		}),
		async execute(toolCallId, params, signal, _onUpdate, ctx) {
			const { path, url, file_id, prompt, model } = params as {
				path?: string;
				url?: string;
				file_id?: string;
				prompt?: string;
				model?: string;
			};
			if (!path && !url && !file_id) {
				return {
					content: [
						{ type: "text", text: "Provide path, url, or file_id for audio." },
					],
					details: { error: "missing source" },
				};
			}
			try {
				const apiKey = await safeGetMetaApiKey(
					ctx as unknown as ExtensionContext,
				);
				let audioBlock: ResponsesContentBlock;
				if (file_id) {
					audioBlock = { type: "input_file", file_id };
				} else if (url) {
					// For URLs, use input_audio with audio_url? Docs show Responses accepts input_audio with file_id or inline; for URL use input_file file_url as fallback.
					// Prefer input_file file_url for public audio URL.
					audioBlock = { type: "input_file", file_url: url };
				} else if (path) {
					const absolute = resolve(
						(ctx as unknown as { cwd?: string }).cwd ?? process.cwd(),
						path,
					);
					if (!existsSync(absolute))
						throw new Error(`File not found: ${absolute}`);
					const stat = statSync(absolute);
					if (stat.size > FILES_API_LIMIT_BYTES)
						throw new Error(`Audio too large (1 GiB limit)`);
					const mime = mimeForPath(absolute);
					if (!isAudioMime(mime) && mime !== undefined) {
						throw new Error(
							`Unsupported audio mime ${mime}, need audio/wav or audio/mpeg`,
						);
					}
					if (stat.size > INLINE_LIMIT_BYTES) {
						const up = await uploadMetaFile(apiKey, absolute);
						audioBlock = { type: "input_file", file_id: up.id };
					} else {
						const data = readFileSync(absolute).toString("base64");
						const effectiveMime = typeof mime === "string" ? mime : "audio/wav";
						const fmt = audioFormatForMime(effectiveMime);
						audioBlock = {
							type: "input_audio",
							input_audio: { data, format: fmt },
						};
					}
				} else {
					throw new Error("No audio source");
				}
				const payload: Record<string, unknown> = {
					model: model ?? "muse-spark-1.2",
					input: [
						{
							type: "message",
							role: "user",
							content: [
								{
									type: "input_text",
									text:
										prompt ??
										"Transcribe this audio. Return only the transcript.",
								},
								audioBlock as unknown as Record<string, unknown>,
							],
						},
					],
					max_output_tokens: 4000,
				};
				const { text, raw } = await callMetaResponses(apiKey, payload, signal);
				return {
					content: [{ type: "text", text }],
					details: { raw, audioBlock },
				};
			} catch (e) {
				return {
					content: [
						{
							type: "text",
							text: `Audio transcription failed: ${e instanceof Error ? e.message : String(e)}`,
						},
					],
					details: { error: String(e) },
				};
			}
		},
	});

	pi.registerTool({
		name: "meta_upload_file",
		label: "Meta Files Upload",
		description:
			"Upload a file to Meta Files API (POST /v1/files purpose=user_data) for reuse across video/image/pdf/audio requests. Returns file_id to use with input_file/file_id. Supports 1 GiB limit, 100 GiB/team storage. Set expires_after for auto-expiry (3600..2592000 seconds). Use for large or reused files; small one-offs can use inline data URLs.",
		parameters: Type.Object({
			path: Type.String({
				description:
					"Local file path to upload (mp4, wav, mp3, pdf, png, jpg, etc.)",
			}),
			expires_after_seconds: Type.Optional(
				Type.Number({
					description:
						"Auto-expire after seconds (3600..2592000), default no expiry",
				}),
			),
		}),
		async execute(toolCallId, params, signal, _onUpdate, ctx) {
			const { path, expires_after_seconds } = params as {
				path: string;
				expires_after_seconds?: number;
			};
			try {
				const apiKey = await safeGetMetaApiKey(
					ctx as unknown as ExtensionContext,
				);
				const absolute = resolve(
					(ctx as unknown as { cwd?: string }).cwd ?? process.cwd(),
					path,
				);
				if (!existsSync(absolute))
					throw new Error(`File not found: ${absolute}`);
				let expiresAfter: { anchor: "created_at"; seconds: number } | undefined;
				if (expires_after_seconds !== undefined) {
					if (expires_after_seconds < 3600 || expires_after_seconds > 2592000)
						throw new Error("expires_after_seconds must be 3600..2592000");
					expiresAfter = {
						anchor: "created_at",
						seconds: expires_after_seconds,
					};
				}
				const result = await uploadMetaFile(apiKey, absolute, expiresAfter);
				return {
					content: [
						{
							type: "text",
							text: `Uploaded ${basename(absolute)} → ${result.id} (${result.bytes} bytes, status: ${result.status}${result.expires_at ? `, expires_at: ${result.expires_at}` : ""}). Use with {type:"input_file", file_id:"${result.id}"} or {type:"input_video", file_id} etc.`,
						},
					],
					details: result,
				};
			} catch (e) {
				return {
					content: [
						{
							type: "text",
							text: `Upload failed: ${e instanceof Error ? e.message : String(e)}`,
						},
					],
					details: { error: String(e) },
				};
			}
		},
	});

	pi.registerTool({
		name: "meta_analyze_file",
		label: "Meta File Analyze",
		description:
			"Analyze any supported file (image, pdf, video, audio) via Muse Spark using the Files API or inline. PDFs: text first 100 pages + images first 50 pages (counts to 50-image budget). Images: up to 50/request. For generic 'summarize this document' use this; for video/audio with specific prompts use the dedicated video/audio tools.",
		parameters: Type.Object({
			path: Type.Optional(Type.String({ description: "Local file path" })),
			url: Type.Optional(Type.String({ description: "Public https:// URL" })),
			file_id: Type.Optional(Type.String({ description: "Existing file_id" })),
			prompt: Type.String({ description: "What to ask about the file" }),
			model: Type.Optional(
				Type.String({ description: "Model id, default muse-spark-1.2" }),
			),
		}),
		async execute(toolCallId, params, signal, _onUpdate, ctx) {
			const { path, url, file_id, prompt, model } = params as {
				path?: string;
				url?: string;
				file_id?: string;
				prompt: string;
				model?: string;
			};
			if (!path && !url && !file_id) {
				return {
					content: [{ type: "text", text: "Provide path, url, or file_id." }],
					details: { error: "missing source" },
				};
			}
			try {
				const apiKey = await safeGetMetaApiKey(
					ctx as unknown as ExtensionContext,
				);
				let fileBlock: ResponsesContentBlock;
				if (file_id) fileBlock = { type: "input_file", file_id };
				else if (url) fileBlock = { type: "input_file", file_url: url };
				else if (path) {
					const absolute = resolve(
						(ctx as unknown as { cwd?: string }).cwd ?? process.cwd(),
						path,
					);
					if (!existsSync(absolute))
						throw new Error(`File not found: ${absolute}`);
					const stat = statSync(absolute);
					if (stat.size > FILES_API_LIMIT_BYTES)
						throw new Error(`File too large (1 GiB limit)`);
					if (stat.size > INLINE_LIMIT_BYTES) {
						const up = await uploadMetaFile(apiKey, absolute);
						fileBlock = { type: "input_file", file_id: up.id };
					} else {
						const { dataUrl, mime } = dataUrlForFile(absolute);
						const filename = basename(absolute);
						// Responses API inline: {type:"input_file", file_data, filename}
						fileBlock = { type: "input_file", file_data: dataUrl, filename };
					}
				} else throw new Error("No source");
				const payload: Record<string, unknown> = {
					model: model ?? "muse-spark-1.2",
					input: [
						{
							type: "message",
							role: "user",
							content: [
								{ type: "input_text", text: prompt },
								fileBlock as unknown as Record<string, unknown>,
							],
						},
					],
					max_output_tokens: 4000,
				};
				const { text, raw } = await callMetaResponses(apiKey, payload, signal);
				return {
					content: [{ type: "text", text }],
					details: { raw, fileBlock },
				};
			} catch (e) {
				return {
					content: [
						{
							type: "text",
							text: `File analysis failed: ${e instanceof Error ? e.message : String(e)}`,
						},
					],
					details: { error: String(e) },
				};
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
					? "Describe what happens in this video. Transcribe any speech."
					: trimmed.slice(firstSpace + 1).trim() ||
						"Describe what happens in this video.";
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
				else if (isUrl) block = { type: "input_video", video_url: source };
				else {
					const abs = resolve(cwd, source);
					if (!existsSync(abs)) throw new Error(`File not found: ${abs}`);
					const stat = statSync(abs);
					if (stat.size > INLINE_LIMIT_BYTES) {
						const up = await uploadMetaFile(apiKey, abs);
						block = { type: "input_file", file_id: up.id };
					} else {
						const { dataUrl } = dataUrlForFile(abs);
						block = { type: "input_video", video_url: dataUrl };
					}
				}
				const { text } = await callMetaResponses(apiKey, {
					model: "muse-spark-1.2",
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
				else if (isUrl) block = { type: "input_file", file_url: source };
				else {
					const abs = resolve(cwd, source);
					if (!existsSync(abs)) throw new Error(`File not found: ${abs}`);
					const stat = statSync(abs);
					if (stat.size > INLINE_LIMIT_BYTES) {
						const up = await uploadMetaFile(apiKey, abs);
						block = { type: "input_file", file_id: up.id };
					} else {
						const data = readFileSync(abs).toString("base64");
						const mime = mimeForPath(abs) ?? "audio/wav";
						block = {
							type: "input_audio",
							input_audio: { data, format: audioFormatForMime(mime) },
						};
					}
				}
				const { text } = await callMetaResponses(apiKey, {
					model: "muse-spark-1.2",
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
				else if (isUrl) block = { type: "input_file", file_url: source };
				else {
					const abs = resolve(cwd, source);
					if (!existsSync(abs)) throw new Error(`File not found: ${abs}`);
					const stat = statSync(abs);
					if (stat.size > INLINE_LIMIT_BYTES) {
						const up = await uploadMetaFile(apiKey, abs);
						block = { type: "input_file", file_id: up.id };
					} else {
						const { dataUrl } = dataUrlForFile(abs);
						block = {
							type: "input_file",
							file_data: dataUrl,
							filename: basename(abs),
						};
					}
				}
				const { text } = await callMetaResponses(apiKey, {
					model: "muse-spark-1.2",
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
