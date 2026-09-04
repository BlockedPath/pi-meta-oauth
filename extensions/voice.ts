import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { META_PROVIDER_ID } from "./meta.ts";
import { isKeyRelease, isKeyRepeat, matchesKey } from "@earendil-works/pi-tui";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	asrEndpoint,
	asrHandshake,
	chooseTranscript,
	isNormalSocketClose,
	parseJsonObject,
	pcmAudioLevel,
	socketMessageText,
} from "./voice/asr.ts";
import {
	ensureHelper,
	isSupportedPlatform,
	supportedPlatformLabel,
} from "./voice/helpers.ts";

export {
	asrEndpoint,
	asrHandshake,
	formatAuthorization,
	pcmAudioLevel,
} from "./voice/asr.ts";

const AGENT_DIR = join(homedir(), ".pi/agent");
const SETTINGS_FILE = join(AGENT_DIR, "pi-meta-oauth-voice.json");
const AUDIO_FRAME_BYTES = 3_200;
const ASR_PREBUFFER_FRAMES = 6;
const MAX_QUEUED_AUDIO_BYTES = 2 * 1024 * 1024;
const TRAILING_SILENCE_FRAMES = 6;
const MAX_RECORDING_MS = 2 * 60 * 1_000;
const FINAL_TRANSCRIPT_TIMEOUT_MS = 6_000;

type Settings = { enabled: boolean };
type VoicePhase = "idle" | "preparing" | "recording" | "stopping";
type HelperEvent = Record<string, unknown> & { type?: string };
type AsrTranscript = {
	transcript?: unknown;
	final?: unknown;
};

function loadSettings(): Settings {
	if (existsSync(SETTINGS_FILE)) {
		try {
			const value = JSON.parse(readFileSync(SETTINGS_FILE, "utf8")) as {
				enabled?: unknown;
			};
			if (typeof value.enabled === "boolean") return { enabled: value.enabled };
		} catch {
			// Fall through to the platform default.
		}
	}
	return { enabled: isSupportedPlatform() };
}

function saveSettings(settings: Settings): void {
	mkdirSync(AGENT_DIR, { recursive: true });
	writeFileSync(SETTINGS_FILE, `${JSON.stringify(settings, null, 2)}\n`);
}

function combineEditorText(original: string, transcript: string): string {
	if (!original.trim()) return transcript.trim();
	if (!transcript.trim()) return original;
	return `${original.replace(/\s+$/, "")} ${transcript.trim()}`;
}

class MetaVoiceController {
	private readonly pi: ExtensionAPI;
	private readonly settings = loadSettings();
	private phase: VoicePhase = "idle";
	private helper: ReturnType<typeof spawn> | null = null;
	private socket: WebSocket | null = null;
	private removeTerminalInput: (() => void) | null = null;
	private renderInterval: ReturnType<typeof setInterval> | null = null;
	private recordingLimitTimer: ReturnType<typeof setTimeout> | null = null;
	private trailingSilenceTimer: ReturnType<typeof setInterval> | null = null;
	private drainTimer: ReturnType<typeof setTimeout> | null = null;
	private finalTimeout: ReturnType<typeof setTimeout> | null = null;
	private startTime = 0;
	private audioLevel = 0;
	private originalEditorText = "";
	private transcript = "";
	private stdoutBuffer = "";
	private stderr = "";
	private pcmRemainder = Buffer.alloc(0);
	private queuedAudio: Buffer[] = [];
	private queuedAudioBytes = 0;
	private generation = 0;
	private asrReady = false;
	private streamingStarted = false;
	private captureStopped = false;
	private stopRequested = false;
	private trailingSilenceStarted = false;
	private awaitingDrain = false;

	constructor(pi: ExtensionAPI) {
		this.pi = pi;
	}

	register(): void {
		this.pi.registerCommand("voice", {
			description: "Inspect Muse-style Meta voice dictation state",
			handler: async (_args, ctx) => this.showState(ctx),
		});
		this.pi.registerCommand("voice-on", {
			description: "Enable toggle-based Meta voice dictation",
			handler: async (_args, ctx) => this.enable(ctx),
		});
		this.pi.registerCommand("voice-off", {
			description: "Disable toggle-based Meta voice dictation",
			handler: async (_args, ctx) => this.disable(ctx),
		});
		this.pi.on("session_start", (_event, ctx) => this.startSession(ctx));
		this.pi.on("session_shutdown", (_event, ctx) => this.shutdown(ctx));
	}

