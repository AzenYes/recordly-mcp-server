import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

/**
 * The app's Electron main process resolves these via `app.getPath(...)`, which isn't
 * available outside a running Electron process. This mirrors Electron's own convention
 * (appData base + productName) so this server reads/writes the same directories the
 * desktop app uses, without needing the app itself to be running.
 *
 * PRODUCT_NAME must match `productName` in the root package.json / electron-builder.json5
 * exactly — that's what Electron's `app.getPath("userData")` actually keys off of, not
 * the project file extension below (which is intentionally unchanged from Recordly's
 * `.recordly` format — see mcp-server/README.md for why that wasn't renamed too).
 *
 * Override with RECORDLY_USER_DATA_DIR for a dev instance or a non-default install.
 */
const PRODUCT_NAME = "Recordly";
const PROJECT_FILE_EXTENSION = "recordly";
const PROJECTS_DIRECTORY_NAME = "Projects";
const PROJECT_THUMBNAIL_SUFFIX = ".preview.png";

function defaultAppDataDir(): string {
	const platform = process.platform;
	if (platform === "darwin") {
		return path.join(os.homedir(), "Library", "Application Support");
	}
	if (platform === "win32") {
		return process.env["APPDATA"] ?? path.join(os.homedir(), "AppData", "Roaming");
	}
	return process.env["XDG_CONFIG_HOME"] ?? path.join(os.homedir(), ".config");
}

export function getUserDataDir(): string {
	if (process.env["RECORDLY_USER_DATA_DIR"]) {
		return process.env["RECORDLY_USER_DATA_DIR"];
	}
	return path.join(defaultAppDataDir(), PRODUCT_NAME);
}

async function readCustomRecordingsDir(userDataDir: string): Promise<string | null> {
	try {
		const raw = await fs.readFile(path.join(userDataDir, "recordings-settings.json"), "utf-8");
		const parsed = JSON.parse(raw) as { recordingsDir?: unknown };
		if (typeof parsed.recordingsDir === "string" && parsed.recordingsDir.trim()) {
			return path.resolve(parsed.recordingsDir);
		}
	} catch {
		// No custom setting saved — fall back to the default recordings dir.
	}
	return null;
}

export async function getRecordingsDir(): Promise<string> {
	const userDataDir = getUserDataDir();
	const custom = await readCustomRecordingsDir(userDataDir);
	const dir = custom ?? path.join(userDataDir, "recordings");
	await fs.mkdir(dir, { recursive: true });
	return dir;
}

export async function getProjectsDir(): Promise<string> {
	const dir = path.join(await getRecordingsDir(), PROJECTS_DIRECTORY_NAME);
	await fs.mkdir(dir, { recursive: true });
	return dir;
}

export function hasProjectFileExtension(filePath: string): boolean {
	return path.extname(filePath).toLowerCase() === `.${PROJECT_FILE_EXTENSION}`;
}

export function getProjectFileExtension(): string {
	return PROJECT_FILE_EXTENSION;
}

export function getProjectThumbnailPath(projectPath: string): string {
	return `${projectPath}${PROJECT_THUMBNAIL_SUFFIX}`;
}
