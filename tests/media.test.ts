/// <reference types="bun-types" />
import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import metaMedia, {
	extractMetaResponseUsage,
	extractResponsesText,
	formatMetaResponseUsage,
	mediaInputFromSource,
	maybeUploadLargeInlineBlocks,
	rewriteResponsesPayload,
} from "../extensions/media.ts";

describe("Meta media usage", () => {
	test("converts Responses API token usage for Pi accounting", () => {
		const usage = extractMetaResponseUsage({
			usage: {
				input_tokens: 100,
				input_tokens_details: {
					cached_tokens: 20,
					cache_write_tokens: 5,
				},
				output_tokens: 40,
				output_tokens_details: { reasoning_tokens: 10 },
				total_tokens: 140,
			},
		});

		expect(usage).toMatchObject({
			input: 75,
			output: 40,
			cacheRead: 20,
			cacheWrite: 5,
			reasoning: 10,
			totalTokens: 140,
		});
		expect(usage?.cost).toEqual({
			input: 0.00009375,
			output: 0.00017,
			cacheRead: 0.000003,
			cacheWrite: 0,
			total: 0.00026675,
		});
	});

	test("formats one analysis usage for display", () => {
		const usage = extractMetaResponseUsage({
			usage: { input_tokens: 1200, output_tokens: 34, total_tokens: 1234 },
		});

		expect(usage && formatMetaResponseUsage(usage)).toBe(
			"Video token usage: 1,234 total (1,200 input, 34 output)",
		);
	});

	test("extracts analysis when output_text is empty", () => {
		expect(
			extractResponsesText({
				output_text: "",
				output: [
					{
						type: "message",
						content: [{ type: "text", text: "The video shows a launch." }],
					},
				],
			}),
		).toBe("The video shows a launch.");
	});

	test("ignores responses without token counts", () => {
		expect(extractMetaResponseUsage({ usage: {} })).toBeUndefined();
		expect(extractMetaResponseUsage({ output: [] })).toBeUndefined();
	});
});

