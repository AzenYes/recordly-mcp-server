import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { getFfmpegPath } from "./binaries.js";
import { getMediaInfo } from "./media.js";

const execFileAsync = promisify(execFile);

export interface PreviewFrame {
	timestampMs: number;
	pngBase64: string;
}

/** Samples evenly spaced frames from a video file (or a sub-range of it) as PNGs. */
export async function extractSampleFrames(
	videoPath: string,
	sampleCount = 4,
	range?: { startMs: number; endMs: number },
): Promise<PreviewFrame[]> {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "recordly-mcp-frames-"));
	try {
		const previewInfo = await getMediaInfo(videoPath);
		const rangeStartMs = Math.max(0, range?.startMs ?? 0);
		const rangeEndMs = Math.min(previewInfo.durationMs, range?.endMs ?? previewInfo.durationMs);
		const rangeDurationMs = Math.max(1, rangeEndMs - rangeStartMs);
		const frames: PreviewFrame[] = [];

		for (let i = 0; i < sampleCount; i++) {
			const timestampMs = Math.round(rangeStartMs + ((i + 0.5) / sampleCount) * rangeDurationMs);
			const framePath = path.join(tempDir, `frame-${i}-${randomUUID()}.png`);
			await execFileAsync(getFfmpegPath(), [
				"-y",
				"-ss",
				(timestampMs / 1000).toFixed(3),
				"-i",
				videoPath,
				"-frames:v",
				"1",
				framePath,
			]);
			const buffer = await fs.readFile(framePath);
			frames.push({ timestampMs, pngBase64: buffer.toString("base64") });
		}

		return frames;
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
	}
}