	private startSession(ctx: ExtensionContext): void {
		this.removeTerminalInput?.();
		this.removeTerminalInput = null;
		if (ctx.mode === "tui") {
			this.removeTerminalInput = ctx.ui.onTerminalInput((data) =>
				this.handleTerminalInput(ctx, data),
			);
		}
		this.renderIdleStatus(ctx);
	}

	private handleTerminalInput(
		ctx: ExtensionContext,
		data: string,
	): { consume: true } | undefined {
		if (!matchesKey(data, "alt+v")) return undefined;
		if (isKeyRelease(data) || isKeyRepeat(data)) return { consume: true };

		if (!this.settings.enabled) {
			ctx.ui.notify("Voice is off — run /voice-on", "warning");
			return { consume: true };
		}

		if (this.phase === "idle") void this.start(ctx);
		else this.stop(ctx);
		return { consume: true };
	}

	private showState(ctx: ExtensionContext): void {
		const state = this.settings.enabled ? "on" : "off";
		const detail = this.settings.enabled
			? "Press Alt+V to start recording and press it again to stop. Audio is sent to Muse's internal Meta ASR; only the transcript is inserted into the editor."
			: "Run /voice-on to enable toggle-based dictation.";
		ctx.ui.notify(
			`Voice: ${state} — ${detail}`,
			this.settings.enabled ? "info" : "warning",
		);
	}

	private enable(ctx: ExtensionContext): void {
		if (!isSupportedPlatform()) {
			ctx.ui.notify(
				`Meta voice input is currently available only on macOS, Windows, and Linux (current: ${supportedPlatformLabel()})`,
				"error",
			);
			return;
		}
		this.settings.enabled = true;
		saveSettings(this.settings);
		this.renderIdleStatus(ctx);
		ctx.ui.notify(
			"Meta voice dictation enabled — press Alt+V to start, then Alt+V again to stop",
			"info",
		);
	}

	private disable(ctx: ExtensionContext): void {
		this.cancelActiveSession();
		this.settings.enabled = false;
		saveSettings(this.settings);
		this.renderIdleStatus(ctx);
		ctx.ui.setWidget("muse-voice", undefined);
		ctx.ui.notify("Meta voice dictation disabled", "info");
	}

	private renderIdleStatus(ctx: ExtensionContext): void {
		ctx.ui.setStatus(
			"muse-voice",
			this.settings.enabled ? "⌥V · Meta voice" : "voice: off",
		);
	}

	private renderRecordingStatus(ctx: ExtensionContext): void {
		if (this.phase !== "recording") return;
		const filled = Math.max(0, Math.min(8, Math.round(this.audioLevel * 8)));
		const meter = `${"█".repeat(filled)}${"░".repeat(8 - filled)}`;
		ctx.ui.setStatus(
			"muse-voice",
			ctx.ui.theme.fg("success", `● [${meter}] Meta voice · ⌥V stop`),
		);
	}

	private renderTranscript(ctx: ExtensionContext): void {
		ctx.ui.setEditorText(
			combineEditorText(this.originalEditorText, this.transcript),
		);
		if (this.phase === "idle") return;

		const elapsed = ((Date.now() - this.startTime) / 1_000).toFixed(1);
		const tail = this.transcript ? this.transcript.slice(-160) : "…listening";
		const headline =
			this.phase === "stopping"
				? `◌ ${elapsed}s Meta ASR — transcribing…`
				: `● ${elapsed}s Meta ASR — press Alt+V to stop`;
		ctx.ui.setWidget("muse-voice", [headline, tail], {
			placement: "belowEditor",
		});
	}

	private async start(ctx: ExtensionContext): Promise<void> {
		if (this.phase !== "idle") return;
		this.phase = "preparing";
		const currentGeneration = ++this.generation;
		this.resetUtterance(ctx);
		ctx.ui.setStatus("muse-voice", "voice: preparing…");
		this.renderTranscript(ctx);

		try {
			const [helperInfo, apiKey] = await Promise.all([
				ensureHelper(),
				ctx.modelRegistry.getApiKeyForProvider(META_PROVIDER_ID),
			]);
			if (currentGeneration !== this.generation) return;
			if (!apiKey) {
				throw new Error("Meta credentials are unavailable; run `/login meta`");
			}
			if (this.stopRequested) {
				this.complete(ctx);
				return;
			}

			this.connectSocket(ctx, apiKey, currentGeneration);
			this.spawnHelper(
				ctx,
				helperInfo.command,
				helperInfo.args,
				currentGeneration,
			);
			this.renderInterval = setInterval(() => {
				this.renderTranscript(ctx);
				this.renderRecordingStatus(ctx);
				this.audioLevel *= 0.78;
			}, 120);
			this.recordingLimitTimer = setTimeout(() => {
				ctx.ui.notify("Voice recording reached the two-minute limit", "warning");
				this.stop(ctx);
			}, MAX_RECORDING_MS);
		} catch (error) {
			if (currentGeneration !== this.generation) return;
			this.fail(ctx, error instanceof Error ? error : new Error(String(error)));
		}
	}

