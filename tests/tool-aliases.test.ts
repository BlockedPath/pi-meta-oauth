import { describe, expect, test } from "bun:test";
import type {
	AssistantMessage,
	Context,
	Model,
	SimpleStreamOptions,
	Tool,
} from "@earendil-works/pi-ai";
import * as piAi from "@earendil-works/pi-ai";
import { TOOL_ALIASES_ENV_VAR } from "../src/meta/constants.ts";
import { createMetaProviderConfig } from "../src/meta/provider.ts";
import { resolveToolAliases } from "../src/meta/tool-aliases.ts";

const config = createMetaProviderConfig();
const send = config.streamSimple;
if (!send) throw new Error("Expected Meta stream adapter");

function model(overrides: Partial<Model<"openai-responses">> = {}) {
	const bundled = config.models[0];
	if (!bundled) throw new Error("Expected a bundled Meta model");
	return {
		...bundled,
		api: "openai-responses",
		provider: "meta",
		baseUrl: "https://api.meta.ai/v1",
		...overrides,
	} as Model<"openai-responses">;
}

function context(toolNames = ["bash", "shell", "web_search"]): Context {
	return {
		messages: [{ role: "user", content: "Use the tools.", timestamp: 0 }],
		tools: toolNames.map((name) => ({
			name,
			description: `Use ${name}.`,
			parameters: {
				type: "object",
				properties: { name: { type: "string", enum: ["bash"] } },
			} as unknown as Tool["parameters"],
		})),
	};
}

function normalized(value: Context): Parameters<NonNullable<typeof send>>[1] {
	const normalize = (piAi as { normalizeContext?: (c: Context) => unknown })
		.normalizeContext;
	return (normalize ? normalize(value) : value) as Parameters<
		NonNullable<typeof send>
	>[1];
}

/** Feed real pi-ai decoding with a deterministic Responses SSE tool stream. */
function toolResponse(names: string[], failure = false): Response {
	const frames: unknown[] = [
		{ type: "response.created", response: { id: "resp_test" } },
	];
	for (const [index, name] of names.entries()) {
		const item = {
			type: "function_call",
			id: `fc_${index}`,
			call_id: `call_${index}`,
			name,
			arguments: "",
		};
		frames.push(
			{ type: "response.output_item.added", output_index: index, item },
			{
				type: "response.function_call_arguments.delta",
				output_index: index,
				delta: '{"name":"bash"}',
			},
			{
				type: "response.output_item.done",
				output_index: index,
				item: { ...item, arguments: '{"name":"bash"}' },
			},
		);
	}
	frames.push(
		failure
			? {
					type: "response.failed",
					response: { error: { code: "failed", message: "test failure" } },
				}
			: {
					type: "response.completed",
					response: { id: "resp_test", status: "completed", output: [] },
				},
	);
	return new Response(
		frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(""),
		{ headers: { "Content-Type": "text/event-stream" } },
	);
}

function request(
	options: {
		context?: Context;
		model?: Model<"openai-responses">;
		onPayload?: SimpleStreamOptions["onPayload"];
		responseNames?: string[];
		failure?: boolean;
	} = {},
) {
	let payload: Record<string, unknown> | undefined;
	const stream = send?.(
		options.model ?? model(),
		normalized(options.context ?? context()),
		{
			apiKey: "test-key",
			maxRetries: 0,
			onPayload: options.onPayload,
			fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
				payload = JSON.parse(String(init?.body));
				return toolResponse(
					options.responseNames ?? [
						"execute_command",
						"execute_shell",
						"search_web",
					],
					options.failure,
				);
			}) as typeof fetch,
		},
	);
	if (!stream) throw new Error("Expected a stream");
	return { stream, payload: () => payload };
}

function toolNames(message: AssistantMessage) {
	return message.content.flatMap((block) =>
		block.type === "toolCall" ? [block.name] : [],
	);
}

