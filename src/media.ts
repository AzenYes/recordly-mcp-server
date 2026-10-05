import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { getFfmpegPath, getFfprobePath } from "./binaries.js";

const execFileAsync = promisify(execFile);

export interface MediaInfo {
	durationMs: number;
	width: number | null;
	height: number | null;
	frameRate: number | null;
	hasAudio: boolean;
	hasVideo: boolean;
}

interface FfprobeStream {
	codec_type: string;
	width?: number;
	height?: number;
	r_frame_rate?: string;
	avg_frame_rate?: string;
}

interface FfprobeOutput {
	format?: { duration?: string };
	streams?: FfprobeStream[];
}

function parseFrameRate(rate: string | undefined): number | null {
	if (!rate) return null;
	const [num, den] = rate.split("/").map(Number);
	if (!num || !den) return null;
	const value = num / den;
	return Number.isFinite(value) ? value : null;
}

export async function getMediaInfo(filePath: string): Promise<MediaInfo> {
	const { stdout } = await execFileAsync(getFfprobePath(), [
		"-v",
		"quiet",
		"-print_format",
		"json",
		"-show_format",
		"-show_streams",
		filePath,
	]);

	const parsed = JSON.parse(stdout) as FfprobeOutput;
	const videoStream = parsed.streams?.find((stream) => stream.codec_type === "video");
	const audioStream = parsed.streams?.find((stream) => stream.codec_type === "audio");
	const durationSec = Number(parsed.format?.duration ?? 0);

	return {
		durationMs: Number.isFinite(durationSec) ? Math.round(durationSec * 1000) : 0,
		width: videoStream?.width ?? null,
		height: videoStream?.height ?? null,
		frameRate: parseFrameRate(videoStream?.avg_frame_rate ?? videoStream?.r_frame_rate),
		hasAudio: Boolean(audioStream),
		hasVideo: Boolean(videoStream),
	};
}

export interface SilenceInterval {
	startMs: number;
	endMs: number;
}

/**
 * Mirrors the noise floor / minimum duration Recordly's own caption re-segmenter uses
 * (electron/ipc/captions/silence.ts), so silence detected here lines up with how the app
 * already thinks about "silence" elsewhere in the codebase.
 */
const SILENCE_NOISE_DB = -30;
const SILENCE_DETECT_MIN_S = 0.5;

export async function detectSilence(
	filePath: string,
	options?: { noiseDb?: number; minDurationSec?: number },
): Promise<SilenceInterval[]> {
	const noiseDb = options?.noiseDb ?? SILENCE_NOISE_DB;
	const minDurationSec = options?.minDurationSec ?? SILENCE_DETECT_MIN_S;

	const stderr = await new Promise<string>((resolve, reject) => {
		const child = spawn(getFfmpegPath(), [
			"-i",
			filePath,
			"-af",
			`silencedetect=noise=${noiseDb}dB:d=${minDurationSec}`,
			"-f",
			"null",
			"-",
		]);
		let output = "";
		child.stderr.on("data", (chunk: Buffer) => {
			output += chunk.toString();
		});
		child.on("error", reject);
		child.on("close", (code) => code === 0 ? resolve(output) : reject(new Error(`ffmpeg failed (${code}): ${output.slice(-1500)}`)));
	});

	const intervals: SilenceInterval[] = [];
	let pendingStartSec: number | null = null;

	for (const line of stderr.split("\n")) {
		const startMatch = line.match(/silence_start:\s*(-?[\d.]+)/);
		if (startMatch) {
			pendingStartSec = Number(startMatch[1]);
			continue;
		}
		const endMatch = line.match(/silence_end:\s*(-?[\d.]+)/);
		if (endMatch && pendingStartSec !== null) {
			intervals.push({
				startMs: Math.round(pendingStartSec * 1000),
				endMs: Math.round(Number(endMatch[1]) * 1000),
			});
			pendingStartSec = null;
		}
	}

	return intervals;
}

export interface SceneChange {
	timestampMs: number;
	/** 0-1, how different this frame is from the previous one — higher means a bigger visual jump. */
	score: number;
}

/**
 * Detects moments of significant visual change (a new screen appearing, a message
 * being sent, a dialog opening) via ffmpeg's scene-detection filter. This is the main
 * signal for finding "worth zooming into" moments in recordings with no cursor
 * telemetry to fall back on (touch/mobile screen recordings, or any video with the
 * mouse untracked) — detect_silence/suggest_zooms don't help there since there's often
 * no audio and no mouse.
 */
export async function detectSceneChanges(filePath: string, threshold = 0.15): Promise<SceneChange[]> {
	const stderr = await new Promise<string>((resolve, reject) => {
		const child = spawn(getFfmpegPath(), [
			"-i",
			filePath,
			"-filter:v",
			`select='gt(scene,${threshold})',showinfo`,
			"-f",
			"null",
			"-",
		]);
		let output = "";
		child.stderr.on("data", (chunk: Buffer) => {
			output += chunk.toString();
		});
		child.on("error", reject);
		child.on("close", (code) => code === 0 ? resolve(output) : reject(new Error(`ffmpeg failed (${code}): ${output.slice(-1500)}`)));
	});

	const changes: SceneChange[] = [];
	for (const line of stderr.split("\n")) {
		if (!line.includes("Parsed_showinfo")) continue;
		const timeMatch = line.match(/pts_time:([\d.]+)/);
		const scoreMatch = line.match(/scene_score\s*[:=]\s*([\d.]+)/) ?? line.match(/lavfi\.scene_score=([\d.]+)/);
		if (!timeMatch) continue;
		changes.push({
			timestampMs: Math.round(Number(timeMatch[1]) * 1000),
			score: scoreMatch ? Number(scoreMatch[1]) : threshold,
		});
	}

	return changes;
}