	private resetUtterance(ctx: ExtensionContext): void {
		this.clearTimers();
		this.originalEditorText = ctx.ui.getEditorText();
		this.audioLevel = 0;
		this.transcript = "";
		this.stdoutBuffer = "";
		this.stderr = "";
		this.pcmRemainder = Buffer.alloc(0);
		this.queuedAudio = [];
		this.queuedAudioBytes = 0;
		this.asrReady = false;
		this.streamingStarted = false;
		this.captureStopped = false;
		this.stopRequested = false;
		this.trailingSilenceStarted = false;
		this.awaitingDrain = false;
		this.startTime = Date.now();
	}

	private connectSocket(
		ctx: ExtensionContext,
		apiKey: string,
		currentGeneration: number,
	): void {
		const sessionId = `${randomUUID()}-0`;
		const socket = new WebSocket(asrEndpoint(sessionId));
		this.socket = socket;
		socket.addEventListener("open", () => {
			if (currentGeneration !== this.generation) return;
			socket.send(JSON.stringify(asrHandshake(apiKey)));
		});
		socket.addEventListener("message", (event) => {
			if (currentGeneration !== this.generation) return;
			void this.handleSocketMessage(ctx, event.data, currentGeneration);
		});
		socket.addEventListener("error", () => {
			if (currentGeneration !== this.generation) return;
			this.fail(ctx, new Error("could not connect to Muse's Meta ASR service"));
		});
		socket.addEventListener("close", (event) => {
			if (currentGeneration !== this.generation || this.phase === "idle") return;
			if (
				this.phase === "stopping" &&
				this.transcript &&
				isNormalSocketClose(event.code)
			) {
				this.complete(ctx);
				return;
			}
			this.fail(
				ctx,
				new Error(
					event.reason || `Meta ASR connection closed (${event.code || "unknown"})`,
				),
			);
		});
	}

	private async handleSocketMessage(
		ctx: ExtensionContext,
		data: unknown,
		currentGeneration: number,
	): Promise<void> {
		const text = await socketMessageText(data);
		if (currentGeneration !== this.generation) return;
		if (text === undefined) return;
		const payload = parseJsonObject(text);
		if (!payload) return;
		this.handleAsrPayload(ctx, payload);
	}

	private handleAsrPayload(
		ctx: ExtensionContext,
		payload: Record<string, unknown>,
	): void {
		if (typeof payload.sessionId === "string") {
			this.asrReady = true;
			this.flushQueuedAudio(this.captureStopped);
			if (this.captureStopped) this.startTrailingSilence(ctx);
			return;
		}
		if (payload.error) {
			const error = payload.error as { message?: unknown };
			const message =
				typeof error.message === "string"
					? error.message
					: "Meta ASR rejected the voice stream";
			this.fail(ctx, new Error(message));
			return;
		}
		if (payload.transcript && typeof payload.transcript === "object") {
			this.applyTranscriptUpdate(ctx, payload.transcript as AsrTranscript);
		}
	}

	private applyTranscriptUpdate(
		ctx: ExtensionContext,
		update: AsrTranscript,
	): void {
		if (typeof update.transcript === "string") {
			this.transcript = chooseTranscript(this.transcript, update.transcript);
		}
		this.renderTranscript(ctx);
		if (update.final === true) {
			this.complete(ctx);
		} else if (this.awaitingDrain) {
			this.scheduleDrainCompletion(ctx);
		}
	}

	private spawnHelper(
		ctx: ExtensionContext,
		command: string,
		args: string[],
		currentGeneration: number,
	): void {
		const helper = spawn(command, args, {
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
		});
		this.helper = helper;
		helper.stdout?.on("data", (chunk: Buffer) =>
			this.parseHelperOutput(ctx, chunk, currentGeneration),
		);
		helper.stderr?.on("data", (chunk: Buffer) => {
			this.stderr = `${this.stderr}${chunk.toString("utf8")}`.slice(-4_000);
		});
		helper.once("error", (error) => {
			if (currentGeneration === this.generation) this.fail(ctx, error);
		});
		helper.once("close", (code) => {
			if (currentGeneration !== this.generation) return;
			this.helper = null;
			if (this.captureStopped || this.phase === "stopping") {
				this.markCaptureStopped(ctx);
				return;
			}
			this.fail(
				ctx,
				new Error(
					this.stderr.trim() ||
						`microphone helper exited with code ${code ?? "unknown"}`,
				),
			);
		});
	}

