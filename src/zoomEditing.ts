import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { openProject, resolveProjectPath, saveProject, type RecordlyProject } from "./projectStore.js";
import { ZOOM_DEPTH_SCALES } from "./zoomRenderer.js";

type Region = Record<string, unknown> & { id: string; startMs: number; endMs: number };
const time = z.number().finite().int().nonnegative();
const range = {
	startMs: time.optional().describe("Source/project time in milliseconds, inclusive. Supply together with endMs."),
	endMs: time.optional().describe("Source/project time in milliseconds, exclusive. Supply together with startMs."),
};
const projectArg = z.string().min(1).describe("Project name or absolute .recordly path. Save/close this project in Recordly before writing; reopen afterwards. Prefer a working copy.");
const writeArgs = {
	expectedRevision: z.string().optional().describe("Optional SHA-256 revision from list_zooms; reject if the project changed."),
	dryRun: z.boolean().default(false).describe("Preview the exact change without writing or creating a backup."),
};
const queues = new Map<string, Promise<unknown>>();
const revision = (raw: string) => createHash("sha256").update(raw).digest("hex");
const result = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });

function regions(project: RecordlyProject): Region[] {
	const list = project.editor.zoomRegions ?? [];
	if (!Array.isArray(list)) throw new Error("zoomRegions must be an array.");
	const ids = new Set<string>();
	for (const r of list) {
		if (!r || typeof r.id !== "string" || !r.id || ids.has(r.id) ||
			!Number.isFinite(r.startMs) || !Number.isFinite(r.endMs) || r.startMs < 0 || r.endMs <= r.startMs) {
			throw new Error("Invalid zoom region or duplicate ID; project was not modified.");
		}
		ids.add(r.id);
	}
	return list as Region[];
}

function checkRange(startMs?: number, endMs?: number): boolean {
	if (startMs === undefined && endMs === undefined) return false;
	if (startMs === undefined || endMs === undefined || endMs <= startMs) {
		throw new Error("Supply both startMs and endMs, with endMs > startMs.");
	}
	return true;
}

// Serializes this server's writes. Revision checks additionally detect desktop edits
// observed before saving; the desktop app itself does not honor this local queue.
export async function locked<T>(file: string, action: () => Promise<T>): Promise<T> {
	const key = process.platform === "win32" ? file.toLowerCase() : file;
	const previous = queues.get(key) ?? Promise.resolve();
	const current = previous.catch(() => {}).then(action);
	queues.set(key, current);
	try { return await current; }
	finally { if (queues.get(key) === current) queues.delete(key); }
}

async function mutate(
	name: string,
	expectedRevision: string | undefined,
	dryRun: boolean,
	edit: (project: RecordlyProject) => { next: Region[]; changes: unknown; count: number },
) {
	const file = path.resolve(await resolveProjectPath(name));
	return locked(file, async () => {
		const raw = await fs.readFile(file, "utf8");
		const beforeRevision = revision(raw);
		if (expectedRevision !== undefined && expectedRevision !== beforeRevision) {
			throw new Error("Project changed since it was read. List zooms again before editing.");
		}
		const project = await openProject(file);
		if (await fs.readFile(file, "utf8") !== raw) throw new Error("Project changed while loading; retry after closing it in Recordly.");
		const editResult = edit(project);
		const changed = JSON.stringify(project.editor.zoomRegions ?? []) !== JSON.stringify(editResult.next);
		let backupPath: string | null = null;
		let afterRevision = beforeRevision;
		if (!dryRun && changed) {
			const backupDir = path.join(path.dirname(file), ".mcp-backups");
			await fs.mkdir(backupDir, { recursive: true });
			backupPath = path.join(backupDir, `${path.basename(file)}.${Date.now()}-${randomUUID()}.recordly`);
			await fs.writeFile(backupPath, raw, { encoding: "utf8", flag: "wx" });
			if (await fs.readFile(file, "utf8") !== raw) throw new Error("Project changed before save; no changes were written. Close it in Recordly and retry.");
			await saveProject(file, { ...project, editor: { ...project.editor, zoomRegions: editResult.next } });
			afterRevision = revision(await fs.readFile(file, "utf8"));
		}
		return result({ project: file, dryRun, changed, matchedCount: editResult.count,
			changes: editResult.changes, backupPath, revision: afterRevision,
			reloadRequired: !dryRun && changed,
			timeBasis: "source/project milliseconds, not the shortened exported video" });
	});
}

