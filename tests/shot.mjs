// Screenshot helper: node tests/shot.mjs "<query string>" out.png [clip x,y,w,h] — loads the viewer with the given
// URL parameters in headless Chrome, waits for the tiles, and writes a PNG (optionally a clipped region).
import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const [query='',out='shot.png',clipArg]=process.argv.slice(2);
const base=process.env.VIEWER_URL||'http://127.0.0.1:8767/';
const chromePath=process.env.CHROME||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const profile=await fs.mkdtemp(path.join(os.tmpdir(),'sz-shot-'));
const chrome=spawn(chromePath,['--headless=new','--remote-debugging-port=0',`--user-data-dir=${profile}`,'--no-first-run','--no-default-browser-check','about:blank'],{stdio:'ignore'});
const delay=(ms)=>new Promise((r)=>setTimeout(r,ms));
let ws;
try{
  let port;for(let i=0;i<200;i++){try{port=+(await fs.readFile(path.join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0];break;}catch{await delay(100);}}
  const targets=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  ws=new WebSocket(targets.find((t)=>t.type==='page').webSocketDebuggerUrl);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});
  let id=0;const waiting=new Map();
  ws.onmessage=({data})=>{const m=JSON.parse(data);if(m.id){const p=waiting.get(m.id);if(p){waiting.delete(m.id);m.error?p.reject(new Error(m.error.message)):p.resolve(m.result);}}};
  const call=(method,params={})=>new Promise((resolve,reject)=>{const n=++id;waiting.set(n,{resolve,reject});ws.send(JSON.stringify({id:n,method,params}));});
  const evaluate=async(expression)=>{const r=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw new Error(r.exceptionDetails.text);return r.result.value;};
  async function wait(expression,timeout=30000){const start=Date.now();while(Date.now()-start<timeout){if(await evaluate(expression))return;await delay(100);}throw new Error('Timed out: '+expression);}
  await call('Runtime.enable');await call('Page.enable');
  await call('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:2,mobile:false});
  await call('Page.navigate',{url:base+(query?'?'+query:'')});await wait('!!window.__sz && !document.getElementById("loading")');
  await delay(1500);await wait('__sz.mapLOD.stats().active===0');await delay(400);
  const clip=clipArg?Object.fromEntries(['x','y','width','height'].map((k,i)=>[k,+clipArg.split(',')[i]])):undefined;
  const r=await call('Page.captureScreenshot',{format:'png',...(clip?{clip:{...clip,scale:2}}:{})});
  await fs.writeFile(out,Buffer.from(r.data,'base64'));console.log('wrote',out);
}finally{ws?.close();const exited=new Promise((r)=>chrome.once('exit',r));chrome.kill();await Promise.race([exited,delay(5000)]);await fs.rm(profile,{recursive:true,force:true,maxRetries:10,retryDelay:300}).catch(()=>{});}
