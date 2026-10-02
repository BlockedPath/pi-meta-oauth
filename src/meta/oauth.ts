import type {
	OAuthCredentials,
	OAuthLoginCallbacks,
} from "@earendil-works/pi-ai";
import {
	API_KEY_MINT_URL,
	API_KEY_REFRESH_INTERVAL_MS,
	DEVICE_AUTHORIZATION_URL,
	DEVICE_CODE_GRANT,
	DEVICE_TOKEN_URL,
	META_CLIENT_ID,
} from "./constants.ts";
import { delay, errorDetail, postForm, responseBody } from "./http.ts";
import type { Fetch, Sleep } from "./types.ts";

type Clock = () => number;

interface DeviceAuthorization {
	deviceCode: string;
	userCode: string;
	verificationUri: string;
	intervalSeconds: number;
	expiresInSeconds: number;
}

const DEFAULT_POLL_INTERVAL_SECONDS = 5;
const DEFAULT_DEVICE_EXPIRY_SECONDS = 900;
const POLL_SLOW_DOWN_SECONDS = 5;

function isNonBlankString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function positiveSeconds(value: unknown, fallback: number): number {
	return typeof value === "number" &&
		Number.isFinite(value) &&
		value > 0 &&
		Number.isFinite(value * 1000)
		? value
		: fallback;
}

function failure(message: string, body: Record<string, unknown>): Error {
	const detail = errorDetail(body);
	return new Error(`${message}${detail ? `: ${detail}` : ""}`);
}

function checkLoginCancellation(signal?: AbortSignal): void {
	if (signal?.aborted) throw new Error("Meta login was cancelled");
}

function waitForPoll(
	milliseconds: number,
	sleep: Sleep,
	signal?: AbortSignal,
): Promise<void> {
	checkLoginCancellation(signal);
	if (!signal) return sleep(milliseconds);

	return new Promise((resolve, reject) => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const cleanup = () => {
			signal.removeEventListener("abort", onAbort);
			if (timer !== undefined) clearTimeout(timer);
		};
		const complete = () => {
			cleanup();
			resolve();
		};
		const fail = (error: unknown) => {
			cleanup();
			reject(error);
		};
		const onAbort = () => fail(new Error("Meta login was cancelled"));
		signal.addEventListener("abort", onAbort, { once: true });
		if (signal.aborted) {
			onAbort();
			return;
		}
		// Own the default timer so cancellation also clears its pending work.
		if (sleep === delay) {
			timer = setTimeout(complete, milliseconds);
			return;
		}
		try {
			// Keep both handlers attached if an injected sleep finishes after abort.
			sleep(milliseconds).then(complete, fail);
		} catch (error) {
			fail(error);
		}
	});
}

async function requestDeviceAuthorization(
	fetchImpl: Fetch,
	signal?: AbortSignal,
): Promise<DeviceAuthorization> {
	checkLoginCancellation(signal);
	const { response, body } = await postForm(
		DEVICE_AUTHORIZATION_URL,
		{ client_id: META_CLIENT_ID },
		fetchImpl,
		signal,
	);
	checkLoginCancellation(signal);
	if (!response.ok) {
		throw failure(
			`Meta login could not be started (HTTP ${response.status})`,
			body,
		);
	}
	if (
		!isNonBlankString(body.device_code) ||
		!isNonBlankString(body.user_code) ||
		!isNonBlankString(body.verification_uri)
	) {
		throw new Error(
			"Meta device authorization returned an incomplete response",
		);
	}

	return {
		deviceCode: body.device_code,
		userCode: body.user_code,
		verificationUri: isNonBlankString(body.verification_uri_complete)
			? body.verification_uri_complete
			: body.verification_uri,
		intervalSeconds: positiveSeconds(
			body.interval,
			DEFAULT_POLL_INTERVAL_SECONDS,
		),
		expiresInSeconds: positiveSeconds(
			body.expires_in,
			DEFAULT_DEVICE_EXPIRY_SECONDS,
		),
	};
}

async function pollIdentityToken(
	device: DeviceAuthorization,
	deadline: number,
	fetchImpl: Fetch,
	sleep: Sleep,
	now: Clock,
	signal?: AbortSignal,
): Promise<string> {
	let intervalSeconds = device.intervalSeconds;
	while (true) {
		checkLoginCancellation(signal);
		const remainingMilliseconds = deadline - now();
		if (remainingMilliseconds <= 0) break;
		await waitForPoll(
			Math.min(intervalSeconds * 1000, remainingMilliseconds),
			sleep,
			signal,
		);
		checkLoginCancellation(signal);
		// A device code can expire while waiting, especially after slow_down.
		if (now() >= deadline) break;

		const { response, body } = await postForm(
			DEVICE_TOKEN_URL,
			{
				grant_type: DEVICE_CODE_GRANT,
				device_code: device.deviceCode,
				client_id: META_CLIENT_ID,
			},
			fetchImpl,
			signal,
		);
		checkLoginCancellation(signal);
		if (response.ok && isNonBlankString(body.access_token)) {
			return body.access_token;
		}
		switch (body.error) {
			case "authorization_pending":
				break;
			case "slow_down":
				intervalSeconds += POLL_SLOW_DOWN_SECONDS;
				break;
			case "access_denied":
				throw new Error("Meta login was denied");
			case "expired_token":
				throw new Error("Meta login request expired");
			default:
				throw failure(`Meta login failed (HTTP ${response.status})`, body);
		}
	}
	throw new Error("Meta login request expired");
}

