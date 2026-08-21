import { spawn } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
} from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const AGENT_DIR = join(homedir(), ".pi/agent");
const HELPER_DIR = dirname(fileURLToPath(import.meta.url));
const HELPER_SOURCE = join(HELPER_DIR, "macos-audio.swift");
const HELPER_PLIST = join(HELPER_DIR, "Info.plist");
const HELPER_ENTITLEMENTS = join(HELPER_DIR, "Entitlements.plist");
const HELPER_BINARY = join(AGENT_DIR, "bin/pi-meta-oauth-voice-v1");
const WINDOWS_HELPER_SOURCE = join(HELPER_DIR, "windows-audio.cs");
const WINDOWS_HELPER_PS1 = join(HELPER_DIR, "windows-audio.ps1");
const WINDOWS_HELPER_BINARY = join(AGENT_DIR, "bin/pi-meta-oauth-voice-v1.exe");
const LINUX_HELPER_SCRIPT = join(HELPER_DIR, "linux-audio.sh");

export function isMacOS(): boolean {
	return platform() === "darwin";
}

export function isWindows(): boolean {
	return platform() === "win32";
}

export function isLinux(): boolean {
	return platform() === "linux";
}

export function isWSL(): boolean {
	if (!isLinux()) return false;
	try {
		return readFileSync("/proc/version", "utf8")
			.toLowerCase()
			.includes("microsoft");
	} catch {
		return false;
	}
}

export function isSupportedPlatform(): boolean {
	return isMacOS() || isWindows() || isLinux();
}

export function supportedPlatformLabel(): string {
	if (isMacOS()) return "macOS";
	if (isWindows()) return "Windows";
	if (isWSL()) return "WSL (Linux)";
	if (isLinux()) return "Linux";
	return `${platform()}`;
}

async function runProcess(command: string, args: string[]): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout?.on("data", (chunk: Buffer) => {
			stdout = `${stdout}${chunk.toString("utf8")}`.slice(-8_000);
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr = `${stderr}${chunk.toString("utf8")}`.slice(-8_000);
		});
		child.once("error", reject);
		child.once("close", (code) => {
			if (code === 0) {
				resolve();
				return;
			}
			reject(
				new Error(
					(
						stderr ||
						stdout ||
						`${command} exited with code ${code ?? "unknown"}`
					).trim(),
				),
			);
		});
	});
}

function helperNeedsBuild(): boolean {
	if (!existsSync(HELPER_BINARY)) return true;
	const binaryTime = statSync(HELPER_BINARY).mtimeMs;
	return [HELPER_SOURCE, HELPER_PLIST, HELPER_ENTITLEMENTS].some(
		(path) => !existsSync(path) || statSync(path).mtimeMs > binaryTime,
	);
}

function windowsHelperNeedsBuild(): boolean {
	if (!existsSync(WINDOWS_HELPER_BINARY)) return true;
	if (!existsSync(WINDOWS_HELPER_SOURCE)) return false;
	return statSync(WINDOWS_HELPER_SOURCE).mtimeMs > statSync(WINDOWS_HELPER_BINARY).mtimeMs;
}

function removeIfExists(path: string): void {
	try {
		unlinkSync(path);
	} catch {
		// Staging or previous binary may already be gone.
	}
}

async function ensureMacOSHelper(): Promise<string> {
	if (!isMacOS()) {
		throw new Error(
			"Muse-style voice input is currently available only on macOS and Windows",
		);
	}
	if (
		!existsSync(HELPER_SOURCE) ||
		!existsSync(HELPER_PLIST) ||
		!existsSync(HELPER_ENTITLEMENTS)
	) {
		throw new Error("The macOS microphone helper sources are incomplete");
	}
	if (!helperNeedsBuild()) return HELPER_BINARY;

	mkdirSync(join(AGENT_DIR, "bin"), { recursive: true });
	const staging = `${HELPER_BINARY}.building`;
	removeIfExists(staging);
	try {
		await runProcess("/usr/bin/xcrun", [
			"swiftc",
			HELPER_SOURCE,
			"-o",
			staging,
			"-framework",
			"AVFoundation",
			"-Xlinker",
			"-sectcreate",
			"-Xlinker",
			"__TEXT",
			"-Xlinker",
			"__info_plist",
			"-Xlinker",
			HELPER_PLIST,
		]);
		await runProcess("/usr/bin/codesign", [
			"--force",
			"--sign",
			"-",
			"--entitlements",
			HELPER_ENTITLEMENTS,
			staging,
		]);
		renameSync(staging, HELPER_BINARY);
	} catch (error) {
		removeIfExists(staging);
		throw error;
	}
	return HELPER_BINARY;
}