describe("Meta media input routing", () => {
	test("only creates pseudo-image attachments for the Meta provider", async () => {
		type InputHandler = (
			event: { text: string; images: unknown[] },
			ctx: {
				cwd: string;
				model?: { provider: string };
				ui: { notify: () => void };
			},
		) => Promise<unknown>;
		let inputHandler: InputHandler | undefined;
		const pi = {
			on(event: string, handler: unknown) {
				if (event === "input") inputHandler = handler as InputHandler;
			},
			registerTool() {},
			registerCommand() {},
		} as unknown as ExtensionAPI;
		metaMedia(pi);
		expect(inputHandler).toBeDefined();

		const directory = mkdtempSync(join(tmpdir(), "pi-meta-media-"));
		const clip = join(directory, "clip.mp4");
		writeFileSync(clip, Buffer.from("fake mp4"));
		const event = { text: `Describe @${clip}`, images: [] };
		const context = {
			cwd: directory,
			ui: { notify() {} },
		};
		try {
			const codexResult = await inputHandler?.(event, {
				...context,
				model: { provider: "openai-codex" },
			});
			expect(codexResult).toBeUndefined();

			const metaResult = (await inputHandler?.(event, {
				...context,
				model: { provider: "meta" },
			})) as
				| {
						action: string;
						images: Array<{ mimeType: string }>;
				  }
				| undefined;
			expect(metaResult).toMatchObject({
				action: "transform",
				images: [{ mimeType: "video/mp4" }],
			});
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});

describe("Meta media payload rewrite", () => {
	test("rewrites smuggled video image blocks to input_video", () => {
		const { rewritten, payload } = rewriteResponsesPayload({
			model: "muse-spark-1.2",
			input: [
				{
					type: "message",
					role: "user",
					content: [
						{ type: "input_text", text: "Describe this" },
						{
							type: "input_image",
							image_url: "data:video/mp4;base64,AAAA",
						},
						{
							type: "input_image",
							image_url: "https://cdn.example.com/clip.mp4",
						},
					],
				},
			],
		});

		expect(rewritten).toBe(true);
		const content = (
			payload as {
				input: Array<{ content: Array<Record<string, unknown>> }>;
			}
		).input[0].content;
		expect(content[1]).toEqual({
			type: "input_video",
			video_url: "data:video/mp4;base64,AAAA",
		});
		expect(content[2]).toEqual({
			type: "input_video",
			video_url: "https://cdn.example.com/clip.mp4",
		});
		// video/mp4 must never be sent through input_file.file_data; Meta rejects it.
		for (const block of content) {
			expect(block.file_data).toBeUndefined();
		}
	});

	test("rewrites smuggled audio and pdf image blocks to typed inputs", () => {
		const { rewritten, payload } = rewriteResponsesPayload({
			input: [
				{
					role: "user",
					content: [
						{
							type: "input_image",
							image_url: "data:audio/wav;base64,UklGRg==",
						},
						{
							type: "input_image",
							image_url: "https://cdn.example.com/notes.pdf",
						},
						{
							type: "input_image",
							image_url: "data:image/png;base64,iVBOR",
						},
					],
				},
			],
		});

		expect(rewritten).toBe(true);
		const content = (
			payload as {
				input: Array<{ content: Array<Record<string, unknown>> }>;
			}
		).input[0].content;
		expect(content[0]).toEqual({
			type: "input_audio",
			input_audio: { data: "UklGRg==", format: "wav" },
		});
		expect(content[1]).toEqual({
			type: "input_file",
			file_url: "https://cdn.example.com/notes.pdf",
		});
		// Real images stay as input_image.
		expect(content[2]).toEqual({
			type: "input_image",
			image_url: "data:image/png;base64,iVBOR",
		});
	});

	test("builds typed inline blocks and file-id references", () => {
		expect(
			mediaInputFromSource("data:video/mp4;base64,AAAA", "clip.mp4"),
		).toEqual({
			type: "input_video",
			video_url: "data:video/mp4;base64,AAAA",
		});
		expect(
			mediaInputFromSource("data:audio/mpeg;base64,SUQz", "speech.mp3"),
		).toEqual({
			type: "input_audio",
			input_audio: { data: "SUQz", format: "mp3" },
		});
		expect(mediaInputFromSource("file-123", "clip.mp4", "video/mp4")).toEqual({
			type: "input_file",
			file_id: "file-123",
		});
	});

	test("promotes oversized inline video to an uploaded file_id", async () => {
		const originalFetch = globalThis.fetch;
		let uploadedFile: File | undefined;
		globalThis.fetch = (async (_input, init) => {
			const form = init?.body as FormData;
			uploadedFile = form.get("file") as File;
			expect(form.get("purpose")).toBe("user_data");
			expect(form.get("expires_after[anchor]")).toBe("created_at");
			expect(form.get("expires_after[seconds]")).toBe(String(24 * 60 * 60));
			expect((init?.headers as Record<string, string>).Authorization).toBe(
				"Bearer test-key",
			);
			return new Response(JSON.stringify({ id: "file-uploaded-video" }), {
				status: 200,
			});
		}) as typeof fetch;
		try {
			const result = await maybeUploadLargeInlineBlocks(
				{
					store: true,
					input: [
						{
							role: "user",
							content: [
								{
									type: "input_video",
									video_url: "data:video/mp4;base64,AAAA",
								},
							],
						},
					],
				},
				"test-key",
				1,
			);
			expect(result.uploaded).toBe(1);
			expect(result.payload).toMatchObject({
				store: false,
				input: [
					{
						content: [{ type: "input_file", file_id: "file-uploaded-video" }],
					},
				],
			});
			expect(uploadedFile?.name).toBe("video.mp4");
			expect(uploadedFile?.type).toBe("video/mp4");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("rewrites media URLs that include query strings", () => {
		const { rewritten, payload } = rewriteResponsesPayload({
			input: [
				{
					role: "user",
					content: [
						{
							type: "input_image",
							image_url: "https://cdn.example.com/clip.mp4?token=abc#t=1",
						},
					],
				},
			],
		});
		expect(rewritten).toBe(true);
		expect(
			(
				payload as {
					input: Array<{ content: Array<Record<string, unknown>> }>;
				}
			).input[0].content[0],
		).toEqual({
			type: "input_video",
			video_url: "https://cdn.example.com/clip.mp4?token=abc#t=1",
		});
	});

	test("promotes oversized tool-output images and forces store:false", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async () =>
			new Response(JSON.stringify({ id: "file-uploaded-image" }), {
				status: 200,
			})) as unknown as typeof fetch;
		try {
			const result = await maybeUploadLargeInlineBlocks(
				{
					store: true,
					input: [
						{
							type: "function_call_output",
							output: [
								{
									type: "input_image",
									image_url: "data:image/png;base64,AAAA",
								},
							],
						},
					],
				},
				"test-key",
				1,
			);
			expect(result.uploaded).toBe(1);
			expect(result.payload).toMatchObject({
				store: false,
				input: [
					{
						output: [{ type: "input_file", file_id: "file-uploaded-image" }],
					},
				],
			});
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});


describe("Meta media tool contracts", () => {
	function registeredTools(): Map<string, any> {
		const tools = new Map<string, any>();
		const pi = {
			on() {},
			registerCommand() {},
			registerTool(tool: { name: string }) {
				tools.set(tool.name, tool);
			},
		} as unknown as ExtensionAPI;
		metaMedia(pi);
		return tools;
	}

	const context = {
		cwd: process.cwd(),
		modelRegistry: { getApiKeyForProvider: async () => "test-key" },
		ui: { notify() {} },
	};

	test("rejects invalid sources and Meta API failures as failed tool calls", async () => {
		const tool = registeredTools().get("meta_analyze_file");
		await expect(tool.execute("missing", { prompt: "inspect" }, undefined, undefined, context)).rejects.toThrow(
			"requires exactly one path/url/file_id or a sources array",
		);
		await expect(tool.execute("local", {
			sources: [{ source: "file-report.pdf" }],
			prompt: "inspect",
		}, undefined, undefined, context)).rejects.toThrow("File not found");

		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (_input, _init) =>
			new Response(JSON.stringify({ error: "unavailable" }), { status: 503 })) as typeof fetch;
		try {
			await expect(tool.execute("api", {
				url: "https://example.com/image.png",
				prompt: "inspect",
			}, undefined, undefined, context)).rejects.toThrow("File analysis failed: Meta Responses failed (HTTP 503)");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("preserves ordered labels in one multi-file request", async () => {
		const originalFetch = globalThis.fetch;
		let requestBody: Record<string, any> | undefined;
		globalThis.fetch = (async (_input, init) => {
			requestBody = JSON.parse(String(init?.body)) as Record<string, any>;
			return new Response(JSON.stringify({ output_text: "comparison", usage: { input_tokens: 10, output_tokens: 2 } }), {
				status: 200,
			});
		}) as typeof fetch;
		try {
			const tool = registeredTools().get("meta_analyze_file");
			const result = await tool.execute("multi", {
				sources: [
					{ source: "https://example.com/before.png", label: "Before" },
					{ source: "https://example.com/after.png", label: "After" },
				],
				prompt: "Compare the screenshots",
			}, undefined, undefined, context);
			expect(result.content[0].text).toBe("comparison");
			const content = requestBody?.input?.[0]?.content;
			expect(content?.map((block: Record<string, unknown>) => block.type)).toEqual([
				"input_text", "input_text", "input_file", "input_text", "input_file",
			]);
			expect(content?.[1]?.text).toBe("Before:");
			expect(content?.[3]?.text).toBe("After:");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("explicit uploads expire after seven days by default", async () => {
		const originalFetch = globalThis.fetch;
		const directory = mkdtempSync(join(tmpdir(), "pi-meta-upload-"));
		const file = join(directory, "note.txt");
		writeFileSync(file, "hello");
		let form: FormData | undefined;
		globalThis.fetch = (async (_input, init) => {
			form = init?.body as FormData;
			return new Response(JSON.stringify({ id: "file-expiring", bytes: 5, status: "uploaded" }), { status: 200 });
		}) as typeof fetch;
		try {
			const tool = registeredTools().get("meta_upload_file");
			await tool.execute("upload", { path: file }, undefined, undefined, context);
			expect(form?.get("expires_after[anchor]")).toBe("created_at");
			expect(form?.get("expires_after[seconds]")).toBe(String(7 * 24 * 60 * 60));

			await tool.execute("retain", { path: file, retain: true }, undefined, undefined, context);
			expect(form?.get("expires_after[anchor]")).toBeNull();
			expect(form?.get("expires_after[seconds]")).toBeNull();
		} finally {
			globalThis.fetch = originalFetch;
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
