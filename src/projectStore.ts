import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
	getProjectFileExtension,
	getProjectsDir,
	getProjectThumbnailPath,
	hasProjectFileExtension,
} from "./paths.js";

/**
 * We deliberately do NOT model every field of Recordly's real `ProjectEditorState`
 * (src/components/video-editor/projectPersistence.ts has ~60 of them, covering things
 * like motion-blur tuning this server never touches). Instead `editor` is read and
 * written as a generic bag of fields: each tool only reads/replaces the handful of keys
 * it's responsible for and passes everything else through untouched, so a project this
 * server edits still opens correctly in the Recordly desktop app with all of its other
 * settings intact.
 */
export interface RecordlyProject {
	version: number;
	projectId?: string;
	videoPath: string;
	editor: Record<string, unknown>;
	[key: string]: unknown;
}

export const PROJECT_VERSION = 1;

function isPlainProject(candidate: unknown): candidate is RecordlyProject {
	if (!candidate || typeof candidate !== "object") return false;
	const project = candidate as Partial<RecordlyProject>;
	return (
		typeof project.version === "number" &&
		typeof project.videoPath === "string" &&
		project.videoPath.trim().length > 0 &&
		typeof project.editor === "object" &&
		project.editor !== null
	);
}

/** Ported from electron/ipc/project/atomicSave.ts, which has no Electron dependency of its own. */
async function writeProjectFileAtomically(projectPath: string, contents: string): Promise<void> {
	const targetPath = path.resolve(projectPath);
	const parentDir = path.dirname(targetPath);
	const temporaryPath = path.join(parentDir, `.recordly-mcp-${process.pid}-${randomUUID()}.tmp`);

	await fs.mkdir(parentDir, { recursive: true });
	await fs.writeFile(temporaryPath, contents, "utf-8");
	await fs.rename(temporaryPath, targetPath);
}

export async function resolveProjectPath(nameOrPath: string): Promise<string> {
	if (path.isAbsolute(nameOrPath)) {
		return nameOrPath;
	}
	const projectsDir = await getProjectsDir();
	const fileName = hasProjectFileExtension(nameOrPath)
		? nameOrPath
		: `${nameOrPath}.${getProjectFileExtension()}`;
	return path.join(projectsDir, fileName);
}

export interface ProjectListEntry {
	path: string;
	name: string;
	videoPath: string;
	updatedAt: number;
}

export async function listProjects(): Promise<ProjectListEntry[]> {
	const projectsDir = await getProjectsDir();
	const entries = await fs.readdir(projectsDir, { withFileTypes: true }).catch(() => []);

	const results: ProjectListEntry[] = [];
	for (const entry of entries) {
		if (!entry.isFile() || !hasProjectFileExtension(entry.name)) continue;
		const fullPath = path.join(projectsDir, entry.name);
		try {
			const [stats, project] = await Promise.all([fs.stat(fullPath), openProject(fullPath)]);
			results.push({
				path: fullPath,
				name: path.basename(entry.name, path.extname(entry.name)),
				videoPath: project.videoPath,
				updatedAt: stats.mtimeMs,
			});
		} catch {
			// Skip files that aren't readable/valid project data.
		}
	}

	return results.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function openProject(projectPath: string): Promise<RecordlyProject> {
	const raw = await fs.readFile(projectPath, "utf-8");
	const parsed: unknown = JSON.parse(raw);
	if (!isPlainProject(parsed)) {
		throw new Error(`${projectPath} is not a valid Recordly project file`);
	}
	return parsed;
}

export async function saveProject(projectPath: string, project: RecordlyProject): Promise<void> {
	await writeProjectFileAtomically(projectPath, JSON.stringify(project, null, 2));
}

/** Minimal defaults for a brand-new project — matches the fields Recordly's own
 * `normalizeProjectEditor` falls back to for a project with no prior edits. */
/** Matches the real defaults in src/components/video-editor/projectPersistence.ts /
 * types.ts (`DEFAULT_WALLPAPER_PATH`, `DEFAULT_PADDING`, and `normalizeProjectEditor`'s
 * fallbacks), so a brand-new project here looks the same as one created in the app. */
function defaultEditorState(): Record<string, unknown> {
	return {
		wallpaper: "/wallpapers/tahoe-light.jpg",
		shadowIntensity: 0.67,
		frame: null,
		borderRadius: 12.5,
		padding: { top: 20, bottom: 20, left: 20, right: 20, linked: true },
		aspectRatio: "16:9",
		zoomRegions: [],
		trimRegions: [],
		clipRegions: [],
		speedRegions: [],
		annotationRegions: [],
		audioRegions: [],
		autoCaptions: [],
		webcam: { enabled: false, sourcePath: null },
		exportFormat: "mp4",
	};
}

export async function createProject(videoPath: string, name?: string): Promise<string> {
	const projectsDir = await getProjectsDir();
	const safeName =
		name?.trim().replace(/[<>:"/\\|?*]/g, "") || `project-${Date.now()}`;
	const projectPath = path.join(projectsDir, `${safeName}.${getProjectFileExtension()}`);

	const project: RecordlyProject = {
		version: PROJECT_VERSION,
		projectId: randomUUID(),
		videoPath: path.resolve(videoPath),
		editor: defaultEditorState(),
	};

	await saveProject(projectPath, project);
	return projectPath;
}

export { getProjectThumbnailPath };