	private parseHelperOutput(
		ctx: ExtensionContext,
		chunk: Buffer,
		currentGeneration: number,
	): void {
		if (currentGeneration !== this.generation) return;
		this.stdoutBuffer += chunk.toString("utf8");
		const lines = this.stdoutBuffer.split("\n");
		this.stdoutBuffer = lines.pop() ?? "";
		for (const line of lines) {
			if (!line.trim()) continue;
			try {
				this.handleHelperEvent(ctx, JSON.parse(line) as HelperEvent);
			} catch {
				// Ignore non-protocol output from audio frameworks.
			}
		}
	}

	private handleHelperEvent(ctx: ExtensionContext, event: HelperEvent): void {
		switch (event.type) {
			case "ready":
				this.phase = this.stopRequested ? "stopping" : "recording";
				if (this.stopRequested) {
					ctx.ui.setStatus("muse-voice", "voice: transcribing…");
				} else {
					this.renderRecordingStatus(ctx);
				}
				this.renderTranscript(ctx);
				if (this.stopRequested && this.helper?.stdin?.writable) {
					this.helper.stdin.write("stop\n");
				}
				return;
			case "audio":
				if (typeof event.data === "string") {
					this.acceptPcm(Buffer.from(event.data, "base64"));
				}
				return;
			case "stopped":
				this.markCaptureStopped(ctx);
				return;
			case "error":
				this.fail(
					ctx,
					new Error(
						typeof event.message === "string"
							? event.message
							: "microphone capture failed",
					),
				);
				return;
			default:
				return;
		}
	}

	private acceptPcm(chunk: Buffer): void {
		if (this.captureStopped || chunk.length === 0) return;
		this.audioLevel = Math.max(pcmAudioLevel(chunk), this.audioLevel * 0.65);
		this.pcmRemainder = Buffer.concat([this.pcmRemainder, chunk]);
		while (this.pcmRemainder.length >= AUDIO_FRAME_BYTES) {
			const frame = this.pcmRemainder.subarray(0, AUDIO_FRAME_BYTES);
			this.pcmRemainder = this.pcmRemainder.subarray(AUDIO_FRAME_BYTES);
			this.sendOrQueueAudio(Buffer.from(frame));
		}
	}

	private sendOrQueueAudio(frame: Buffer): void {
		if (
			this.streamingStarted &&
			this.asrReady &&
			this.socket?.readyState === WebSocket.OPEN
		) {
			this.socket.send(frame);
			return;
		}

		this.queuedAudio.push(frame);
		this.queuedAudioBytes += frame.length;
		while (this.queuedAudioBytes > MAX_QUEUED_AUDIO_BYTES) {
			const removed = this.queuedAudio.shift();
			if (!removed) break;
			this.queuedAudioBytes -= removed.length;
		}
		this.flushQueuedAudio();
	}

	private flushQueuedAudio(force = false): void {
		if (!this.asrReady || this.socket?.readyState !== WebSocket.OPEN) return;
		if (
			!this.streamingStarted &&
			!force &&
			this.queuedAudio.length < ASR_PREBUFFER_FRAMES
		) {
			return;
		}
		this.streamingStarted = true;
		for (const frame of this.queuedAudio) this.socket.send(frame);
		this.queuedAudio = [];
		this.queuedAudioBytes = 0;
	}

	private stop(ctx: ExtensionContext): void {
		if (this.phase === "idle" || this.phase === "stopping") return;
		this.stopRequested = true;
		this.phase = "stopping";
		if (this.recordingLimitTimer) clearTimeout(this.recordingLimitTimer);
		this.recordingLimitTimer = null;
		ctx.ui.setStatus("muse-voice", "voice: transcribing…");
		this.renderTranscript(ctx);

		if (this.helper?.stdin?.writable) this.helper.stdin.write("stop\n");
		this.finalTimeout = setTimeout(
			() => this.complete(ctx),
			FINAL_TRANSCRIPT_TIMEOUT_MS,
		);
	}

