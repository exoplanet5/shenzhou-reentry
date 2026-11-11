// Headless-Chrome check of what is this project's own on the page: the missions, the reentry panels, the capsule and the plasma trail.
// The page code and its performance are the template's and are checked by the launch-page skill's check_page.py.
//   python3 tools/serve.py &        # http://127.0.0.1:8770/
//   node tests/browser.mjs          # screenshots in .test-artifacts/
import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const base=process.env.VIEWER_URL||'http://127.0.0.1:8770/';
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
    if(m.method==='Network.loadingFailed'&&!m.params.canceled)errors.push(`${m.params.errorText} ${requestURLs.get(m.params.requestId)||''}`);
    if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.exception?.description||m.params.exceptionDetails.text);
    if(m.method==='Runtime.consoleAPICalled'&&m.params.type==='error')errors.push(m.params.args.map((a)=>a.value||a.description).join(' '));
    if(m.method==='Network.responseReceived'&&m.params.response.status>=400)errors.push(`${m.params.response.status} ${m.params.response.url}`);
  };
  const call=(method,params={})=>new Promise((resolve,reject)=>{const n=++id;waiting.set(n,{resolve,reject});ws.send(JSON.stringify({id:n,method,params}));});
  const evaluate=async(expression)=>{const r=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value;};
  async function wait(expression,timeout=40000){const start=Date.now();while(Date.now()-start<timeout){if(await evaluate(expression))return;await delay(100);}throw new Error('Timed out: '+expression);}
  async function navigate(query=''){await call('Page.navigate',{url:base+query});await wait('!!window.__globe && !document.getElementById("loading")');await delay(600);}
  async function shot(name){await wait('__globe.mapLOD.stats().active===0');await delay(1500);const r=await call('Page.captureScreenshot',{format:'png'});await fs.writeFile(new URL(name,output),Buffer.from(r.data,'base64'));}
  const check=(name,ok)=>{assert.ok(ok,name);checks.push(name);};
  const text=(id)=>evaluate(`document.getElementById(${JSON.stringify(id)}).innerText`);
  await call('Runtime.enable');await call('Page.enable');await call('Network.enable');
  await call('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});

  await navigate();
  check('opens on the Shenzhou-23 forecast',await evaluate('__globe.profile==="shenzhou" && __globe.mission==="sz23-1129" && document.getElementById("launchsel").options.length===2'));
  check('playback runs from one orbit before the burn to touchdown',await evaluate('__globe.metStart===-5700 && +document.getElementById("met").min===-5700 && __globe.metEnd>2800 && __globe.metEnd<3000'));
  check('title bar: vehicle, date and forecast touchdown',(await text('bar')).includes('Shenzhou-23')&&/forecast touchdown 21:12 UTC/.test(await text('subt')));
  check('reentry headings and badge',await evaluate('["h-config","h-t0","h-timeline","h-tle"].map((k)=>document.getElementById(k).textContent).join("|")==="Return configuration|Deorbit burn · UTC|Return timeline|Element sets"')&&/forecast/i.test(await text('model-badge')));
  check('no launch wording is left on the page',await evaluate('!(/NOTAM|Stage falls|jelly|Sunlit plume|Launch time|hazard|S4|insertion/i.test(document.body.innerText))'));
  check('plasma trail layer under its own checkbox',await evaluate('__globe.groups.jellyGroup.children.length===3 && document.getElementById("o-jelly").parentElement.innerText.trim()==="Plasma trail"'));
  check('landing star and legend',await evaluate('__globe.landing.visible!==undefined && document.getElementById("legend").innerText.includes("Landing site") && document.getElementById("legend").innerText.includes("Plasma trail")'));
  check('two solid solar contours in the house colours',await evaluate('__globe.groups.termGroup.children.every((x)=>!x.material.dashed) && __globe.groups.termGroup.children[0].material.color.getHexString()==="ffd54f" && __globe.groups.termGroup.children[1].material.color.getHexString()==="4fc3f7"'));
  check('credit line',await evaluate('document.getElementById("credit").textContent==="Illustration: Mickey · base map NASA Blue Marble"'));
  check('forecast summary: ignition, pass, touchdown and timing',await evaluate('(()=>{const t=document.getElementById("summary").innerText;return !document.getElementById("summary").hidden && /20:24:04Z \\(solved\\)/.test(t) && /ground track 2\\.4 km south of the site/.test(t) && /21:12:13Z/.test(t) && /±\\d+ s for ±30 % drag/.test(t);})()'));
  check('timeline from orbital-module separation to touchdown',await evaluate('(()=>{const rows=[...document.querySelectorAll("#events tbody tr")].map((r)=>r.innerText);return rows.length===15 && /T[−-]00:01:45/.test(rows[0]) && /Touchdown/.test(rows.at(-1)) && /21:12:13/.test(rows.at(-1));})()'));
  check('status at peak heating: plasma, Mach and load, range to the site',await evaluate('(()=>{const t=document.getElementById("status").innerText;return /Plasma blackout/.test(t) && /Air speed\\s+\\d\\.\\d\\d km\\/s/.test(t) && /Mach \\d+ · \\d\\.\\d\\d g/.test(t) && /Plasma trail · Earth shadow/.test(t) && /To landing site\\s+\\d+ km/.test(t);})()'));
  check('the capsule is self-luminous in the plasma and dark on the night side otherwise',await evaluate('(()=>{const g=__globe,T0=Date.parse(g.meta.date+"T"+g.meta.t0_default+"Z"),a=g.styleAt(g.meta.plasma_intervals[0][0]+60,T0),b=g.styleAt(g.meta.plasma_intervals[0][1]+60,T0);return a.plasma && !a.lit && !b.plasma && !b.lit;})()'));
  await shot('forecast-default.png');
  check('T0 presets are the forecast and its drag bounds',await evaluate('[...document.querySelectorAll("#t0presets [data-t0]")].map((b)=>b.textContent).join("|")==="−45 s|Model 20:24|+45 s"'));
  await evaluate('document.querySelector("#t0presets [data-t0]").click()');await delay(400);
  check('a T0 preset shifts every clock time by the same amount',await evaluate('/20:23:19Z \\(solved\\)/.test(document.getElementById("summary").innerText) && /21:11:28/.test([...document.querySelectorAll("#events tbody tr")].at(-1).innerText)'));
  await evaluate('document.querySelectorAll("#t0presets [data-t0]")[1].click()');
  // the cartoon: one texture per state, swapped as the sequence runs
  const maps=[];for(const met of [-3000,60,1500,1760,2060,2118,2600]){await evaluate(`__globe.setMet(${met})`);await delay(350);maps.push(await evaluate('__globe.landing.parent.children.find((o)=>o.isSprite&&o.renderOrder===8).material.map.uuid'));}
  check('the capsule cartoon changes with each phase of the return',new Set(maps).size===7);
  await evaluate('__globe.setMet(2600);__globe.setView({lon:100.75,lat:41.65,range:.03,heading:0,tilt:62})');await shot('main-parachute.png');
  check('under the main parachute the capsule hangs upright',await evaluate('Math.abs(__globe.landing.parent.children.find((o)=>o.isSprite&&o.renderOrder===8).material.rotation)<.2'));
  await evaluate('__globe.setMet(__globe.metEnd)');await delay(400);
  check('at touchdown the range is zero',/To landing site\s+0\.0 km · landed/.test(await text('status')));
  // sky chart from a city under the plasma trail
  await navigate('?met=1760&sky=Korla');await wait('__globe.sky.isOpen()');await delay(800);
  check('sky chart over Korla: a dark-sky pass of the plasma trail',await evaluate('(()=>{const t=document.body.innerText;return /passes over Korla/.test(t) && /plasma trail, self-luminous/.test(t) && /lit \\/ dark-sky/.test(t);})()'));
  await shot('sky-korla.png');
  check('model write-up is served and linked',await evaluate('fetch("./model.html").then((r)=>r.ok&&r.text()).then((t)=>t.includes("Modeling a Shenzhou reentry"))')&&await evaluate('!!document.querySelector("#about a[href=\'./model.html\']")'));
  // every mission loads, and old links to the reconstruction still work
  for(const [mission,land] of [['sz20','01:34:30']]){
    await navigate(`?mission=${mission}&met=1850&cam=92,40.5,1.5`);
    check(`${mission} loads and lands at ${land} UTC`,await evaluate(`__globe.mission==="${mission}" && [...document.querySelectorAll("#events tbody tr")].some((r)=>/Touchdown/.test(r.innerText)&&r.innerText.includes("${land}")) && Math.abs(__globe.state.met-1850)<1e-6 && Math.abs(__globe.view().lon-92)<1e-6`));
  }
  check('the reconstruction keeps its reported values',await evaluate('(()=>{const t=document.getElementById("summary").innerText;return /Reconstruction vs reported/i.test(document.getElementById("summary-title").textContent) && /01:34:30Z reported/.test(t) && /00:44:00Z reported/.test(t);})()')&&/reconstruction/i.test(await text('model-badge')));
  await shot('sz20.png');
  await evaluate('document.querySelector("[data-frame=gcrs]").click()');await delay(600);
  check('inertial frame switch works with a flight that starts before T0',await evaluate('__globe.frame()==="gcrs" && __globe.groups.trajGroup.children.length===4'));
  await call('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:2,mobile:true});await navigate();
  check('phone header keeps name, date, time and T± on one line',await evaluate('(()=>{const bar=document.getElementById("bar").getBoundingClientRect(),c=document.getElementById("clock").getBoundingClientRect(),t=document.querySelector(".title").getBoundingClientRect();return bar.height<=60 && c.right<=bar.right && t.right<=c.left+1 && document.documentElement.scrollWidth<=390;})()'));
  await shot('phone.png');
  check('no console errors or failed requests',errors.length===0);
  console.log(`${checks.length} browser checks passed`);
}catch(error){console.error('FAILED after',checks.length,'checks:',error.message);if(errors.length)console.error(errors.slice(0,5).join('\n'));process.exitCode=1;}
finally{ws?.close();const exited=new Promise((r)=>chrome.once('exit',r));chrome.kill();await Promise.race([exited,delay(5000)]);await fs.rm(profile,{recursive:true,force:true,maxRetries:10,retryDelay:300}).catch(()=>{});}