async function tryCompileWindowsHelper(): Promise<boolean> {
	if (!existsSync(WINDOWS_HELPER_SOURCE)) return false;
	mkdirSync(join(AGENT_DIR, "bin"), { recursive: true });

	const candidates: string[] = [
		"csc",
		"csc.exe",
		"C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe",
		"C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe",
	];
	const staging = `${WINDOWS_HELPER_BINARY}.building`;
	removeIfExists(staging);
	for (const c of candidates) {
		try {
			await runProcess(c, [
				"/nologo",
				"/target:exe",
				`/out:${staging}`,
				WINDOWS_HELPER_SOURCE,
			]);
			if (existsSync(staging)) {
				renameSync(staging, WINDOWS_HELPER_BINARY);
				return true;
			}
		} catch {
			removeIfExists(staging);
		}
	}
	return false;
}

function findPowerShellCommand(): string {
	if (existsSync("C:\\Program Files\\PowerShell\\7\\pwsh.exe"))
		return "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
	if (existsSync("C:\\Program Files\\PowerShell\\7\\pwsh")) return "pwsh";
	if (
		existsSync("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe")
	)
		return "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
	return "powershell.exe";
}

async function ensureWindowsHelper(): Promise<{
	command: string;
	args: string[];
}> {
	if (!isWindows()) {
		throw new Error(
			"Muse-style voice input is currently available only on macOS and Windows",
		);
	}
	if (!existsSync(WINDOWS_HELPER_SOURCE) && !existsSync(WINDOWS_HELPER_PS1)) {
		throw new Error("The Windows microphone helper sources are incomplete");
	}

	if (existsSync(WINDOWS_HELPER_BINARY) && !windowsHelperNeedsBuild()) {
		return { command: WINDOWS_HELPER_BINARY, args: [] };
	}

	if (existsSync(WINDOWS_HELPER_SOURCE)) {
		const compiled = await tryCompileWindowsHelper();
		if (compiled && existsSync(WINDOWS_HELPER_BINARY)) {
			return { command: WINDOWS_HELPER_BINARY, args: [] };
		}
	}

	if (existsSync(WINDOWS_HELPER_PS1)) {
		const ps = findPowerShellCommand();
		return {
			command: ps,
			args: [
				"-NoProfile",
				"-ExecutionPolicy",
				"Bypass",
				"-File",
				WINDOWS_HELPER_PS1,
			],
		};
	}

	throw new Error(
		"Windows voice helper could not be prepared — no compiled binary and no PowerShell fallback found",
	);
}

function ensureLinuxHelper(): { command: string; args: string[] } {
	if (!isLinux()) {
		throw new Error(
			"Muse-style voice input is currently available only on macOS, Windows, and Linux",
		);
	}
	if (!existsSync(LINUX_HELPER_SCRIPT)) {
		throw new Error("The Linux microphone helper script is missing");
	}
	return { command: "/bin/bash", args: [LINUX_HELPER_SCRIPT] };
}

export async function ensureHelper(): Promise<{
	command: string;
	args: string[];
}> {
	if (isMacOS()) {
		const bin = await ensureMacOSHelper();
		return { command: bin, args: [] };
	}
	if (isWindows()) {
		return ensureWindowsHelper();
	}
	if (isLinux()) {
		return ensureLinuxHelper();
	}
	throw new Error(
		`Muse-style voice input is currently available only on macOS, Windows, and Linux (current: ${supportedPlatformLabel()})`,
	);
}
