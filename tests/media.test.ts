/// <reference types="bun-types" />
import { describe, expect, test } from "bun:test";
import {
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
});
