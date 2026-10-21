// Headless-Chrome smoke test of the reentry viewer (adapted from the CZ-6A harness): loads the page over HTTP,
// fails on console errors / failed requests, checks the reconstruction wiring and writes screenshots.
//   python3 -m http.server 8767 --bind 127.0.0.1 --directory docs &
//   node tests/browser.mjs
import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const base=process.env.VIEWER_URL||'http://127.0.0.1:8767/';
const chromePath=process.env.CHROME||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const output=new URL('../.test-artifacts/',import.meta.url);await fs.mkdir(output,{recursive:true});
const profile=await fs.mkdtemp(path.join(os.tmpdir(),'sz-browser-'));
const chrome=spawn(chromePath,['--headless=new','--remote-debugging-port=0',`--user-data-dir=${profile}`,'--no-first-run','--no-default-browser-check','about:blank'],{stdio:'ignore'});
const delay=(ms)=>new Promise((r)=>setTimeout(r,ms));
const errors=[],checks=[],requestURLs=new Map();let ws;
try{
  let port;
  for(let i=0;i<200;i++){try{port=+(await fs.readFile(path.join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0];break;}catch{await delay(100);}}
  assert.ok(port,'Chrome debugging endpoint');
  const targets=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  ws=new WebSocket(targets.find((t)=>t.type==='page').webSocketDebuggerUrl);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});
  let id=0;const waiting=new Map();
  ws.onmessage=({data})=>{const m=JSON.parse(data);if(m.id){const p=waiting.get(m.id);if(p){waiting.delete(m.id);m.error?p.reject(new Error(m.error.message)):p.resolve(m.result);}}
    if(m.method==='Network.requestWillBeSent')requestURLs.set(m.params.requestId,m.params.request.url);
    if(m.method==='Network.loadingFailed')errors.push(`${m.params.errorText} ${requestURLs.get(m.params.requestId)||''}`);
    if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.exception?.description||m.params.exceptionDetails.text);
    if(m.method==='Runtime.consoleAPICalled'&&m.params.type==='error')errors.push(m.params.args.map((a)=>a.value||a.description).join(' '));
    if(m.method==='Network.responseReceived'&&m.params.response.status>=400)errors.push(`${m.params.response.status} ${m.params.response.url}`);
  };
  const call=(method,params={})=>new Promise((resolve,reject)=>{const n=++id;waiting.set(n,{resolve,reject});ws.send(JSON.stringify({id:n,method,params}));});
  const evaluate=async(expression)=>{const r=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value;};
  async function wait(expression,timeout=30000){const start=Date.now();while(Date.now()-start<timeout){if(await evaluate(expression))return;await delay(100);}throw new Error('Timed out: '+expression);}
  async function navigate(url){await call('Page.navigate',{url});await wait('!!window.__sz && !document.getElementById("loading")');}
  async function shot(name){await delay(400);const r=await call('Page.captureScreenshot',{format:'png'});await fs.writeFile(new URL(name,output),Buffer.from(r.data,'base64'));}
  const check=(name,ok)=>{assert.ok(ok,name);checks.push(name);};
  await call('Runtime.enable');await call('Page.enable');await call('Network.enable');
  await call('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
  await navigate(base);
  check('default mission is sz20',await evaluate('__sz.profile==="shenzhou" && __sz.mission==="sz20"'));
  check('track starts before the burn and ends at touchdown',await evaluate('__sz.meta.met_min<0 && __sz.metEnd>2800 && __sz.metEnd<3100'));
  check('plasma layer built',await evaluate('__sz.groups.plasmaGroup.children.length>=3'));
  check('two solid solar contours',await evaluate('__sz.groups.termGroup.children.every(x=>!x.material.dashed) && __sz.groups.termGroup.children[0].material.color.getHexString()==="ffd54f" && __sz.groups.termGroup.children[1].material.color.getHexString()==="4fc3f7"'));
  check('credit line',await evaluate('document.getElementById("credit").textContent==="Illustration: Mickey · base map NASA Blue Marble"'));
  check('no launch-viewer leftovers in the text',await evaluate('!(/NOTAM|Sunlit plume|Yaogan|CZ-6A|jellyfish|insertion/i.test(document.body.innerText))'));
  check('model document is served and linked',await evaluate('fetch("./model.html").then((r)=>r.ok&&r.text()).then((t)=>t.includes("Modeling a Shenzhou reentry"))') && await evaluate('!!document.querySelector("#about a[href=\'./model.html\']") && !!document.getElementById("doclink")'));
  check('compare table filled',await evaluate('document.querySelectorAll("#compare tr").length>=8 && document.getElementById("compare").textContent.includes("reported")'));
  check('timeline has reported and model events',await evaluate('document.querySelectorAll("#events tr.official").length===2 && document.querySelectorAll("#events tbody tr").length>=14'));
  await wait('__sz.mapLOD.stats().active===0');
  check('legend items stay inside the legend box',await evaluate('(()=>{const l=document.getElementById("legend"),r=l.getBoundingClientRect();return [...l.querySelectorAll("span")].every((s)=>{const b=s.getBoundingClientRect();return b.right<=r.right+1 && b.left>=r.left-1;}) && l.querySelectorAll("span").length>=9;})()'));
  await shot('default.png');
  // blackout midpoint: plasma style, orange glow, Mach/g status
  const tb=await evaluate('(()=>{const e=Object.fromEntries(__sz.events.filter(e=>e.key).map(e=>[e.key,e.met]));return (e.blackout_start+e.blackout_end)/2;})()');
  await evaluate(`__sz.setMet(${tb})`);await delay(300);
  check('plasma style during blackout',await evaluate(`(()=>{const s=__sz.styleAt(${tb},Date.UTC(2026,0,19,0,45,45));return s.plasma && s.color==="#ff7043";})()`));
  check('status shows Mach and g during entry',await evaluate('/Mach \\d+ · \\d\\.\\d\\d g/.test(document.getElementById("status").textContent)'));
  await evaluate('__sz.flyTo(92,40.5,1.5)');await delay(1600);await wait('__sz.mapLOD.stats().active===0');
  await shot('blackout-xinjiang.png');
  await evaluate('__sz.setMet(1760);__sz.flyTo(86,40.5,1.12)');await delay(1600);await wait('__sz.mapLOD.stats().active===0');
  await shot('capsule-closeup.png');
  // touchdown: capsule at the site, status landed
  await evaluate('__sz.setMet(__sz.metEnd)');await delay(300);
  check('capsule at the landing site at the end',await evaluate('(()=>{const s=__sz.shipAt(__sz.metEnd),m=__sz.meta;const ll=[Math.atan2(-s.u[2],s.u[0])*180/Math.PI,Math.asin(s.u[1])*180/Math.PI];return Math.abs(ll[0]-m.site[0])<.01 && Math.abs(ll[1]-m.site[1])<.01 && Math.abs(s.alt-m.site_alt)<.01;})()'));
  check('status reports landed',await evaluate('document.getElementById("status").textContent.includes("landed")'));
  await evaluate('__sz.flyTo(100.75,41.65,1.15)');await delay(1600);await wait('__sz.mapLOD.stats().active===0');
  await shot('dongfeng.png');
  // sky chart over Jiuquan during the entry
  await evaluate(`__sz.setMet(${tb})`);await evaluate('document.getElementById("skybtn").click()');
  await wait('document.querySelector(".skw-title .sub")?.textContent.includes("Jiuquan")');await delay(600);
  check('sky chart opened over Jiuquan',await evaluate('__sz.sky.isOpen()'));
  await shot('sky-jiuquan.png');
  // T0 shift changes the Sun only
  const before=await evaluate(`JSON.stringify(__sz.shipAt(${tb}).p)`);
  await evaluate('__sz.setT0(10*3600)');await delay(200);
  check('T0 shift keeps the track',await evaluate(`JSON.stringify(__sz.shipAt(${tb}).p)==='${before}' && document.getElementById("t0v").textContent==="10:00:00Z"`));
  check('share URL encodes the mission',(await evaluate('__sz.shareURL()')).includes('mission=sz20'));
  // mobile layout
  await call('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:2,mobile:true});
  await navigate(base+'?met=1850');await delay(800);
  check('mobile hides panels by default',await evaluate('!document.body.classList.contains("ctl-open") && !document.body.classList.contains("info-open")'));
  await shot('mobile.png');
  assert.deepEqual(errors,[],'browser errors');
  console.log(`${checks.length} checks passed; screenshots in .test-artifacts/`);
}catch(error){console.error('FAILED after',checks.length,'checks:',error.message);if(errors.length)console.error('browser errors:',errors);process.exitCode=1;}
finally{ws?.close();const exited=new Promise((r)=>chrome.once('exit',r));chrome.kill();await Promise.race([exited,delay(5000)]);await fs.rm(profile,{recursive:true,force:true,maxRetries:10,retryDelay:300}).catch(()=>{});}
