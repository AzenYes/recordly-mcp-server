#!/usr/bin/env node
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {z} from 'zod';
import {listProjects,openProject,resolveProjectPath} from './projectStore.js';
import {getMediaInfo,detectSilence} from './media.js';
import {extractSampleFrames} from './exporter.js';
import {registerZoomEditingTools} from './zoomEditing.js';
import {registerProjectEditingTools} from './projectEditing.js';
const server=new McpServer({name:'screen-edit-mcp',version:'0.2.0'},{instructions:'Unofficial Recordly-compatible editing tools, derived from ClipAgent and Recordly (webadderall), AGPLv3; see LICENSE.md and NOTICE.md. Copy projects before editing; save/close in the desktop before disk writes and reopen afterwards. All edit times are SOURCE times, not shortened output times. Silence and cursor clicks are evidence, not automatic deletion decisions. cut_ranges requires verified Recordly 1.4.0 source-time clips. Preserve native visual rendering by exporting in the desktop; this server does not implement native rendering or built-in ASR.'});
const reply=(data:unknown)=>({content:[{type:'text' as const,text:JSON.stringify(data,null,2)}]});
registerZoomEditingTools(server);registerProjectEditingTools(server);
server.tool('list_projects','List projects in the desktop Projects directory.',{},async()=>reply(await listProjects()));
server.tool('open_project','Read project state and revision before source-time edits.',{project:z.string()},async({project})=>{
 const file=await resolveProjectPath(project);const raw=await fs.readFile(file,'utf8');const data=await openProject(file);
 if(await fs.readFile(file,'utf8')!==raw)throw new Error('Project changed while reading; retry.');
 return reply({path:file,...data,revision:createHash('sha256').update(raw).digest('hex')});
});
server.tool('get_media_info','Inspect source video or separate microphone audio.',{filePath:z.string()},async({filePath})=>reply(await getMediaInfo(filePath)));
server.tool('detect_silence','Report candidate quiet intervals in the supplied audio, not automatic cuts. Separate mic times require adding its startDelayMs before editing.',{filePath:z.string(),minDurationSec:z.number().positive().default(1),noiseDb:z.number().max(0).default(-38)},async({filePath,minDurationSec,noiseDb})=>reply(await detectSilence(filePath,{minDurationSec,noiseDb})));
server.tool('scan_frames','Inspect raw source frames around candidate speech cuts or distracting zooms. These frames do not show the project zoom overlay; compare native previews too.',{filePath:z.string(),sampleCount:z.number().int().min(1).max(20).default(6),startMs:z.number().nonnegative().default(0),endMs:z.number().positive().optional()},async({filePath,sampleCount,startMs,endMs})=>{
 if(endMs!==undefined && endMs<=startMs)throw new Error('endMs must exceed startMs');
 const frames=await extractSampleFrames(filePath,sampleCount,{startMs,endMs:endMs??Number.MAX_SAFE_INTEGER});
 return {content:[{type:'text' as const,text:JSON.stringify(frames.map(f=>({timestampMs:f.timestampMs})))},...frames.map(f=>({type:'image' as const,data:f.pngBase64,mimeType:'image/png'}))]};
});
await server.connect(new StdioServerTransport());
