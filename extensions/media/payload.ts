import { STORE_SAFE_INLINE_BYTES } from "./limits.ts";
import { uploadInlineMedia } from "./files.ts";
import {
	base64ByteLength,
	base64FromDataUrl,
	filenameForMime,
	isAudioMime,
	isImageMime,
	isPdfMime,
	isVideoMime,
	mediaInputFromSource,
	mediaPathFromUrl,
	mimeForDataUrl,
} from "./mime.ts";

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object"
		? (value as Record<string, unknown>)
		: undefined;
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
	const lowerPath = mediaPathFromUrl(url).toLowerCase();
	const isHttps = url.startsWith("https://");
	const isHttpsVideo =
		isHttps && (lowerPath.endsWith(".mp4") || lowerPath.endsWith(".m4v"));
	const isHttpsAudio =
		isHttps && (lowerPath.endsWith(".mp3") || lowerPath.endsWith(".wav"));
	const isHttpsPdf = isHttps && lowerPath.endsWith(".pdf");
	const isHttpsImage =
		isHttps &&
		(lowerPath.endsWith(".png") ||
			lowerPath.endsWith(".jpg") ||
			lowerPath.endsWith(".jpeg") ||
			lowerPath.endsWith(".gif") ||
			lowerPath.endsWith(".webp"));

	if (isHttpsImage || isImageMime(mime)) return null;

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
				: lowerPath.endsWith(".wav")
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

function rewriteBlocks(
	blocks: Record<string, unknown>[],
	onlyImageUrls = false,
): { blocks: Record<string, unknown>[]; rewritten: boolean } {
	let rewritten = false;
	const next = blocks.map((block) => {
		if (
			onlyImageUrls &&
			!(block.type === "input_image" && typeof block.image_url === "string")
		) {
			return block;
		}
		const replacement = rewriteBlock(block);
		if (replacement) {
			rewritten = true;
			return replacement;
		}
		return block;
	});
	return { blocks: next, rewritten };
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
		const e = { ...(entry as Record<string, unknown>) };
		if (Array.isArray(e.content)) {
			const result = rewriteBlocks(e.content as Record<string, unknown>[]);
			if (result.rewritten) {
				rewritten = true;
				e.content = result.blocks;
			}
		}
		if (
			(e.type === "function_call_output" ||
				e.type === "custom_tool_call_output") &&
			Array.isArray(e.output)
		) {
			const result = rewriteBlocks(
				e.output as Record<string, unknown>[],
				true,
			);
			if (result.rewritten) {
				rewritten = true;
				e.output = result.blocks;
			}
		}
		return e;
	});
	if (!rewritten) return { rewritten: false, payload };
	return { rewritten: true, payload: { ...p, input: newInput } };
}

function inlineFromBlock(
	block: Record<string, unknown>,
): { base64: string; mime: string; filename: string } | undefined {
	if (
		block.type === "input_video" &&
		typeof block.video_url === "string" &&
		block.video_url.startsWith("data:")
	) {
		return {
			base64: base64FromDataUrl(block.video_url),
			mime: mimeForDataUrl(block.video_url) ?? "video/mp4",
			filename: "video.mp4",
		};
	}
	if (block.type === "input_audio") {
		const audio = record(block.input_audio);
		if (typeof audio?.data === "string") {
			const format = audio.format === "wav" ? "wav" : "mp3";
			return {
				base64: audio.data.startsWith("data:")
					? base64FromDataUrl(audio.data)
					: audio.data,
				mime: format === "wav" ? "audio/wav" : "audio/mpeg",
				filename: `audio.${format}`,
			};
		}
	}
	if (
		block.type === "input_file" &&
		typeof block.file_data === "string" &&
		block.file_data.startsWith("data:")
	) {
		const mime = mimeForDataUrl(block.file_data) ?? "application/octet-stream";
		return {
			base64: base64FromDataUrl(block.file_data),
			mime,
			filename:
				typeof block.filename === "string" && block.filename
					? block.filename
					: filenameForMime(mime),
		};
	}
	if (
		block.type === "input_image" &&
		typeof block.image_url === "string" &&
		block.image_url.startsWith("data:")
	) {
		const mime = mimeForDataUrl(block.image_url) ?? "image/png";
		return {
			base64: base64FromDataUrl(block.image_url),
			mime,
			filename: filenameForMime(mime, "image.bin"),
		};
	}
	return undefined;
}

function isMediaBlock(block: Record<string, unknown>): boolean {
	return (
		block.type === "input_file" ||
		block.type === "input_image" ||
		block.type === "input_video" ||
		block.type === "input_audio"
	);
}

export function payloadContainsMedia(payload: unknown): boolean {
	if (!payload || typeof payload !== "object") return false;
	const input = (payload as Record<string, unknown>).input;
	if (!Array.isArray(input)) return false;
	for (const entry of input as Record<string, unknown>[]) {
		if (!entry || typeof entry !== "object") continue;
		const groups = [entry.content, entry.output];
		for (const group of groups) {
			if (!Array.isArray(group)) continue;
			for (const block of group as Record<string, unknown>[]) {
				if (block && typeof block === "object" && isMediaBlock(block))
					return true;
			}
		}
	}
	return false;
}

async function promoteBlocks(
	blocks: Record<string, unknown>[],
	apiKey: string,
	uploadThresholdBytes: number,
	signal?: AbortSignal,
): Promise<{
	blocks: Record<string, unknown>[];
	uploaded: number;
	needsStoreFalse: boolean;
}> {
	let uploaded = 0;
	let needsStoreFalse = false;
	const next: Record<string, unknown>[] = [];
	for (const block of blocks) {
		const inline = inlineFromBlock(block);
		if (inline) {
			needsStoreFalse = true;
			if (base64ByteLength(inline.base64) > uploadThresholdBytes) {
				const id = await uploadInlineMedia(
					apiKey,
					inline.base64,
					inline.mime,
					inline.filename,
					signal,
				);
				uploaded += 1;
				next.push({ type: "input_file", file_id: id });
				continue;
			}
		} else if (isMediaBlock(block)) {
			needsStoreFalse = true;
		}
		next.push(block);
	}
	return { blocks: next, uploaded, needsStoreFalse };
}

export async function maybeUploadLargeInlineBlocks(
	payload: unknown,
	apiKey: string | undefined,
	uploadThresholdBytes = STORE_SAFE_INLINE_BYTES,
	signal?: AbortSignal,
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
		if (!entry || typeof entry !== "object") {
			newInput.push(entry);
			continue;
		}
		const nextEntry = { ...entry };
		for (const key of ["content", "output"] as const) {
			if (!Array.isArray(nextEntry[key])) continue;
			const promoted = await promoteBlocks(
				nextEntry[key] as Record<string, unknown>[],
				apiKey,
				uploadThresholdBytes,
				signal,
			);
			nextEntry[key] = promoted.blocks;
			uploaded += promoted.uploaded;
			needsStoreFalse ||= promoted.needsStoreFalse;
		}
		newInput.push(nextEntry);
	}

	if (!needsStoreFalse && uploaded === 0) return { payload, uploaded: 0 };
	return {
		payload: { ...p, input: newInput, store: false },
		uploaded,
	};
}