export async function mintMetaApiKey(
	identityToken: string,
	fetchImpl: Fetch = globalThis.fetch,
	signal?: AbortSignal,
): Promise<string> {
	signal?.throwIfAborted();
	const response = await fetchImpl(API_KEY_MINT_URL, {
		method: "POST",
		headers: {
			Accept: "application/json",
			Authorization: `Bearer ${identityToken}`,
			"Content-Type": "application/json",
			"x-api-version": "1.0.0",
		},
		body: "{}",
		signal,
	});
	const body = await responseBody(response);
	signal?.throwIfAborted();
	if (!response.ok) {
		const message =
			response.status === 401 || response.status === 403
				? `Meta session expired (HTTP ${response.status}); run /login meta again`
				: `Meta API-key mint failed (HTTP ${response.status})`;
		throw failure(message, body);
	}
	if (!isNonBlankString(body.api_key)) {
		const setup = isNonBlankString(body.action_url)
			? ` Complete setup at ${body.action_url}.`
			: "";
		throw new Error(`Meta did not issue an API key.${setup}`);
	}
	return body.api_key;
}

export async function loginMeta(
	callbacks: OAuthLoginCallbacks,
	fetchImpl: Fetch = globalThis.fetch,
	sleep: Sleep = delay,
	now: Clock = Date.now,
): Promise<OAuthCredentials> {
	// Older Pi callbacks omit signal; its optional structural shape is compatible.
	const compatibleCallbacks: OAuthLoginCallbacks & { signal?: AbortSignal } =
		callbacks;
	const { signal } = compatibleCallbacks;
	try {
		checkLoginCancellation(signal);
		callbacks.onProgress?.("Starting Meta device authorization…");
		const device = await requestDeviceAuthorization(fetchImpl, signal);
		const deadline = now() + device.expiresInSeconds * 1000;
		callbacks.onDeviceCode({
			userCode: device.userCode,
			verificationUri: device.verificationUri,
			intervalSeconds: device.intervalSeconds,
			expiresInSeconds: device.expiresInSeconds,
		});
		callbacks.onProgress?.("Waiting for Meta login approval…");
		const identityToken = await pollIdentityToken(
			device,
			deadline,
			fetchImpl,
			sleep,
			now,
			signal,
		);

		checkLoginCancellation(signal);
		callbacks.onProgress?.("Enabling Meta Model API access…");
		const apiKey = await mintMetaApiKey(identityToken, fetchImpl, signal);
		checkLoginCancellation(signal);
		return {
			refresh: identityToken,
			access: apiKey,
			expires: now() + API_KEY_REFRESH_INTERVAL_MS,
		};
	} catch (error) {
		if (signal?.aborted) {
			throw new Error("Meta login was cancelled", { cause: error });
		}
		throw error;
	}
}

export async function refreshMetaToken(
	credentials: OAuthCredentials,
	fetchOrSignal: Fetch | AbortSignal = globalThis.fetch,
): Promise<OAuthCredentials> {
	if (!isNonBlankString(credentials.refresh)) {
		throw new Error(
			"Meta login is missing its identity token; run /login meta again",
		);
	}
	// Pi 0.83 calls refreshToken(credentials); Pi 0.84 supplies an AbortSignal.
	// The fetch injection in the same slot keeps the public helper testable.
	const fetchImpl =
		typeof fetchOrSignal === "function" ? fetchOrSignal : globalThis.fetch;
	const signal =
		typeof fetchOrSignal === "function" ? undefined : fetchOrSignal;
	if (signal?.aborted) {
		throw new Error("Meta token refresh was cancelled");
	}
	let apiKey: string;
	try {
		apiKey = await mintMetaApiKey(credentials.refresh, fetchImpl, signal);
	} catch (error) {
		if (signal?.aborted) {
			throw new Error("Meta token refresh was cancelled", { cause: error });
		}
		throw error;
	}
	if (signal?.aborted) {
		throw new Error("Meta token refresh was cancelled");
	}
	return {
		...credentials,
		access: apiKey,
		expires: Date.now() + API_KEY_REFRESH_INTERVAL_MS,
	};
}