	private markCaptureStopped(ctx: ExtensionContext): void {
		if (this.captureStopped) return;
		this.captureStopped = true;
		if (this.pcmRemainder.length > 0) {
			const padded = Buffer.alloc(AUDIO_FRAME_BYTES);
			this.pcmRemainder.copy(padded);
			this.pcmRemainder = Buffer.alloc(0);
			this.sendOrQueueAudio(padded);
		}
		this.flushQueuedAudio(true);
		if (this.asrReady) this.startTrailingSilence(ctx);
	}

	private startTrailingSilence(ctx: ExtensionContext): void {
		if (
			this.trailingSilenceStarted ||
			this.socket?.readyState !== WebSocket.OPEN
		) {
			return;
		}
		this.trailingSilenceStarted = true;
		let remaining = TRAILING_SILENCE_FRAMES;
		this.trailingSilenceTimer = setInterval(() => {
			if (this.socket?.readyState !== WebSocket.OPEN) {
				this.complete(ctx);
				return;
			}
			if (remaining > 0) {
				this.socket.send(Buffer.alloc(AUDIO_FRAME_BYTES));
				remaining -= 1;
				return;
			}
			if (this.trailingSilenceTimer) clearInterval(this.trailingSilenceTimer);
			this.trailingSilenceTimer = null;
			this.awaitingDrain = true;
			this.scheduleDrainCompletion(ctx);
		}, 100);
	}

	private scheduleDrainCompletion(ctx: ExtensionContext): void {
		if (this.drainTimer) clearTimeout(this.drainTimer);
		this.drainTimer = setTimeout(() => this.complete(ctx), 450);
	}

	private complete(ctx: ExtensionContext): void {
		if (this.phase === "idle") return;
		const transcript = this.transcript.trim();
		this.phase = "idle";
		this.generation += 1;
		this.clearTimers();
		this.closeResources();
		ctx.ui.setEditorText(combineEditorText(this.originalEditorText, transcript));
		ctx.ui.setWidget("muse-voice", undefined);
		this.renderIdleStatus(ctx);
		if (transcript) {
			ctx.ui.notify(
				"✓ Meta voice transcript ready — press Enter to submit",
				"info",
			);
		} else if (this.stopRequested) {
			ctx.ui.notify(
				"No speech was detected — check microphone access and try again",
				"warning",
			);
		}
	}

	private fail(ctx: ExtensionContext, error: Error): void {
		if (this.phase === "idle") return;
		const partial = this.transcript.trim();
		this.phase = "idle";
		this.generation += 1;
		this.clearTimers();
		this.closeResources();
		ctx.ui.setEditorText(combineEditorText(this.originalEditorText, partial));
		ctx.ui.setWidget("muse-voice", undefined);
		this.renderIdleStatus(ctx);
		ctx.ui.notify(`Meta voice failed: ${error.message}`, "error");
	}

	private clearTimers(): void {
		if (this.renderInterval) clearInterval(this.renderInterval);
		if (this.recordingLimitTimer) clearTimeout(this.recordingLimitTimer);
		if (this.trailingSilenceTimer) clearInterval(this.trailingSilenceTimer);
		if (this.drainTimer) clearTimeout(this.drainTimer);
		if (this.finalTimeout) clearTimeout(this.finalTimeout);
		this.renderInterval = null;
		this.recordingLimitTimer = null;
		this.trailingSilenceTimer = null;
		this.drainTimer = null;
		this.finalTimeout = null;
	}

	private closeResources(): void {
		const helper = this.helper;
		this.helper = null;
		if (helper && helper.exitCode === null) {
			try {
				helper.kill("SIGTERM");
			} catch {
				// Helper may already have exited.
			}
		}
		const socket = this.socket;
		this.socket = null;
		if (socket && socket.readyState < WebSocket.CLOSING) {
			try {
				socket.close(1000, "voice complete");
			} catch {
				// Socket may already have closed.
			}
		}
	}

	private cancelActiveSession(): void {
		if (this.phase === "idle") return;
		this.phase = "idle";
		this.generation += 1;
		this.clearTimers();
		this.closeResources();
	}

	private shutdown(ctx: ExtensionContext): void {
		this.removeTerminalInput?.();
		this.removeTerminalInput = null;
		this.cancelActiveSession();
		ctx.ui.setWidget("muse-voice", undefined);
		ctx.ui.setStatus("muse-voice", undefined);
	}
}

export default function metaVoice(pi: ExtensionAPI): void {
	new MetaVoiceController(pi).register();
}
