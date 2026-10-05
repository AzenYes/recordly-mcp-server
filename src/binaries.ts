import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
function binary(name: string, variable: string): string {
 const override = process.env[variable];
 if (override) { if (!existsSync(override)) throw new Error(`${variable} does not exist`); return override; }
 const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [name], {encoding:'utf8'});
 const found = r.stdout?.trim().split(/\r?\n/)[0];
 if (r.status !== 0 || !found || !existsSync(found)) throw new Error(`Install ${name} on PATH or set ${variable}.`);
 return found;
}
export const getFfmpegPath = () => binary('ffmpeg', 'FFMPEG_PATH');
export const getFfprobePath = () => binary('ffprobe', 'FFPROBE_PATH');
