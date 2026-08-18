const DEFAULT_ASR_ENDPOINT =
	"wss://shortwave.facebook.com/voyager/v1/asr/duplex";
export const DEFAULT_ASR_MODEL = "prod_tbh";

export function pcmAudioLevel(chunk: Buffer): number {
	if (chunk.length < 2) return 0;
	let sumSquares = 0;
	let samples = 0;
	for (let offset = 0; offset + 1 < chunk.length; offset += 2) {
		const normalized = chunk.readInt16LE(offset) / 32_768;
		sumSquares += normalized * normalized;
		samples += 1;
	}
	if (samples === 0) return 0;
	const rms = Math.sqrt(sumSquares / samples);
	return Math.min(1, Math.log10(1 + rms * 90));
}

function hypothesisWords(value: string): string[] {
	return value
		.trim()
		.split(/\s+/)
		.map((word) => word.toLocaleLowerCase().replace(/[^\p{L}\p{N}'’]/gu, ""))
		.filter(Boolean);
}

export function chooseTranscript(previous: string, incoming: string): string {
	const next = incoming.trim();
	if (!next) return previous;
	if (!previous.trim()) return next;

	const previousWords = hypothesisWords(previous);
	const nextWords = hypothesisWords(next);
	const sharedLength = Math.min(previousWords.length, nextWords.length);
	let commonPrefix = 0;
	while (
		commonPrefix < sharedLength &&
		previousWords[commonPrefix] === nextWords[commonPrefix]
	) {
		commonPrefix += 1;
	}

	if (commonPrefix === sharedLength || commonPrefix >= 2) {
		const isRegression =
			nextWords.length < previousWords.length &&
			nextWords.every((word, index) => previousWords[index] === word);
		return isRegression ? previous : next;
	}
	return next.length >= previous.length ? next : previous;
}

export function formatAuthorization(apiKey: string): string {
	return apiKey.startsWith("OAuth ") ? apiKey : `OAuth ${apiKey}`;
}

export function asrModel(): string {
	return (
		process.env.PI_META_VOICE_ASR_MODEL ??
		process.env.MUSE_VOICE_ASR_MODEL ??
		DEFAULT_ASR_MODEL
	);
}

export function asrHandshake(apiKey: string): {
	mode: "DEFAULT";
	authorization: { accessToken: string };
	audioEncoding: "PCM_16KHZ";
	model: string;
} {
	return {
		mode: "DEFAULT",
		authorization: { accessToken: formatAuthorization(apiKey) },
		audioEncoding: "PCM_16KHZ",
		model: asrModel(),
	};
}

export function asrEndpoint(sessionId: string): string {
	const configured =
		process.env.PI_META_VOICE_ASR_ENDPOINT ??
		process.env.MUSE_VOICE_ASR_ENDPOINT ??
		DEFAULT_ASR_ENDPOINT;
	let endpoint: URL;
	try {
		endpoint = new URL(configured);
	} catch {
		throw new Error("Voice ASR endpoint is not a valid URL");
	}
	const localInsecureEndpoint =
		endpoint.protocol === "ws:" &&
		(endpoint.hostname === "localhost" || endpoint.hostname === "127.0.0.1");
	if (endpoint.protocol !== "wss:" && !localInsecureEndpoint) {
		throw new Error(
			"Voice ASR endpoint must use wss:// (or ws://localhost for testing)",
		);
	}
	endpoint.searchParams.set("sessionId", sessionId);
	return endpoint.toString();
}

export async function socketMessageText(
	data: unknown,
): Promise<string | undefined> {
	if (typeof data === "string") return data;
	if (data instanceof Blob) return data.text();
	if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
	if (ArrayBuffer.isView(data)) {
		return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString(
			"utf8",
		);
	}
	return undefined;
}

export function parseJsonObject(
	text: string,
): Record<string, unknown> | undefined {
	try {
		const value = JSON.parse(text) as unknown;
		if (value && typeof value === "object" && !Array.isArray(value)) {
			return value as Record<string, unknown>;
		}
	} catch {
		// Ignore non-JSON ASR messages.
	}
	return undefined;
}

export function isNormalSocketClose(code: number): boolean {
	return code === 1000 || code === 1005;
}