describe("Meta tool aliases over the Responses wire", () => {
	test("aliases definitions after the caller hook and restores every stream event", async () => {
		const original = context();
		const snapshot = JSON.stringify(original);
		const captured = request({
			context: original,
			onPayload: async (payload) => {
				const body = payload as Record<string, unknown>;
				expect(body.tools).toMatchObject([
					{ name: "bash" },
					{ name: "shell" },
					{ name: "web_search" },
				]);
				return { ...body, tool_choice: { type: "function", name: "bash" } };
			},
		});
		const ended: string[] = [];
		let livePartial: AssistantMessage | undefined;
		for await (const event of captured.stream) {
			const partial =
				event.type === "done"
					? event.message
					: event.type === "error"
						? event.error
						: event.partial;
			livePartial ??= partial;
			expect(partial).toBe(livePartial);
			for (const name of toolNames(partial)) {
				expect(["bash", "shell", "web_search"]).toContain(name);
			}
			if (event.type === "toolcall_end") ended.push(event.toolCall.name);
		}
		const result = await captured.stream.result();
		expect(result.stopReason).toBe("toolUse");
		expect(ended).toEqual(["bash", "shell", "web_search"]);
		expect(toolNames(result)).toEqual(ended);
		expect(result.content[0]).toMatchObject({
			id: "call_0|fc_0",
			arguments: { name: "bash" },
		});
		expect(captured.payload()).toMatchObject({
			tools: [
				{
					name: "execute_command",
					description: "Use bash.",
					parameters: { properties: { name: { enum: ["bash"] } } },
				},
				{ name: "execute_shell" },
				{ name: "search_web" },
			],
			tool_choice: { type: "function", name: "execute_command" },
			prompt_cache_retention: "24h",
		});
		expect(JSON.stringify(original)).toBe(snapshot);
	});

	const workflowAndFileAliases = [
		["workflow", "run_workflow"],
		["get_goal", "fetch_goal"],
		["read_file", "read_file_content"],
		["write_file", "write_file_content"],
		["edit_file", "edit_file_content"],
		["search", "search_content"],
	] as const;

	test("aliases workflow, goal, and file tool names and restores them", async () => {
		const originals = workflowAndFileAliases.map(([original]) => original);
		const aliases = workflowAndFileAliases.map(([, alias]) => alias);
		const captured = request({
			context: context(originals),
			responseNames: aliases,
		});
		const result = await captured.stream.result();
		expect(result.stopReason).toBe("toolUse");
		expect(toolNames(result)).toEqual(originals);
		expect(captured.payload()?.tools).toMatchObject(
			aliases.map((name) => ({ name })),
		);
	});

	test("replays and forces workflow and file tools under their aliases", async () => {
		for (const [original, alias] of workflowAndFileAliases) {
			const replacement = {
				model: model().id,
				stream: true,
				tools: [{ type: "function", name: original, description: original }],
				input: [{ type: "function_call", name: original, arguments: "{}" }],
				tool_choice: { type: "function", name: original },
			};
			const captured = request({
				onPayload: async () => replacement,
				responseNames: [alias],
			});
			expect(toolNames(await captured.stream.result())).toEqual([original]);
			expect(captured.payload()).toMatchObject({
				tools: [{ name: alias }],
				input: [{ type: "function_call", name: alias }],
				tool_choice: { type: "function", name: alias },
			});
			expect(replacement.tools[0]?.name).toBe(original);
		}
	});

	test("suffixes workflow and file aliases that collide with custom tools", async () => {
		const captured = request({
			context: context([
				"read_file",
				"read_file_content",
				"search",
				"search_content",
			]),
			responseNames: [
				"read_file_content_2",
				"read_file_content",
				"search_content_2",
			],
		});
		expect(toolNames(await captured.stream.result())).toEqual([
			"read_file",
			"read_file_content",
			"search",
		]);
		expect(captured.payload()?.tools).toMatchObject([
			{ name: "read_file_content_2" },
			{ name: "read_file_content" },
			{ name: "search_content_2" },
			{ name: "search_content" },
		]);
	});

	test("replays restored calls and tool results using consistent wire names and IDs", async () => {
		const original = context(["bash"]);
		const first = request({
			context: original,
			responseNames: ["execute_command"],
		});
		const answer = await first.stream.result();
		const call = answer.content[0];
		if (call?.type !== "toolCall") throw new Error("Expected a tool call");
		const next: Context = {
			...original,
			messages: [
				...original.messages,
				answer,
				{
					role: "toolResult",
					toolCallId: call.id,
					toolName: call.name,
					content: [{ type: "text", text: "success" }],
					isError: false,
					timestamp: Date.now(),
				},
			],
		};
		const snapshot = JSON.stringify(next);
		const second = request({ context: next, responseNames: [] });
		expect((await second.stream.result()).stopReason).toBe("stop");
		const input = second.payload()?.input as Record<string, unknown>[];
		const replay = input.find((item) => item.type === "function_call");
		const output = input.find((item) => item.type === "function_call_output");
		expect(replay?.name).toBe("execute_command");
		expect(output?.call_id).toBe(replay?.call_id);
		expect(output?.output).toBe("success");
		expect(JSON.stringify(next)).toBe(snapshot);
	});

	test("avoids custom-tool collisions and keeps concurrent requests independent", async () => {
		const first = request({
			context: context(["bash"]),
			responseNames: ["execute_command"],
		});
		const second = request({
			context: context(["bash", "execute_command", "execute_command_2"]),
			responseNames: ["execute_command_3", "execute_command"],
		});
		const [a, b] = await Promise.all([
			first.stream.result(),
			second.stream.result(),
		]);
		expect(toolNames(a)).toEqual(["bash"]);
		expect(toolNames(b)).toEqual(["bash", "execute_command"]);
		expect(second.payload()?.tools).toMatchObject([
			{ name: "execute_command_3" },
			{ name: "execute_command" },
			{ name: "execute_command_2" },
		]);
	});

	test("handles reused replacement payloads and allowed tool choices", async () => {
		const replacement = {
			model: model().id,
			stream: true,
			tools: [{ type: "function", name: "shell", description: "shell" }],
			input: [{ type: "function_call", name: "shell", arguments: "shell" }],
			tool_choice: {
				type: "allowed_tools",
				mode: "required",
				tools: [{ type: "function", name: "shell" }],
			},
		};
		for (let n = 0; n < 2; n++) {
			const captured = request({
				onPayload: async () => replacement,
				responseNames: ["execute_shell"],
			});
			expect(toolNames(await captured.stream.result())).toEqual(["shell"]);
			expect(captured.payload()).toMatchObject({
				tools: [
					{ type: "function", name: "execute_shell", description: "shell" },
				],
				input: [
					{ type: "function_call", name: "execute_shell", arguments: "shell" },
				],
				tool_choice: { tools: [{ type: "function", name: "execute_shell" }] },
			});
		}
		expect(replacement.tools[0]?.name).toBe("shell");
		expect(replacement.input[0]?.name).toBe("shell");
	});

	test("restores names in partial responses that terminate with an error", async () => {
		const captured = request({ failure: true });
		const result = await captured.stream.result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("test failure");
		expect(toolNames(result)).toEqual(["bash", "shell", "web_search"]);
	});

	test("leaves other providers and custom Meta endpoints unchanged", async () => {
		for (const requestModel of [
			model({ provider: "openai" }),
			model({ baseUrl: "https://proxy.example/v1" }),
		]) {
			const captured = request({
				model: requestModel,
				context: context(["bash"]),
				responseNames: ["bash"],
			});
			expect(toolNames(await captured.stream.result())).toEqual(["bash"]);
			expect(captured.payload()?.tools).toMatchObject([{ name: "bash" }]);
		}
	});
});

