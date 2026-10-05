import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {z} from 'zod';
import {getProjectsDir, getRecordingsDir, getUserDataDir} from './paths.js';
import {openProject, resolveProjectPath, saveProject, type RecordlyProject} from './projectStore.js';
import {locked} from './zoomEditing.js';
const reply = (value: unknown) => ({content:[{type:'text' as const,text:JSON.stringify(value,null,2)}]});
const hash = (raw: string) => createHash('sha256').update(raw).digest('hex');
const time = z.number().finite().int().nonnegative();
type Span = {startMs:number;endMs:number};
type Clip = Span & {id:string;speed?:number;[key:string]:unknown};

function sourceClips(p: RecordlyProject): Clip[] {
 if (p.version !== 2) throw new Error('Only verified version-2 source-time projects are supported.');
 for (const key of ['speedRegions']) {
  const list=p.editor[key];
  if (list !== undefined && (!Array.isArray(list) || list.length)) throw new Error(`Existing ${key} is unsupported; no changes written.`);
 }
 const list=p.editor.clipRegions;
 if (!Array.isArray(list) || !list.length) throw new Error('Existing nonempty clipRegions required.');
 let end=0; const ids=new Set<string>();
 for (const c of list) {
  if (!c || typeof c.id!=='string' || !c.id || ids.has(c.id) ||
      !Number.isFinite(c.startMs) || !Number.isFinite(c.endMs) || c.startMs<end || c.endMs<=c.startMs ||
      (c.speed!==undefined && c.speed!==1) || ['sourceStartMs','sourceEndMs','sourcePath','videoPath'].some(k=>k in c)) {
   throw new Error('Unsupported, reordered, overlapping, or invalid clip schema. Requires single-source 1x source-time clips.');
  }
  ids.add(c.id);end=c.endMs;
 }
 const trims=p.editor.trimRegions??[];
 if(!Array.isArray(trims) || trims.some(r=>!r || !Number.isFinite(r.startMs) || !Number.isFinite(r.endMs) || r.startMs<0 || r.endMs<=r.startMs || list.some(c=>r.startMs<c.endMs && r.endMs>c.startMs))) throw new Error('trimRegions conflicts with kept clips; no changes written.');
 return list as Clip[];
}
function mergeRanges(ranges: Span[]): Span[] {
 const result:Span[]=[];
 for (const r of [...ranges].sort((a,b)=>a.startMs-b.startMs)) {
  if (r.endMs<=r.startMs) throw new Error('endMs must exceed startMs.');
  const last=result.at(-1);
  if(last && r.startMs<=last.endMs) last.endMs=Math.max(last.endMs,r.endMs);
  else result.push({...r});
 }
 return result;
}
export function registerProjectEditingTools(server:McpServer) {
 server.tool('get_paths','Resolve the actual recordings and Projects directories, including custom recordings-settings.json.',{},async()=>reply({userDataDir:getUserDataDir(),recordingsDir:await getRecordingsDir(),projectsDir:await getProjectsDir()}));
 server.tool('copy_project','Create a new editable project copy directly in the desktop Projects directory. Preserves media references, assigns a new projectId, and never overwrites.',
  {project:z.string().min(1),name:z.string().min(1)},async({project,name})=>{
   const stem=name.endsWith('.recordly')?name.slice(0,-9):name;
   if (!stem.trim() || stem!==stem.trim() || /[<>:"/\\|?*\x00-\x1f]/.test(stem) || /[. ]$/.test(stem) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(stem)) throw new Error('name must be a plain portable filename without path separators.');
   const source=path.resolve(await resolveProjectPath(project));
   const data=await openProject(source);
   const target=path.join(await getProjectsDir(),stem+'.recordly');
   await fs.writeFile(target,JSON.stringify({...data,projectId:randomUUID()},null,2),{encoding:'utf8',flag:'wx'});
   return reply({project:target,source,mediaCopied:false,visibleInProjectLibrary:true});
  });
 server.tool('cut_ranges','Subtract reviewed SOURCE-time ranges from existing 1x clipRegions. Only the tested Recordly 1.4.0 single-source timeline model. Never moves zoom times or automatically decides which speech to cut. Backups and source-to-output mapping included.',
  {project:z.string().min(1),timelineModel:z.literal('recordly-1.4-source-time'),ranges:z.array(z.object({startMs:time,endMs:time})).min(1),dryRun:z.boolean().default(false),expectedRevision:z.string().optional()},
  async({project,ranges,dryRun,expectedRevision})=>{
   const file=path.resolve(await resolveProjectPath(project));
   return locked(file,async()=>{
    const raw=await fs.readFile(file,'utf8'),revision=hash(raw);
    if(expectedRevision && expectedRevision!==revision) throw new Error('Project changed; reopen it before writing.');
    const p=await openProject(file); const clips=sourceClips(p),cuts=mergeRanges(ranges);
    const oldTrims=(p.editor.trimRegions??[]) as Array<Span & Record<string,unknown>>;
    const sourceEnd=Math.max(clips.at(-1)!.endMs,...oldTrims.map(r=>r.endMs));
    if(cuts.some(r=>r.endMs>sourceEnd)) throw new Error('Cut extends beyond the current source timeline; verify timestamps.');
    const next:Clip[]=[];const origins=new Map<string,string>();
    for(const c of clips){
     let cursor=c.startMs;const spans:Span[]=[];
     for(const cut of cuts){
      if(cut.endMs<=cursor || cut.startMs>=c.endMs) continue;
      if(cut.startMs>cursor) spans.push({startMs:cursor,endMs:cut.startMs});
      cursor=Math.min(c.endMs,Math.max(cursor,cut.endMs));
     }
     if(cursor<c.endMs) spans.push({startMs:cursor,endMs:c.endMs});
     spans.forEach((s,i)=>{const id=i===0?c.id:randomUUID();next.push({...c,...s,id});origins.set(id,c.id);});
    }
    if(!next.length) throw new Error('Refusing to remove all footage.');
    let total=0;const mapping=next.map(c=>{const outputStartMs=total;total+=c.endMs-c.startMs;return {clipId:c.id,startMs:c.startMs,endMs:c.endMs,outputStartMs,outputEndMs:total};});
    const previous=clips.reduce((n,c)=>n+c.endMs-c.startMs,0),changed=total!==previous;
    let gapStart=0;const gaps:Span[]=[];
    for(const c of next){if(c.startMs>gapStart)gaps.push({startMs:gapStart,endMs:c.startMs});gapStart=c.endMs;}
    if(gapStart<sourceEnd)gaps.push({startMs:gapStart,endMs:sourceEnd});
    const trimRegions=gaps.map((g,i)=>({...oldTrims.find(r=>r.startMs===g.startMs&&r.endMs===g.endMs),id:`trim-gap-${i+1}`,...g}));
    const editor:Record<string,unknown>={...p.editor,clipRegions:next,trimRegions};
    const tracks=p.editor.sourceAudioTrackSettingsByClip;
    if(tracks && typeof tracks==='object' && !Array.isArray(tracks)) {
     const before=tracks as Record<string,unknown>;const after:Record<string,unknown>={};
     for(const c of next){const old=origins.get(c.id)!;if(Object.hasOwn(before,old))after[c.id]=before[old];}
     editor.sourceAudioTrackSettingsByClip=after;
    }
    let backupPath:string|null=null,afterRevision=revision;
    if(!dryRun && changed){
     if(await fs.readFile(file,'utf8')!==raw)throw new Error('Project changed while planning; no write.');
     const dir=path.join(path.dirname(file),'.mcp-backups');await fs.mkdir(dir,{recursive:true});
     backupPath=path.join(dir,`${path.basename(file)}.${Date.now()}-${randomUUID()}.recordly`);
     await fs.writeFile(backupPath,raw,{encoding:'utf8',flag:'wx'});
     if(await fs.readFile(file,'utf8')!==raw)throw new Error('Project changed before save; no write.');
     await saveProject(file,{...p,editor});afterRevision=hash(await fs.readFile(file,'utf8'));
    }
    return reply({project:file,dryRun,changed,revision:afterRevision,backupPath,cuts,mapping,removedMs:previous-total,outputDurationMs:total,reloadRequired:changed&&!dryRun,timeBasis:'source milliseconds; timeline gaps are omitted during native export'});
   });
  });
}
