import { expect, test } from "bun:test";
import { synchronizeMetaApiKeyAliases } from "../src/meta/environment.ts";
import type { MetaEnv } from "../src/meta/types.ts";

test.each([
	[{}, {}],
	[{ META_API_KEY: "meta" }, { META_API_KEY: "meta", MODEL_API_KEY: "meta" }],
	[
		{ MODEL_API_KEY: "model" },
		{ META_API_KEY: "model", MODEL_API_KEY: "model" },
	],
	[
		{ META_API_KEY: "meta", MODEL_API_KEY: "model" },
		{ META_API_KEY: "meta", MODEL_API_KEY: "model" },
	],
	[
		{ META_API_KEY: "", MODEL_API_KEY: "model" },
		{ META_API_KEY: "", MODEL_API_KEY: "model" },
	],
])("synchronizes only missing API key aliases (%j)", (initial, expected) => {
	const env: MetaEnv = { ...initial };
	synchronizeMetaApiKeyAliases(env);
	expect(env).toEqual(expected);
	synchronizeMetaApiKeyAliases(env);
	expect(env).toEqual(expected);
});
