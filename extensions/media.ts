import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { META_PROVIDER_ID } from "./meta.ts";
import { existsSync, statSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import {
	DEFAULT_MEDIA_MAX_CHARS,
	DEFAULT_MEDIA_MAX_OUTPUT_TOKENS,
	MAX_MEDIA_MAX_CHARS,
	MAX_MEDIA_MAX_OUTPUT_TOKENS,
	MIN_MEDIA_MAX_OUTPUT_TOKENS,
	mediaMaxOutputTokens,
	prepareMediaOutput,
} from "./media-output.ts";
import {
	AUTOMATIC_UPLOAD_EXPIRY_SECONDS,
	EXPLICIT_UPLOAD_EXPIRY_SECONDS,
	FILES_API_LIMIT_BYTES,
	INLINE_LIMIT_BYTES,
	MAX_ANALYSIS_SOURCES,
	MAX_UPLOAD_EXPIRY_SECONDS,
	MIN_UPLOAD_EXPIRY_SECONDS,
	STORE_SAFE_INLINE_BYTES,
} from "./media/limits.ts";
import {
	base64FromDataUrl,
	isAudioMime,
	isRemoteMediaSource,
	isVideoMime,
	mediaInputFromSource,
	mimeForPath,
	mimeForSource,
	type ResponsesContentBlock,
} from "./media/mime.ts";
import { uploadMetaFile } from "./media/files.ts";
import {
	maybeUploadLargeInlineBlocks,
	payloadContainsMedia,
	rewriteResponsesPayload,
} from "./media/payload.ts";
import {
	callMetaResponses,
	extractMetaResponseUsage,
	formatMetaResponseUsage,
} from "./media/responses.ts";

export { mediaInputFromSource } from "./media/mime.ts";
export { maybeUploadLargeInlineBlocks, rewriteResponsesPayload } from "./media/payload.ts";
export {
	extractMetaResponseUsage,
	extractResponsesText,
	formatMetaResponseUsage,
} from "./media/responses.ts";

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

async function getMetaApiKey(ctx: ExtensionContext): Promise<string> {
	const key = await ctx.modelRegistry.getApiKeyForProvider(META_PROVIDER_ID);
	if (!key) {
		throw new Error(
			`Meta credentials unavailable — run /login ${META_PROVIDER_ID}`,
		);
	}
	return key;
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

function sourceLabel(source: AnalysisSource, index: number): string {
	return source.label?.trim() || `Source ${index + 1}`;
}

async function resolveGenericMediaSource(
	apiKey: string,
	cwd: string,
	source: string,
	signal?: AbortSignal,
): Promise<ResponsesContentBlock> {
	if (/^file-[a-zA-Z0-9_-]+$/.test(source)) {
		return { type: "input_file", file_id: source };
	}
	if (isRemoteMediaSource(source)) {
		return mediaInputFromSource(source);
	}
	const absolute = resolve(cwd, source.replace(/^@/, ""));
	if (!existsSync(absolute)) throw new Error(`File not found: ${absolute}`);
	const stat = statSync(absolute);
	if (stat.size > FILES_API_LIMIT_BYTES) {
		throw new Error(`File too large (1 GiB limit): ${source}`);
	}
	if (stat.size > STORE_SAFE_INLINE_BYTES) {
		const upload = await uploadMetaFile(
			apiKey,
			absolute,
			automaticExpiry(),
			signal,
		);
		return { type: "input_file", file_id: upload.id };
	}
	const { dataUrl, mime } = dataUrlForFile(absolute);
	return mediaInputFromSource(dataUrl, basename(absolute), mime);
}

function shouldEnableNativeRewrite(): boolean {
	const v =
		process.env.PI_META_NATIVE_ATTACHMENTS ?? process.env.PI_META_MEDIA_NATIVE;
	if (v === undefined) return true;
	return v !== "0" && v.toLowerCase() !== "false" && v.toLowerCase() !== "off";
}

function rejectWrongMime(
	kind: "video" | "audio",
	source: string,
	mime: string | undefined,
): void {
	if (!mime) return;
	if (kind === "video" && !isVideoMime(mime)) {
		throw new Error(`Unsupported video type for ${source}; use MP4`);
	}
	if (kind === "audio" && !isAudioMime(mime)) {
		throw new Error(`Unsupported audio type for ${source}; use MP3 or WAV`);
	}
}

function isFileId(source: string): boolean {
	return source.startsWith("file-");
}

export default function metaMedia(pi: ExtensionAPI): void {
	if (shouldEnableNativeRewrite()) {
		pi.on("before_provider_request", async (event, ctx) => {
			if (ctx.model?.provider !== META_PROVIDER_ID) return undefined;
			const original = event.payload as Record<string, unknown>;
			const { rewritten, payload: rewrittenPayload } =
				rewriteResponsesPayload(original);
			const payloadToCheck = rewritten ? rewrittenPayload : original;
			if (!rewritten && !payloadContainsMedia(payloadToCheck)) return undefined;
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
						await maybeUploadLargeInlineBlocks(
							payloadToCheck,
							apiKey,
							STORE_SAFE_INLINE_BYTES,
							ctx.signal,
						);
					return uploadedPayload as unknown;
				} catch {
					const fallback = payloadToCheck as Record<string, unknown>;
					return { ...fallback, store: false } as unknown;
				}
			}
			return {
				...(payloadToCheck as Record<string, unknown>),
				store: false,
			} as unknown;
		});
	}

	pi.on("input", async (event, ctx) => {
		if (!shouldEnableNativeRewrite()) return undefined;
		if (ctx.model?.provider !== META_PROVIDER_ID) return undefined;
		const text = event.text ?? "";
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
			if (stat.size > STORE_SAFE_INLINE_BYTES) {
				if (stat.size > INLINE_LIMIT_BYTES) {
					safeNotify(
						ctx,
						`Large file ${basename(absolute)} (${(stat.size / 1_000_000).toFixed(1)} MB) — use /meta-video or /meta-audio for Files API upload (50MB inline / 15MB store-safe limit)`,
						"info",
					);
					continue;
				}
			}
			try {
				const { dataUrl } = dataUrlForFile(absolute);
				const b64 = base64FromDataUrl(dataUrl);
				newImages.push({ type: "image", data: b64, mimeType: mime });
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
				else if (url) {
					rejectWrongMime("video", url, mimeForSource(url));
					videoBlock = mediaInputFromSource(url, "video.mp4", "video/mp4");
				} else {
					const absolute = resolve(ctx.cwd, path as string);
					if (!existsSync(absolute)) throw new Error(`File not found: ${absolute}`);
					const stat = statSync(absolute);
					if (stat.size > FILES_API_LIMIT_BYTES) throw new Error(`File too large (1 GiB limit): ${path}`);
					rejectWrongMime("video", path as string, mimeForPath(absolute));
					if (stat.size > STORE_SAFE_INLINE_BYTES) {
						const upload = await uploadMetaFile(apiKey, absolute, automaticExpiry(), signal);
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
				else if (url) {
					rejectWrongMime("audio", url, mimeForSource(url));
					audioBlock = mediaInputFromSource(url, "audio.bin");
				} else {
					const absolute = resolve(ctx.cwd, path as string);
					if (!existsSync(absolute)) throw new Error(`File not found: ${absolute}`);
					const stat = statSync(absolute);
					if (stat.size > FILES_API_LIMIT_BYTES) throw new Error("Audio too large (1 GiB limit)");
					const mime = mimeForPath(absolute);
					rejectWrongMime("audio", path as string, mime);
					if (stat.size > STORE_SAFE_INLINE_BYTES) {
						const upload = await uploadMetaFile(apiKey, absolute, automaticExpiry(), signal);
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
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
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
				const result = await uploadMetaFile(apiKey, absolute, expiresAfter, signal);
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
					content.push(await resolveGenericMediaSource(apiKey, ctx.cwd, item.source, signal));
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
			try {
				const apiKey = await safeGetMetaApiKey(ctx as unknown as ExtensionContext);
				let block: ResponsesContentBlock;
				if (isFileId(source)) block = { type: "input_file", file_id: source };
				else if (isRemoteMediaSource(source))
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
				safeNotify(ctx, "Usage: /meta-audio <path|url|file_id> [prompt]", "info");
				return;
			}
			const firstSpace = trimmed.indexOf(" ");
			const source = firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace);
			const prompt =
				firstSpace === -1
					? "Transcribe this audio. Return only the transcript."
					: trimmed.slice(firstSpace + 1).trim() ||
						"Transcribe this audio. Return only the transcript.";
			try {
				const apiKey = await safeGetMetaApiKey(ctx as unknown as ExtensionContext);
				let block: ResponsesContentBlock;
				if (isFileId(source)) block = { type: "input_file", file_id: source };
				else if (isRemoteMediaSource(source))
					block = mediaInputFromSource(source, "audio.bin");
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
				safeNotify(ctx, "Usage: /meta-file <path|url|file_id> <prompt>", "info");
				return;
			}
			const firstSpace = trimmed.indexOf(" ");
			if (firstSpace === -1) {
				safeNotify(ctx, "Provide a prompt after the file source.", "warning");
				return;
			}
			const source = trimmed.slice(0, firstSpace);
			const prompt = trimmed.slice(firstSpace + 1).trim();
			try {
				const apiKey = await safeGetMetaApiKey(ctx as unknown as ExtensionContext);
				let block: ResponsesContentBlock;
				if (isFileId(source)) block = { type: "input_file", file_id: source };
				else if (isRemoteMediaSource(source))
					block = mediaInputFromSource(source);
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
