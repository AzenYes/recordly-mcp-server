import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
let dir,client,serial=0;
const base={version:2,projectId:'original',videoPath:'screen.mp4',future:{preserve:true},editor:{clipRegions:[{id:'a',startMs:0,endMs:10000,speed:1,muted:false,custom:7}],trimRegions:[],speedRegions:[],zoomRegions:[{id:'z',startMs:4000,endMs:8000,depth:2}],webcam:{sourcePath:'camera.mp4'},sourceAudioTrackSettingsByClip:{a:{mic:{volume:.8}}}}};
before(async()=>{dir=await fs.mkdtemp(path.join(os.tmpdir(),'screen-edit-test-'));await fs.writeFile(path.join(dir,'recordings-settings.json'),JSON.stringify({recordingsDir:path.join(dir,'custom-recordings')}));client=new Client({name:'tests',version:'1'});await client.connect(new StdioClientTransport({command:process.execPath,args:[path.resolve('dist/index.js')],env:{...process.env,RECORDLY_USER_DATA_DIR:dir}}));});
after(async()=>{await client?.close();if(dir)await fs.rm(dir,{recursive:true,force:true});});
async function fixture(p=base){const f=path.join(dir,`source-${serial++}.recordly`);await fs.writeFile(f,JSON.stringify(p));return f;}
async function call(name,args,error=false){const r=await client.callTool({name,arguments:args});if(error){assert.equal(r.isError,true);return;}assert(!r.isError,JSON.stringify(r));return JSON.parse(r.content[0].text);}
const cut=(project,ranges,extra={})=>call('cut_ranges',{project,ranges,timelineModel:'recordly-1.4-source-time',...extra});
test('resolves custom directory; exclusive copy preserves source and uses a new project identity',async()=>{
 const p=await fixture(),raw=await fs.readFile(p,'utf8');const paths=await call('get_paths',{});
 assert.equal(paths.projectsDir,path.join(dir,'custom-recordings','Projects'));
 const c=await call('copy_project',{project:p,name:'测试 剪辑'});assert.equal(path.dirname(c.project),paths.projectsDir);
 const data=JSON.parse(await fs.readFile(c.project,'utf8'));assert.notEqual(data.projectId,base.projectId);assert.deepEqual(data.editor,base.editor);
 await call('copy_project',{project:p,name:'测试 剪辑'},true);
 for(const name of ['../escape','CON','foo.','nested/test'])await call('copy_project',{project:p,name},true);
 assert.equal(await fs.readFile(p,'utf8'),raw);
 assert((await call('list_projects',{})).some(x=>x.path===c.project));
});
test('merges overlapping cuts, splits source clips, preserves zoom source times and audio settings',async()=>{
 const p=await fixture(),raw=await fs.readFile(p,'utf8');
 const r=await cut(p,[{startMs:2000,endMs:4000},{startMs:3000,endMs:5000}]);
 assert.equal(r.outputDurationMs,7000);assert.equal(r.removedMs,3000);
 assert.deepEqual(r.mapping.map(x=>[x.startMs,x.endMs,x.outputStartMs,x.outputEndMs]),[[0,2000,0,2000],[5000,10000,2000,7000]]);
 assert.equal(await fs.readFile(r.backupPath,'utf8'),raw);
 const d=JSON.parse(await fs.readFile(p,'utf8'));assert.deepEqual(d.editor.zoomRegions,base.editor.zoomRegions);assert.deepEqual(d.future,base.future);
 for(const c of d.editor.clipRegions){assert.equal(c.custom,7);assert.deepEqual(d.editor.sourceAudioTrackSettingsByClip[c.id],base.editor.sourceAudioTrackSettingsByClip.a);}
 const again=await cut(p,[{startMs:2000,endMs:5000}]);assert.equal(again.changed,false);assert.equal(again.backupPath,null);
});
test('dry-run and invalid schema/ranges cannot alter original bytes',async()=>{
 const p=await fixture(),raw=await fs.readFile(p,'utf8');const r=await cut(p,[{startMs:1000,endMs:2000}],{dryRun:true});assert.equal(r.backupPath,null);assert.equal(await fs.readFile(p,'utf8'),raw);
 for(const ranges of [[{startMs:2000,endMs:1000}],[{startMs:0,endMs:10000}],[{startMs:10000,endMs:11000}]])await call('cut_ranges',{project:p,ranges,timelineModel:'recordly-1.4-source-time'},true);
 assert.equal(await fs.readFile(p,'utf8'),raw);
 for(const change of [p=>p.editor.clipRegions[0].sourceStartMs=0,p=>p.editor.clipRegions[0].speed=2,p=>p.editor.trimRegions=[{startMs:0,endMs:100}],p=>p.version=1]){
  const d=structuredClone(base);change(d);const f=await fixture(d),before=await fs.readFile(f,'utf8');await call('cut_ranges',{project:f,ranges:[{startMs:0,endMs:100}],timelineModel:'recordly-1.4-source-time'},true);assert.equal(await fs.readFile(f,'utf8'),before);
 }
});
test('stale revision rejects cuts and concurrent zoom/cut writes preserve both',async()=>{
 const p=await fixture();const old=await call('open_project',{project:p});
 await call('update_zoom',{project:p,zoomId:'z',depth:1});
 await call('cut_ranges',{project:p,ranges:[{startMs:1000,endMs:2000}],timelineModel:'recordly-1.4-source-time',expectedRevision:old.revision},true);
 await Promise.all([cut(p,[{startMs:1000,endMs:2000}]),call('update_zoom',{project:p,zoomId:'z',focusX:.4})]);
 const d=JSON.parse(await fs.readFile(p,'utf8'));assert.equal(d.editor.zoomRegions[0].depth,1);assert.equal(d.editor.zoomRegions[0].focus.cx,.4);assert.equal(d.editor.clipRegions.length,2);
});
test('native-saved redundant trim gaps are accepted and refreshed on further cuts',async()=>{
 const data=structuredClone(base);data.editor.clipRegions[0].startMs=1000;data.editor.clipRegions[0].endMs=9000;
 data.editor.trimRegions=[{id:'head',startMs:0,endMs:1000},{id:'tail',startMs:9000,endMs:10000}];
 const p=await fixture(data);await cut(p,[{startMs:4000,endMs:5000}]);
 const saved=JSON.parse(await fs.readFile(p,'utf8'));
 assert.deepEqual(saved.editor.trimRegions.map(r=>[r.startMs,r.endMs]),[[0,1000],[4000,5000],[9000,10000]]);
 await cut(p,[{startMs:6000,endMs:7000}]);
 assert.equal(JSON.parse(await fs.readFile(p,'utf8')).editor.clipRegions.length,3);
});
test('safe published surface excludes incompatible legacy trim and approximate export',async()=>{
 const r=await client.listTools();const names=r.tools.map(t=>t.name);
 for(const n of ['get_paths','copy_project','cut_ranges','list_zooms','update_zoom','delete_zooms'])assert(names.includes(n));
 for(const n of ['trim_range','cut_silence','export_final','render_preview'])assert(!names.includes(n));
});
