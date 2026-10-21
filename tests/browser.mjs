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
  const mouse=(type,[x,y],button='none',buttons=0)=>call('Input.dispatchMouseEvent',{type,x,y,button,buttons,clickCount:type==='mouseMoved'?0:1});
  async function drag(button,from,to){const buttons=button==='right'?2:1;await mouse('mousePressed',from,button,buttons);for(let i=1;i<=8;i++)await mouse('mouseMoved',[from[0]+(to[0]-from[0])*i/8,from[1]+(to[1]-from[1])*i/8],button,buttons);await mouse('mouseReleased',to,button,0);await delay(900);}
  const touch=(type,points)=>call('Input.dispatchTouchEvent',{type,touchPoints:points.map(([x,y],id)=>({x,y,id}))});
  // Nearest-to-centre globe point that is canvas (not a label or panel), away from the track, with canvas on both sides.
  const groundPoint=(spread=0)=>`(()=>{const v=document.getElementById("view").getBoundingClientRect(),cx=v.left+v.width/2,cy=v.top+v.height/2,points=[];for(let fy=.15;fy<=.85;fy+=.025)for(let fx=.15;fx<=.85;fx+=.025)points.push([Math.round(v.left+v.width*fx),Math.round(v.top+v.height*fy)]);points.sort((a,b)=>Math.hypot(a[0]-cx,a[1]-cy)-Math.hypot(b[0]-cx,b[1]-cy));const canvas=(x,y)=>document.elementFromPoint(x,y)?.tagName==="CANVAS";return points.find(([x,y])=>canvas(x,y)&&canvas(x-${spread},y)&&canvas(x+${spread},y)&&__sz.pick(x,y)&&!__sz.trackAt(x,y))||null;})()`;
  const screenOf=(ll)=>`(()=>{const s=${ll},r=document.getElementById("view").getBoundingClientRect(),c=Math.cos(s.lat*Math.PI/180),p=__sz.camera.position.clone().set(c*Math.cos(s.lon*Math.PI/180),Math.sin(s.lat*Math.PI/180),-c*Math.sin(s.lon*Math.PI/180)).project(__sz.camera);return [(p.x+1)*r.width/2+r.left,(1-p.y)*r.height/2+r.top];})()`;
  const near=(a,b,tolerance)=>Math.hypot(a[0]-b[0],a[1]-b[1])<tolerance;
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
  // ---- pivot camera gestures (same contract as the CZ-6A viewer)
  const point=await evaluate(groundPoint());assert.ok(point,'clickable globe point');
  const grabbed=JSON.stringify(await evaluate(`__sz.pick(${point})`)),dragTo=[point[0]+140,point[1]+40];
  await drag('left',point,dragTo);
  check('left-drag grabs the globe so the ground follows the pointer without tilting or opening a chart',near(await evaluate(screenOf(grabbed)),dragTo,6) && await evaluate('__sz.view().tilt===0 && !__sz.sky.isOpen()'));
  const centre=await evaluate(groundPoint());assert.ok(centre,'globe point for pivot gestures');
  await mouse('mousePressed',centre,'right',2);await mouse('mouseReleased',centre,'right',0);await delay(300);
  check('right-click does not open a sky chart',await evaluate('!__sz.sky.isOpen()'));
  const level=JSON.parse(await evaluate('JSON.stringify(__sz.view())'));
  await drag('right',centre,[centre[0],centre[1]-160]);
  const tilted=JSON.parse(await evaluate('JSON.stringify(__sz.view())'));
  check('right-drag up tilts the camera about the view point, which stays fixed',tilted.tilt>30 && Math.abs(tilted.lon-level.lon)<1e-9 && Math.abs(tilted.lat-level.lat)<1e-9 && await evaluate('__sz.camera.position.length()>=1.05-1e-9 && !__sz.sky.isOpen()'));
  await drag('right',centre,[centre[0]+200,centre[1]]);
  const turned=JSON.parse(await evaluate('JSON.stringify(__sz.view())')),swing=Math.abs(((turned.heading-tilted.heading)%360+540)%360-180);
  check('right-drag sideways turns the heading around the same view point',swing>30 && swing<90 && Math.abs(turned.tilt-tilted.tilt)<1e-9 && Math.abs(turned.lon-level.lon)<1e-9 && Math.abs(turned.lat-level.lat)<1e-9);
  await wait('__sz.mapLOD.stats().active===0');await shot('tilted-view.png');
  const oblique=await evaluate(groundPoint());assert.ok(oblique,'clickable ground in the tilted view');
  await mouse('mousePressed',oblique,'left',1);await mouse('mouseReleased',oblique,'left',0);
  await wait('__sz.sky.isOpen() && !!__sz.sky.site()?.custom');
  check('clicks in a tilted, turned view still pick the ground under the pointer',near(await evaluate(screenOf('__sz.sky.site()')),oblique,2));
  await evaluate('__sz.sky.close()');
  const shared=await evaluate('__sz.shareURL()');await navigate(shared);
  check('share link restores the view point, heading and tilt',await evaluate(`Math.abs(__sz.view().heading-${turned.heading})<.1 && Math.abs(__sz.view().tilt-${turned.tilt})<.1 && Math.abs(__sz.view().lon-${turned.lon})<.002 && Math.abs(__sz.view().lat-${turned.lat})<.002`));
  await evaluate('document.querySelector("[data-view=\\"1\\"]").click()');await delay(1500);
  check('camera presets reset tilt and heading',await evaluate('__sz.view().tilt===0 && Math.min(__sz.view().heading,360-__sz.view().heading)<1e-6'));
  await navigate(base+'?met=NaN&t0=bad&cam=1,2,0,999,-50');
  check('malformed URL input safely defaults or clamps',await evaluate('__sz.state.met===0 && __sz.state.t0===__sz.meta.t0_default.split(":").reduce((a,b)=>a*60+ +b,0) && __sz.camera.position.length()>=1.049 && __sz.view().tilt===0 && __sz.view().heading===279'));
  await navigate(base);
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
  await call('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:5});
  const two=await evaluate(groundPoint(50));assert.ok(two,'two-finger globe point');
  const flat=JSON.parse(await evaluate('JSON.stringify(__sz.view())'));
  await touch('touchStart',[[two[0]-50,two[1]],[two[0]+50,two[1]]]);for(let i=1;i<=8;i++)await touch('touchMove',[[two[0]-50,two[1]-12*i],[two[0]+50,two[1]-12*i]]);await touch('touchEnd',[]);await delay(600);
  const tiltedTouch=JSON.parse(await evaluate('JSON.stringify(__sz.view())'));
  check('two-finger drag tilts about the fixed view point without zooming or opening a chart',tiltedTouch.tilt>20 && Math.abs(tiltedTouch.lon-flat.lon)<1e-9 && Math.abs(tiltedTouch.lat-flat.lat)<1e-9 && Math.abs(tiltedTouch.range/flat.range-1)<.02 && await evaluate('!__sz.sky.isOpen()'));
  await touch('touchStart',[[two[0]-30,two[1]],[two[0]+30,two[1]]]);for(let i=1;i<=5;i++)await touch('touchMove',[[two[0]-30-10*i,two[1]],[two[0]+30+10*i,two[1]]]);await touch('touchEnd',[]);await delay(300);
  check('pinching zooms toward the unchanged view point',await evaluate(`__sz.view().range<${tiltedTouch.range}*.6 && Math.abs(__sz.view().lon-${flat.lon})<1e-9 && Math.abs(__sz.view().tilt-${tiltedTouch.tilt})<1e-9`));
  check('phone header keeps the UTC date, time and T± on one line with the vehicle name',await evaluate('(()=>{const shown=(s)=>getComputedStyle(document.querySelector(s)).display!=="none";const bar=document.getElementById("bar").getBoundingClientRect(),v=document.getElementById("view").getBoundingClientRect(),t=document.getElementById("ttl").getBoundingClientRect(),d=document.getElementById("c-date").getBoundingClientRect(),m=document.getElementById("c-met").getBoundingClientRect();return shown(".utcd") && shown(".utct") && document.getElementById("c-date").textContent.includes("2026") && Math.abs(d.top-t.top)<12 && Math.abs(m.top-t.top)<12 && bar.bottom<=v.top+.5 && bar.right<=innerWidth;})()'));
  await wait('__sz.mapLOD.stats().active===0');await shot('mobile-tilted.png');
  const tap=await evaluate(groundPoint());assert.ok(tap,'tappable globe point');
  await touch('touchStart',[tap]);await touch('touchEnd',[]);
  await wait('__sz.sky.isOpen() && !!__sz.sky.site()?.custom');
  check('a tap in the tilted phone view opens the sky chart for the ground under the finger',near(await evaluate(screenOf('__sz.sky.site()')),tap,3));
  await evaluate('__sz.sky.close()');
  await call('Emulation.setDeviceMetricsOverride',{width:320,height:740,deviceScaleFactor:1,mobile:true});await delay(300);
  check('320px viewport has no horizontal page overflow',await evaluate('document.documentElement.scrollWidth<=innerWidth'));
  check('320px header still shows the UTC date, time and T± on one bar',await evaluate('(()=>{const bar=document.getElementById("bar").getBoundingClientRect(),v=document.getElementById("view").getBoundingClientRect(),c=document.getElementById("clock").getBoundingClientRect();return getComputedStyle(document.querySelector(".utcd")).display!=="none" && c.right<=innerWidth-16 && c.left>=16 && bar.bottom<=v.top+.5 && document.getElementById("c-met").getBoundingClientRect().width>0;})()'));
  await shot('mobile-320-header.png');
  assert.deepEqual(errors,[],'browser errors');
  console.log(`${checks.length} checks passed; screenshots in .test-artifacts/`);
}catch(error){console.error('FAILED after',checks.length,'checks:',error.message);if(errors.length)console.error('browser errors:',errors);process.exitCode=1;}
finally{ws?.close();const exited=new Promise((r)=>chrome.once('exit',r));chrome.kill();await Promise.race([exited,delay(5000)]);await fs.rm(profile,{recursive:true,force:true,maxRetries:10,retryDelay:300}).catch(()=>{});}