describe("META_TOOL_ALIASES", () => {
	test("adds, overrides, and disables aliases and ignores malformed entries", () => {
		const aliases = resolveToolAliases({
			[TOOL_ALIASES_ENV_VAR]:
				" grep = search_text ,bash=run_command,shell=,web_search=web_search,no-separator,bad name=x,list_files=bad alias,grep=find_text",
		});
		expect(aliases.get("grep")).toBe("find_text");
		expect(aliases.get("bash")).toBe("run_command");
		expect(aliases.has("shell")).toBe(false);
		expect(aliases.has("web_search")).toBe(false);
		expect(aliases.has("list_files")).toBe(false);
		expect(aliases.has("bad name")).toBe(false);
		expect(aliases.get("read_file")).toBe("read_file_content");
		expect(resolveToolAliases({ [TOOL_ALIASES_ENV_VAR]: "  " })).toBe(
			resolveToolAliases({}),
		);
	});

	test("applies the environment per request and restores custom names", async () => {
		const previous = process.env[TOOL_ALIASES_ENV_VAR];
		process.env[TOOL_ALIASES_ENV_VAR] = "grep=search_text,bash=";
		try {
			const captured = request({
				context: context(["grep", "bash"]),
				responseNames: ["search_text", "bash"],
			});
			expect(toolNames(await captured.stream.result())).toEqual([
				"grep",
				"bash",
			]);
			expect(captured.payload()?.tools).toMatchObject([
				{ name: "search_text" },
				{ name: "bash" },
			]);
		} finally {
			if (previous === undefined) delete process.env[TOOL_ALIASES_ENV_VAR];
			else process.env[TOOL_ALIASES_ENV_VAR] = previous;
		}
		const builtIn = request({ context: context(["grep", "bash"]) });
		await builtIn.stream.result();
		expect(builtIn.payload()?.tools).toMatchObject([
			{ name: "grep" },
			{ name: "execute_command" },
		]);
	});
});
