import type {
	AssistantMessage,
	AssistantMessageEvent,
	ToolCall,
} from "@earendil-works/pi-ai";
import { asRecord } from "./http.ts";

const TOOL_ALIASES = new Map([
	["bash", "execute_command"],
	["shell", "execute_shell"],
	["web_search", "search_web"],
	["workflow", "run_workflow"],
	["get_goal", "fetch_goal"],
	["read_file", "read_file_content"],
	["write_file", "write_file_content"],
	["edit_file", "edit_file_content"],
	["search", "search_content"],
]);

function namedTool(value: unknown): Record<string, unknown> | undefined {
	const record = asRecord(value);
	return record &&
		typeof record.name === "string" &&
		(record.type === "function" || record.type === "function_call")
		? record
		: undefined;
}

/** One request's wire names; Pi's tool registry and transcript keep their names. */
export class MetaToolAliases {
	private readonly originalNames = new Map<string, string>();
	private readonly messages = new WeakMap<AssistantMessage, AssistantMessage>();

	rewritePayload(payload: unknown): unknown {
		this.originalNames.clear();
		const body = asRecord(payload);
		if (!body) return payload;
		const tools = Array.isArray(body.tools) ? body.tools : [];
		const input = Array.isArray(body.input) ? body.input : [];
		const choice = asRecord(body.tool_choice);
		const allowed =
			choice?.type === "allowed_tools" && Array.isArray(choice.tools)
				? choice.tools
				: [];
		const occupied = new Set<string>();
		const targets = new Set<string>();
		for (const value of [...tools, ...input, choice, ...allowed]) {
			const item = asRecord(value);
			if (typeof item?.name !== "string") continue;
			occupied.add(item.name);
			if (namedTool(item)) targets.add(item.name);
		}

		const aliases = new Map<string, string>();
		for (const [original, preferred] of TOOL_ALIASES) {
			if (!targets.has(original)) continue;
			let alias = preferred;
			let suffix = 2;
			while (occupied.has(alias)) alias = `${preferred}_${suffix++}`;
			occupied.add(alias);
			aliases.set(original, alias);
			this.originalNames.set(alias, original);
		}
		if (aliases.size === 0) return payload;

		const rename = (value: unknown): unknown => {
			const item = namedTool(value);
			const alias = item && aliases.get(item.name as string);
			return alias ? { ...item, name: alias } : value;
		};
		return {
			...body,
			...(Array.isArray(body.tools) ? { tools: tools.map(rename) } : {}),
			...(Array.isArray(body.input) ? { input: input.map(rename) } : {}),
			...(choice
				? {
						tool_choice:
							choice.type === "allowed_tools"
								? { ...choice, tools: allowed.map(rename) }
								: rename(choice),
					}
				: {}),
		};
	}

	private restoreToolCall(toolCall: ToolCall): ToolCall {
		const original = this.originalNames.get(toolCall.name);
		return original ? { ...toolCall, name: original } : toolCall;
	}

	/**
	 * Keep one live downstream message without sharing upstream's tool blocks:
	 * pi-ai can append another wire-named call before the next event is forwarded.
	 */
	private restoreMessage(message: AssistantMessage): AssistantMessage {
		let restored = this.messages.get(message);
		if (!restored) {
			restored = { ...message };
			this.messages.set(message, restored);
		}
		Object.assign(restored, message, {
			content: message.content.map((block) =>
				block.type === "toolCall" ? this.restoreToolCall(block) : block,
			),
		});
		return restored;
	}

	restoreEvent(event: AssistantMessageEvent): AssistantMessageEvent {
		if (this.originalNames.size === 0) return event;
		if (event.type === "error")
			return { ...event, error: this.restoreMessage(event.error) };
		if (event.type === "done")
			return { ...event, message: this.restoreMessage(event.message) };
		const partial = this.restoreMessage(event.partial);
		return event.type === "toolcall_end"
			? { ...event, partial, toolCall: this.restoreToolCall(event.toolCall) }
			: { ...event, partial };
	}
}