export function registerZoomEditingTools(server: McpServer) {
	server.tool("list_zooms",
		"List existing zoom IDs, times, depth and focus before editing. Optional half-open source-time range selects overlapping regions. depth is a discrete level, not an arbitrary scale. Native Recordly export preserves its animation; MCP ffmpeg export differs.",
		{ project: projectArg, ...range },
		async ({ project, startMs, endMs }) => {
			const hasRange = checkRange(startMs, endMs);
			const file = path.resolve(await resolveProjectPath(project));
			const raw = await fs.readFile(file, "utf8");
			const data = JSON.parse(raw) as RecordlyProject;
			const all = regions(data);
			const selected = all.filter(r => !hasRange || (r.startMs < endMs! && r.endMs > startMs!));
			return result({ project: file, revision: revision(raw), totalCount: all.length,
				zoomRegions: [...selected].sort((a, b) => a.startMs - b.startMs),
				depthScales: ZOOM_DEPTH_SCALES,
				timeBasis: "source/project milliseconds, not the shortened exported video" });
		});

	server.tool("update_zoom",
		"Edit one EXISTING zoom by ID: adjust depth, focus, start/end, or auto/manual mode. Unspecified and unknown fields are preserved. Use mode=manual with a fixed focus to avoid automatic cursor-follow for this region. Saves an automatic backup; does not render or change video cuts.",
		{ project: projectArg, zoomId: z.string().min(1),
			startMs: time.optional(), endMs: time.optional(),
			depth: z.number().int().min(1).max(6).optional().describe("Discrete zoom strength. Lower is less magnified; see list_zooms depthScales."),
			focusX: z.number().finite().min(0).max(1).optional(),
			focusY: z.number().finite().min(0).max(1).optional(),
			mode: z.enum(["auto", "manual"]).optional(), ...writeArgs },
		async ({ project, zoomId, expectedRevision, dryRun, ...patch }) => mutate(project, expectedRevision, dryRun, data => {
			const all = regions(data);
			const before = all.find(r => r.id === zoomId);
			if (!before) throw new Error(`Zoom ID not found: ${zoomId}`);
			if (!Object.values(patch).some(v => v !== undefined)) throw new Error("Supply at least one zoom field to update.");
			const after = { ...before };
			if (patch.startMs !== undefined) after.startMs = patch.startMs;
			if (patch.endMs !== undefined) after.endMs = patch.endMs;
			if (patch.depth !== undefined) after.depth = patch.depth;
			if (patch.mode !== undefined) after.mode = patch.mode;
			checkRange(after.startMs, after.endMs);
			if (patch.focusX !== undefined || patch.focusY !== undefined) {
				const old = before.focus;
				if (old !== undefined && (!old || typeof old !== "object" || Array.isArray(old))) throw new Error("Invalid existing focus; no changes written.");
				after.focus = { cx: 0.5, cy: 0.5, ...(old as Record<string, unknown> | undefined),
					...(patch.focusX !== undefined ? { cx: patch.focusX } : {}),
					...(patch.focusY !== undefined ? { cy: patch.focusY } : {}) };
			}
			return { next: all.map(r => r.id === zoomId ? after : r), changes: { before, after }, count: 1 };
		}));

	server.tool("delete_zooms",
		"Remove existing zoom effects, leaving the video intact. Select EITHER explicit zoomIds OR a half-open source-time startMs/endMs range. Range matching defaults to overlap and deletes whole matching zoom regions, including portions outside the requested range; use dryRun to inspect, or contained to select only fully contained effects. No selector is rejected. Automatic backup on change.",
		{ project: projectArg, zoomIds: z.array(z.string().min(1)).min(1).optional(), ...range,
			match: z.enum(["overlap", "contained"]).default("overlap"), ...writeArgs },
		async ({ project, zoomIds, startMs, endMs, match, expectedRevision, dryRun }) => mutate(project, expectedRevision, dryRun, data => {
			const hasRange = checkRange(startMs, endMs);
			if (Boolean(zoomIds) === hasRange) throw new Error("Select either zoomIds or a startMs/endMs range, never both or neither.");
			const all = regions(data);
			if (zoomIds) {
				const missing = zoomIds.filter(id => !all.some(r => r.id === id));
				if (missing.length) throw new Error(`Zoom IDs not found; nothing deleted: ${missing.join(", ")}`);
			}
			const removed = all.filter(r => zoomIds ? zoomIds.includes(r.id) :
				match === "contained" ? r.startMs >= startMs! && r.endMs <= endMs! : r.startMs < endMs! && r.endMs > startMs!);
			const ids = new Set(removed.map(r => r.id));
			return { next: all.filter(r => !ids.has(r.id)), changes: { removed }, count: removed.length };
		}));
}
