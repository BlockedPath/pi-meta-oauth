import { extname } from "node:path";

export interface ResponsesContentBlock {
	type: string;
	[key: string]: unknown;
}

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

export function mimeForPath(path: string): SupportedMime | undefined {
	const ext = extname(path).toLowerCase();
	return EXT_TO_MIME[ext];
}

export function mimeForDataUrl(dataUrl: string): string | undefined {
	const m = dataUrl.match(/^data:([^;,\s]+)[;,]/);
	return m?.[1]?.toLowerCase();
}

export function isVideoMime(m: string | undefined): boolean {
	return m === "video/mp4";
}

export function isAudioMime(m: string | undefined): boolean {
	return (
		m === "audio/mpeg" ||
		m === "audio/mp3" ||
		m === "audio/wav" ||
		m === "audio/x-wav"
	);
}

export function isPdfMime(m: string | undefined): boolean {
	return m === "application/pdf";
}

export function isImageMime(m: string | undefined): boolean {
	return typeof m === "string" && m.startsWith("image/");
}

export function filenameForMime(
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

export function audioFormatForMime(mime: string | undefined): "wav" | "mp3" {
	return mime === "audio/wav" || mime === "audio/x-wav" ? "wav" : "mp3";
}

export function base64FromDataUrl(dataUrl: string): string {
	const comma = dataUrl.indexOf(",");
	return comma === -1 ? "" : dataUrl.slice(comma + 1);
}

export function base64ByteLength(base64: string): number {
	const normalized = base64.replace(/\s/g, "");
	if (!normalized) return 0;
	const padding = normalized.endsWith("==")
		? 2
		: normalized.endsWith("=")
			? 1
			: 0;
	return Math.max(0, Math.floor((normalized.length * 3) / 4) - padding);
}

export function isRemoteMediaSource(source: string): boolean {
	return source.startsWith("https://") || source.startsWith("data:");
}

export function mediaPathFromUrl(url: string): string {
	if (url.startsWith("data:")) return url;
	try {
		return new URL(url).pathname;
	} catch {
		const withoutHash = url.split("#")[0] ?? url;
		return withoutHash.split("?")[0] ?? withoutHash;
	}
}

export function mimeForSource(source: string): string | undefined {
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

/** Build a generic Meta Responses input_file block. */
export function inputFileFromSource(
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
	return { type: "input_file", file_id: source };
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
