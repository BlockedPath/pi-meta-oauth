import { basename } from "node:path";
import { readFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { META_FILES_URL } from "../meta.ts";
import {
	AUTOMATIC_UPLOAD_EXPIRY_SECONDS,
	FILES_API_LIMIT_BYTES,
} from "./limits.ts";
import { filenameForMime, mimeForPath } from "./mime.ts";

export interface UploadResult {
	id: string;
	filename: string;
	bytes: number;
	purpose: string;
	status: string;
	expires_at?: number;
}

function uploadErrorDetail(body: Record<string, unknown>, bodyText: string): string {
	if (typeof body.error === "string") return body.error;
	if (typeof body.message === "string") return body.message;
	if (typeof body.error_description === "string") return body.error_description;
	return bodyText.slice(0, 500);
}

export async function uploadMetaFile(
	apiKey: string,
	filePath: string,
	expiresAfter?: { anchor: "created_at"; seconds: number },
	signal?: AbortSignal,
): Promise<UploadResult> {
	const size = statSync(filePath).size;
	if (size > FILES_API_LIMIT_BYTES) {
		throw new Error(
			`File too large for Files API (${size} bytes > 1 GiB)`,
		);
	}
	const data = await readFile(filePath, { signal });
	const mime = mimeForPath(filePath) ?? "application/octet-stream";
	const blob = new Blob([data], { type: mime });
	const form = new FormData();
	form.append("file", blob, basename(filePath));
	form.append("purpose", "user_data");
	if (expiresAfter) {
		form.append("expires_after[anchor]", expiresAfter.anchor);
		form.append("expires_after[seconds]", String(expiresAfter.seconds));
	}
	const res = await fetch(META_FILES_URL, {
		method: "POST",
		headers: { Authorization: `Bearer ${apiKey}` },
		body: form,
		signal,
	});
	const bodyText = await res.text();
	let body: Record<string, unknown> = {};
	try {
		body = bodyText ? (JSON.parse(bodyText) as Record<string, unknown>) : {};
	} catch {
		// Non-JSON body — keep empty and use raw text for error detail
	}
	if (!res.ok) {
		const detail = uploadErrorDetail(body, bodyText);
		if (res.status === 400 && detail.includes("storage")) {
			throw new Error(
				`Meta Files storage limit reached (100 GiB/team). Delete old files via DELETE /v1/files/{id}. Detail: ${detail}`,
			);
		}
		throw new Error(
			`Meta Files upload failed (HTTP ${res.status}): ${detail || res.statusText}`,
		);
	}
	const id =
		typeof body.id === "string"
			? body.id
			: typeof body.file_id === "string"
				? body.file_id
				: undefined;
	if (!id) {
		throw new Error(
			`Meta Files upload returned no id: ${bodyText.slice(0, 500)}`,
		);
	}
	return {
		id,
		filename:
			typeof body.filename === "string" ? body.filename : basename(filePath),
		bytes: typeof body.bytes === "number" ? body.bytes : data.byteLength,
		purpose: typeof body.purpose === "string" ? body.purpose : "user_data",
		status: typeof body.status === "string" ? body.status : "uploaded",
		expires_at:
			typeof body.expires_at === "number" ? body.expires_at : undefined,
	};
}

export async function uploadInlineMedia(
	apiKey: string,
	base64: string,
	mime: string,
	filename: string,
	signal?: AbortSignal,
): Promise<string> {
	const blob = new Blob([Buffer.from(base64, "base64")], { type: mime });
	const form = new FormData();
	form.append("file", blob, filename || filenameForMime(mime));
	form.append("purpose", "user_data");
	form.append("expires_after[anchor]", "created_at");
	form.append("expires_after[seconds]", String(AUTOMATIC_UPLOAD_EXPIRY_SECONDS));
	const res = await fetch(META_FILES_URL, {
		method: "POST",
		headers: { Authorization: `Bearer ${apiKey}` },
		body: form,
		signal,
	});
	const text = await res.text();
	if (!res.ok) {
		throw new Error(
			`Files upload for large inline media failed: ${text.slice(0, 500)}`,
		);
	}
	let json: Record<string, unknown>;
	try {
		json = JSON.parse(text) as Record<string, unknown>;
	} catch (error) {
		throw new Error(`Files upload returned invalid JSON: ${String(error)}`);
	}
	if (typeof json.id !== "string" || !json.id) {
		throw new Error(`Files upload returned no id: ${text.slice(0, 500)}`);
	}
	return json.id;
}
