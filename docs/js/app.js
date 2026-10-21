import * as THREE from 'three';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import {Line2} from 'three/addons/lines/Line2.js';
import {LineGeometry} from 'three/addons/lines/LineGeometry.js';
import {LineMaterial} from 'three/addons/lines/LineMaterial.js';
import {LineSegments2} from 'three/addons/lines/LineSegments2.js';
import {LineSegmentsGeometry} from 'three/addons/lines/LineSegmentsGeometry.js';
import {CSS2DRenderer, CSS2DObject} from 'three/addons/renderers/CSS2DRenderer.js';
import * as A from './astro.js';
import {fetchJSON, validateManifest, validateMission, selectProfile, createFlight, solarEphemeris, sunlightClearance, greatCircleKm, clockSeconds, clamp, escapeHTML as esc} from './profile.js';
import {createSkyChart} from './skychart.js';
import {validateBoundaries,boundarySegments} from './boundaries.js';
import {createMapTiles} from './map-tiles.js';
import {createBoundaryLayer} from './boundary-layer.js';
import {CITIES,cityInRange} from './cities.js';

// Reentry viewer: adapted from the CZ-6A launch viewer (exoplanet5/CZ-6A) and the Starship IFT-14 page.
const $ = (id) => document.getElementById(id);
const C = {sun:'#ffd54f',accent:'#4fc3f7',ink:'#e8eaed',dim:'#9aa4ae',plasma:'#ff7043',plasmaCore:'#ffd9a0',footprint:'#199e70'};
const qs = new URLSearchParams(location.search);
const message = (text) => { $('notice').textContent = text; };
function fail(error) {
  console.error(error);
  if ($('loading')) $('loadmsg').textContent = `Unable to start: ${error.message}. Check the local server and reload.`;
  else message(error.message);
}
addEventListener('unhandledrejection',(e) => fail(e.reason instanceof Error ? e.reason : new Error(String(e.reason))));

try { await start(); } catch (error) { fail(error); }
async function start() {
  const index = validateManifest(await fetchJSON('./data/profiles.json'));
  const {profile,entry} = selectProfile(index,qs);
  const data = validateMission(await fetchJSON('./'+entry.file)), M = data.meta, D = M.diag;
  const {tracks:T,flight,segmentAt,shipAt,poweredAt,plasmaAt,end:MET_END} = createFlight(data);
  const sunAt = solarEphemeris(data.sun), sunVecAt = (utc) => { const p=sunAt(utc),r=Math.hypot(...p);return p.map((v)=>v/r); };
  const sunSubpoint = (utc) => A.vecToLL(...sunAt(utc));
  const t0Min=clockSeconds(M.t0_min), t0Max=clockSeconds(M.t0_max), metMin=M.met_min;
  const num = (key,def,lo,hi) => qs.has(key) && Number.isFinite(+qs.get(key)) ? clamp(+qs.get(key),lo,hi) : def;
  const requestedT0=clockSeconds(qs.get('t0'));
  const state = {date:M.date,t0:Number.isFinite(requestedT0)?clamp(requestedT0,t0Min,t0Max):clockSeconds(M.t0_default),
    met:num('met',M.met_default,metMin,MET_END),follow:qs.get('follow')==='1',playing:false,live:false,speed:num('speed',10,1,300),
    show:Object.fromEntries(['term','zones','labels','gt','plasma','grid','lights','cities','fp','borders'].map((k)=>[k,qs.get(k)!=='0']))};
  const t0ms=()=>A.dateT0ms(M.date,state.t0), phaseOf=(met)=>(M.phases.find((p)=>met<p.until)||M.phases.at(-1)).label;
  const EV = Object.fromEntries(data.events.filter((e)=>e.key).map((e)=>[e.key,e]));
  function styleAt(met,T0) {
    const s=shipAt(met),lit=sunlightClearance(s.p,sunAt(T0+met*1000))>0,powered=poweredAt(met),plasma=plasmaAt(met);
    const hud=plasma?'● plasma trail, self-luminous'+(lit?' (sunlit)':' (Earth shadow)'):powered?(lit?'● deorbit burn, sunlit':'✕ deorbit burn in Earth shadow'):(lit?'● sunlit':'✕ in Earth shadow');
    return {lit,powered,plasma,hud,color:plasma?C.plasma:powered?C.sun:segmentAt(met).color};
  }
  let tablesDirty=true;
  const dirty=()=>{tablesDirty=true;};
  $('ttl').textContent=M.vehicle; $('ttlsub').textContent=M.date;
  $('subt').textContent=`${M.site_name} · landed ${M.reported.landing_utc.slice(11,16)} UTC · reconstruction`;
  $('profile-summary').textContent=`orbit ${M.orbit.perigee_km.toFixed(0)} × ${M.orbit.apogee_km.toFixed(0)} km · i ${M.orbit.inc.toFixed(2)}° · burn ${D.dv_ms.toFixed(0)} m/s`;
  $('datev').textContent=M.date; $('t0label').textContent=M.t0_label;
  $('model-badge').textContent='Reconstruction · not official ephemeris';

  const view=$('view'), renderer=new THREE.WebGLRenderer({antialias:true,powerPreference:'high-performance'});
  renderer.setPixelRatio(Math.min(devicePixelRatio,2)); view.appendChild(renderer.domElement);
  const labels=new CSS2DRenderer(); Object.assign(labels.domElement.style,{position:'absolute',inset:'0',pointerEvents:'none'});view.appendChild(labels.domElement);
  const scene=new THREE.Scene();scene.background=new THREE.Color('#05070a');
  const camera=new THREE.PerspectiveCamera(35,1,0.005,200);
  const controls=new OrbitControls(camera,renderer.domElement);
  Object.assign(controls,{enableDamping:true,dampingFactor:.08,screenSpacePanning:true,minDistance:.05,maxDistance:14,maxTargetRadius:.95,zoomSpeed:.9});
  const materials=new Set(), Y=new THREE.Vector3(0,1,0);
  function line(flat,{color=C.ink,width=1.8,opacity=1,dashed=false}={}) {
    const g=new LineGeometry();g.setPositions(flat);
    const m=new LineMaterial({color,linewidth:width,transparent:opacity<1||dashed,opacity,dashed,dashSize:.008,gapSize:.006,depthTest:true});
    m.resolution.set(view.clientWidth,view.clientHeight); materials.add(m);
    const l=new Line2(g,m);if(dashed)l.computeLineDistances();return l;
  }
  function group() {const g=new THREE.Group();scene.add(g);return g;}
  function clear(g) {
    g.traverse((o)=>{o.geometry?.dispose();if(o.material){materials.delete(o.material);o.material.dispose();}if(o.isCSS2DObject)o.element.remove();});g.clear();
  }
  function label(text,cls='') {const el=document.createElement('div');el.className='lbl '+cls;el.textContent=text;const o=new CSS2DObject(el);o.center.set(0,.5);return o;}
  function texture(draw,size=64) {const cv=document.createElement('canvas');cv.width=cv.height=size;draw(cv.getContext('2d'),size);return new THREE.CanvasTexture(cv);}
  function sprite(tex,size=.016) {const s=new THREE.Sprite(new THREE.SpriteMaterial({map:tex,sizeAttenuation:false,transparent:true,depthTest:true}));s.scale.set(size,size,1);return s;}
  const dotTex=texture((g,s)=>{g.fillStyle='#c9ccd1';g.strokeStyle='#080a0e';g.lineWidth=7;g.beginPath();g.arc(s/2,s/2,s/2-9,0,2*Math.PI);g.fill();g.stroke();});
  const squareTex=texture((g,s)=>{g.fillStyle=C.ink;g.strokeStyle='#080a0e';g.lineWidth=6;g.fillRect(s*.28,s*.28,s*.44,s*.44);g.strokeRect(s*.28,s*.28,s*.44,s*.44);});
  const starTex=texture((g,s)=>{g.beginPath();for(let i=0;i<10;i++){const a=-Math.PI/2+i*Math.PI/5,r=s*(i%2?.18:.42);g.lineTo(s/2+r*Math.cos(a),s/2+r*Math.sin(a));}g.closePath();g.fillStyle=C.sun;g.strokeStyle='#080a0e';g.lineWidth=4;g.fill();g.stroke();});
  function fillMesh(ring,color,opacity,r=1.0012){
    const pts=[];for(const [lon,lat]of ring){const prev=pts.at(-1)?.x??lon;pts.push(new THREE.Vector2(prev+((lon-prev+540)%360)-180,lat));}
    const out=[],split=(a,b,c)=>{const [p,q,o]=[[a,b,c],[b,c,a],[c,a,b]].reduce((x,y)=>y[0].distanceTo(y[1])>x[0].distanceTo(x[1])?y:x);
      if(p.distanceTo(q)<=.5){for(const v of [a,b,c])out.push(...A.llToVec(v.x,v.y,r));return;}
      const m=p.clone().lerp(q,.5);split(p,m,o);split(m,q,o);};
    for(const [i,j,k]of THREE.ShapeUtils.triangulateShape(pts,[]))split(pts[i],pts[j],pts[k]);
    const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(out,3));
    return new THREE.Mesh(g,new THREE.MeshBasicMaterial({color,transparent:true,opacity,depthWrite:false,side:THREE.DoubleSide}));
  }
  function circle(colat,r=1.002,n=360) {const out=[],a=colat*A.D2R;for(let i=0;i<=n;i++){const p=i/n*2*Math.PI;out.push(r*Math.sin(a)*Math.cos(p),r*Math.cos(a),r*Math.sin(a)*Math.sin(p));}return out;}
  const drawPoint=(s)=>s.u.map((v)=>v*(1+s.alt/A.RE));
  function visible(p) {
    const d=p.clone().sub(camera.position),t=clamp(-camera.position.dot(d)/d.lengthSq(),0,1);
    return camera.position.clone().addScaledVector(d,t).lengthSq()>=.9999 && p.clone().project(camera).z<1;
  }

  const loader=new THREE.TextureLoader();
  const loadTex=(url)=>new Promise((resolve,reject)=>loader.load(url,(t)=>{t.colorSpace=THREE.NoColorSpace;t.anisotropy=renderer.capabilities.getMaxAnisotropy();resolve(t);},undefined,()=>reject(new Error(`Texture missing: ${url}`))));
  $('loadmsg').textContent='Loading Blue Marble…';
  const [dayTex,nightTex,boundaryRaw]=await Promise.all([loadTex('./tex/earth_day_4k.jpg'),loadTex('./tex/earth_night.jpg'),fetchJSON('./data/boundaries.json')]);
  const boundaryData=validateBoundaries(boundaryRaw);
  const earthMat=new THREE.ShaderMaterial({uniforms:{dayTex:{value:dayTex},nightTex:{value:nightTex},sunDir:{value:new THREE.Vector3(1,0,0)},lights:{value:1},tileRect:{value:new THREE.Vector4(0,0,1,1)},imageRect:{value:new THREE.Vector4(0,0,1,1)}},
    vertexShader:`varying vec2 vUv;varying vec3 vP;void main(){vUv=uv;vP=position;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}`,
    fragmentShader:`uniform sampler2D dayTex,nightTex;uniform vec3 sunDir;uniform float lights;uniform vec4 tileRect,imageRect;varying vec2 vUv;varying vec3 vP;void main(){vec2 globalUV=tileRect.xy+vUv*tileRect.zw;vec2 imageUV=imageRect.xy+vUv*imageRect.zw;float mu=dot(normalize(vP),sunDir);vec3 col=texture2D(dayTex,imageUV).rgb*mix(.20,1.,smoothstep(-.2079,.03,mu));vec3 nl=texture2D(nightTex,globalUV).rgb;col+=nl*nl*vec3(1.,.86,.62)*1.25*(1.-smoothstep(-.2079,-.0523,mu))*lights;gl_FragColor=vec4(col,1.);}`});
  scene.add(new THREE.Mesh(new THREE.SphereGeometry(1,256,128),earthMat));
  const mapTiles=createMapTiles({scene,camera,renderer,earthMaterial:earthMat,loadTexture:loadTex});
  const boundaryLayer=createBoundaryLayer({scene,camera,initialData:boundaryData});
  const termGroup=group();termGroup.add(line(circle(90),{color:C.sun,width:1.8}),line(circle(102),{color:C.accent,width:1.5}));
  const gridGroup=group(),gridLines=[];for(let lon=-180;lon<180;lon+=10)gridLines.push([[lon,-90],[lon,90]]);for(let lat=-80;lat<=80;lat+=10)gridLines.push([-180,-90,0,90,180].map((lon)=>[lon,lat]));
  const gridMat=new LineMaterial({color:'#ffffff',linewidth:1,transparent:true,opacity:.16,depthWrite:false});materials.add(gridMat);gridGroup.add(new LineSegments2(new LineSegmentsGeometry().setPositions(boundarySegments(gridLines,1,1.0003)),gridMat));
  const zoneGroup=group(),zoneLabels=group(),trajGroup=group(),gtGroup=group(),eventGroup=group(),plasmaGroup=group(),cityGroup=group();
  // reported landing point (star) and the model touchdown (end of the descent track, drawn as an event)
  const SITE=A.llToVec(...M.site),site=sprite(starTex,.026);site.position.set(...SITE.map((v)=>v*1.002));scene.add(site);
  for(const z of data.zones){const pts=[];for(let i=0;i<z.ring.length-1;i++){const a=z.ring[i],b=z.ring[i+1],dl=((b[0]-a[0]+540)%360)-180,n=Math.max(1,Math.ceil(Math.max(Math.abs(dl),Math.abs(b[1]-a[1]))/.1));for(let j=0;j<n;j++)pts.push(...A.llToVec(a[0]+dl*j/n,a[1]+(b[1]-a[1])*j/n,1.0015));}pts.push(...A.llToVec(...z.ring.at(-1),1.0015));zoneGroup.add(fillMesh(z.ring,C.ink,.18),line(pts,{color:z.color,width:1.5}));
    const o=label(`${z.desc||z.role}\n${z.id}`,'zone below');o.position.set(...A.llToVec(...z.centroid,1.002));zoneLabels.add(o);}
  for(const [name,lon,lat,tier] of CITIES){const p=A.llToVec(lon,lat,1.001),dot=sprite(dotTex,.007);dot.position.set(...p);dot.userData={tier,city:name};cityGroup.add(dot);const o=label(name,'city');o.position.set(...p);o.userData={tier,city:name};o.element.title=`Sky chart over ${name}`;o.element.tabIndex=0;o.element.setAttribute('role','button');o.element.addEventListener('click',(e)=>openSky({name,lon,lat},false,{x:e.clientX,y:e.clientY}));o.element.addEventListener('keydown',(e)=>{if(e.key==='Enter')openSky({name,lon,lat});});cityGroup.add(o);}
  const siteTex=texture((g,s)=>{g.lineWidth=10;g.strokeStyle='#080a0e';g.beginPath();g.arc(s/2,s/2,s/2-10,0,2*Math.PI);g.stroke();g.lineWidth=4;g.strokeStyle=C.accent;g.stroke();g.fillStyle=C.accent;g.beginPath();g.arc(s/2,s/2,4,0,2*Math.PI);g.fill();});
  const siteMark=sprite(siteTex,.024);siteMark.visible=false;scene.add(siteMark);
  // self-luminous plasma trail: the entry track between the published blackout heights, wide translucent + bright core
  function buildPlasmaLayer(){clear(plasmaGroup);
    for(const [a,b] of M.plasma_intervals){for(const tr of flight){const [i0,i1]=tr.range(a,b);if(i1-i0<2)continue;const run=tr.pts(1,i0,i1);plasmaGroup.add(line(run,{color:C.plasma,width:10,opacity:.18}),line(run,{color:C.plasma,width:4.5,opacity:.55}),line(run,{color:C.plasmaCore,width:1.6}));}}
  }
  function buildTrajectory(){clear(trajGroup);clear(gtGroup);clear(eventGroup);
    const p=label(`${M.site_name}\nreported ${M.reported.landing_utc.slice(11,16)}Z`,'small');p.position.copy(site.position);eventGroup.add(p);
    for(const [key,tr] of Object.entries(T)){const seg=data.tracks[key];trajGroup.add(line(tr.pts(1),{color:seg.color,width:key==='orbit'?1.4:2.0,dashed:!!seg.dashed}));if(M.flight_segments.includes(key))gtGroup.add(line(tr.pts(1,0,tr.n-1,true),{color:C.ink,width:1,opacity:.26,dashed:true}));}
    for(const e of data.events){if(!e.major)continue;const tr=e.track?T[e.track]:null,s=tr?tr.sample(e.met):shipAt(e.met);const p=drawPoint(s),dot=sprite(squareTex,.014);dot.position.set(...p);eventGroup.add(dot);const o=label(`${e.label.replace(/,.*$/,'')}\n${A.fmtMET(e.met)} · ${s.alt.toFixed(0)} km`,'small');o.position.set(...p);eventGroup.add(o);}
    buildPlasmaLayer();
  }
  function onT0Change(){dirty();}

  // capsule sprite: oblate bell-shaped return module (wider than tall), heat shield down
  const capsuleTex=texture((g,s)=>{g.strokeStyle='#080a0e';g.lineWidth=3;g.lineJoin='round';g.fillStyle='#e6e9ec';
    g.beginPath();g.moveTo(s*.14,s*.70);g.lineTo(s*.27,s*.38);g.quadraticCurveTo(s*.50,s*.22,s*.73,s*.38);g.lineTo(s*.86,s*.70);g.closePath();g.fill();g.stroke();
    g.fillStyle='#6b4f3a';g.beginPath();g.moveTo(s*.10,s*.68);g.quadraticCurveTo(s*.50,s*.96,s*.90,s*.68);g.lineTo(s*.86,s*.66);g.lineTo(s*.14,s*.66);g.closePath();g.fill();g.stroke();
    g.fillStyle='#2f3a46';g.fillRect(s*.42,s*.44,s*.16,s*.06);g.fillStyle='#9aa4ae';g.fillRect(s*.30,s*.58,s*.40,s*.025);},128);
  const ship=sprite(capsuleTex,.030),shipLabel=label(M.vehicle,'vehicle');scene.add(ship,shipLabel);
  const glowTex=(inner,mid,outer)=>texture((g,s)=>{const r=s/2,gr=g.createRadialGradient(r,r,0,r,r,r);gr.addColorStop(0,inner);gr.addColorStop(.25,mid);gr.addColorStop(.7,outer);gr.addColorStop(1,'rgba(0,0,0,0)');g.fillStyle=gr;g.fillRect(0,0,s,s);},128);
  const burnGlow=sprite(glowTex('rgba(255,244,211,.9)','rgba(255,230,150,.5)','rgba(120,190,255,.1)'),.09),plasmaGlow=sprite(glowTex('rgba(255,250,230,.95)','rgba(255,160,90,.55)','rgba(255,90,40,.12)'),.12);
  for(const gl of [burnGlow,plasmaGlow]){gl.material.blending=THREE.AdditiveBlending;gl.material.depthWrite=false;scene.add(gl);}
  let fp=null,fpLam=-1;
  function updateFootprint(s){if(!state.show.fp){if(fp)fp.visible=false;return;}const lam=A.footprintDeg(s.alt,15);if(!fp||Math.abs(lam-fpLam)>.03){if(fp){scene.remove(fp);fp.geometry.dispose();materials.delete(fp.material);fp.material.dispose();}fp=line(circle(lam),{color:C.footprint,dashed:true,width:1.5});scene.add(fp);fpLam=lam;}fp.quaternion.setFromUnitVectors(Y,new THREE.Vector3(...s.u));fp.visible=s.alt>M.site_alt+2;}
  let skySite=null;
  const ei=EV.entry_interface;
  const sky=createSkyChart({shipAt,metStart:()=>metMin,metEnd:()=>MET_END,styleAt,mark:ei?{met:ei.met,label:'Entry 100 km'}:null,vehicle:M.vehicle,fmtMET:A.fmtMET,sunSubpoint,
    sunPosition:sunAt,getState:()=>({met:state.met,t0ms:t0ms()}),onJump:(met)=>{setPlaying(false);setMet(met);},onSite:(site)=>{skySite=site;siteMark.position.set(...A.llToVec(site.lon,site.lat,1.001));}});
  function openSky(site,focus=false,near=null){sky.open(site,focus,near).catch((e)=>message(`Sky chart: ${e.message}`));}
  const [home,homeLon,homeLat]=CITIES.find((c)=>c[0]==='Jiuquan');
  $('skybtn').onclick=()=>openSky(skySite||{name:home,lon:homeLon,lat:homeLat},true);

  let fly=null;
  function setFollow(on){state.follow=on;$('o-follow').checked=on;}
  const cameraScale=()=>Math.max(1,1.4/camera.aspect);
  function flyTo(lon,lat,dist){setFollow(false);const d=clamp(1+(dist-1)*cameraScale(),1.05,14);fly={from:camera.position.clone(),to:new THREE.Vector3(...A.llToVec(lon,lat,d)),target:controls.target.clone(),start:performance.now()};}
  function setMet(v){if(!Number.isFinite(v))return;state.met=clamp(v,metMin,MET_END);state.live=false;$('live').classList.remove('on');dirty();}
  function setPlaying(on){if(on){state.live=false;$('live').classList.remove('on');if(state.met>=MET_END)state.met=metMin;}state.playing=on;$('play').textContent=on?'❚❚ Pause':'▶ Play';}
  function setT0(v){if(!Number.isFinite(v))return;state.t0=clamp(v,t0Min,t0Max);$('t0').value=state.t0;onT0Change();}
  function option(select,value,text){const o=document.createElement('option');o.value=value;o.textContent=text;select.appendChild(o);}
  for(const p of index.profiles)option($('profilesel'),p.id,p.label);$('profilesel').value=profile.id;
  for(const m of profile.missions)option($('launchsel'),m.id,m.label);$('launchsel').value=entry.id;
  function selectMission(p,m){const q=new URLSearchParams(location.search);q.set('profile',p);q.set('mission',m);for(const k of ['t0','met','cam','pan','sky','follow'])q.delete(k);location.search=q;}
  $('profilesel').onchange=()=>{const p=index.profiles.find((p)=>p.id===$('profilesel').value);selectMission(p.id,p.default_mission);};
  $('launchsel').onchange=()=>selectMission(profile.id,$('launchsel').value);
  Object.assign($('t0'),{min:t0Min,max:t0Max,value:state.t0});Object.assign($('met'),{min:metMin,max:MET_END,value:state.met});
  $('t0presets').innerHTML=M.t0_presets.map((p)=>`<button class="btn" data-t0="${esc(p.time)}">${esc(p.label)}</button>`).join('');
  $('views').innerHTML=M.views.map((v,i)=>`<button class="btn" data-view="${i}">${esc(v[0])}</button>`).join('');
  $('t0').oninput=()=>setT0(+$('t0').value);$('t0presets').onclick=(e)=>{if(e.target.dataset.t0)setT0(clockSeconds(e.target.dataset.t0));};
  $('met').oninput=()=>{setPlaying(false);setMet(+$('met').value);};$('play').onclick=()=>setPlaying(!state.playing);
  $('speed').value=String(state.speed);$('speed').onchange=()=>{state.speed=+$('speed').value;};
  $('back').onclick=()=>setMet(state.met-30);$('fwd').onclick=()=>setMet(state.met+30);
  $('live').onclick=()=>{if(state.live){state.live=false;$('live').classList.remove('on');return;}const met=(Date.now()-t0ms())/1000;if(met<metMin||met>MET_END){message('The wall clock is outside this modeled return. Use playback to explore it.');return;}message('');setPlaying(false);state.live=true;$('live').classList.add('on');};
  $('views').onclick=(e)=>{const v=M.views[+e.target.dataset.view];if(v)flyTo(v[1],v[2],v[3]);};
  for(const k of Object.keys(state.show)){$('o-'+k).checked=state.show[k];$('o-'+k).onchange=()=>{state.show[k]=$('o-'+k).checked;dirty();};}
  $('o-follow').checked=state.follow;$('o-follow').onchange=()=>setFollow($('o-follow').checked);
  async function copyText(text,button){const old=button.textContent;let copied=false;try{await navigator.clipboard.writeText(text);copied=true;}catch{const box=document.createElement('textarea');box.value=text;document.body.appendChild(box);box.select();copied=document.execCommand('copy');box.remove();}button.textContent=copied?'Copied':'Copy unavailable';if(!copied)message('Clipboard unavailable. Select the text or copy the browser address.');setTimeout(()=>{button.textContent=old;},1600);}
  function shareURL(){const ll=A.vecToLL(camera.position.x,camera.position.y,camera.position.z),q=new URLSearchParams({profile:profile.id,mission:entry.id,t0:A.fmtHMS(t0ms()),met:state.met.toFixed(3),cam:`${ll.lon.toFixed(3)},${ll.lat.toFixed(3)},${camera.position.length().toFixed(3)}`,follow:state.follow?'1':'0',speed:state.speed});if(controls.target.lengthSq()>1e-8)q.set('pan',controls.target.toArray().map((v)=>v.toFixed(4)).join(','));for(const [k,v]of Object.entries(state.show))q.set(k,v?'1':'0');if(sky.isOpen()&&skySite)q.set('sky',`${skySite.lat.toFixed(4)},${skySite.lon.toFixed(4)}`);return `${location.origin}${location.pathname}?${q}`;}
  $('link').onclick=()=>{const url=shareURL();history.replaceState(null,'',url);copyText(url,$('link'));};$('copytle').onclick=()=>copyText($('tle').textContent,$('copytle'));
  $('events').onclick=(e)=>{const row=e.target.closest('[data-met]');if(row){setPlaying(false);setMet(+row.dataset.met);}};
  $('legend').innerHTML=`<div>${M.flight_segments.map((k)=>`<span><i style="border-color:${data.tracks[k].color}"></i>${esc(data.tracks[k].label)}</span>`).join('')}<span><i style="border-color:${C.plasma};border-top-width:4px"></i>Plasma trail 80–40 km</span><span><i class="d" style="border-color:${C.footprint}"></i>15° elevation circle</span><span><i style="border-color:${C.sun}"></i>Sun 0° terminator</span><span><i style="border-color:${C.accent}"></i>Sun −12° nautical twilight</span><span><b>★</b>Reported landing point</span></div>`;
  $('about').innerHTML=`<p>${esc(M.notes[0])}</p><p>${esc(M.notes[1])}</p><p>WGS-84 geometry · JPL DE440s sunlight · ${esc(D.atmosphere.split(',')[0])}.</p><p><a href="https://github.com/exoplanet5/shenzhou-reentry#readme" target="_blank" rel="noopener noreferrer">Model notes, audit & sources ↗</a></p>`;
  const narrow=matchMedia('(max-width:860px)');let panels={ctl:!narrow.matches,info:!narrow.matches};
  try{const saved=JSON.parse(localStorage.getItem('shenzhou-reentry-panels'));if(saved&&!narrow.matches)panels={ctl:!!saved.ctl,info:!!saved.info};}catch{}
  function applyPanels(){document.body.classList.toggle('ctl-open',panels.ctl);document.body.classList.toggle('info-open',panels.info);document.querySelectorAll('[data-panel]').forEach((b)=>{b.classList.toggle('on',panels[b.dataset.panel]);b.setAttribute('aria-expanded',String(panels[b.dataset.panel]));});}
  document.querySelectorAll('[data-panel]').forEach((b)=>b.onclick=()=>{const k=b.dataset.panel,on=!panels[k];if(narrow.matches)panels={ctl:false,info:false};panels[k]=on;applyPanels();try{localStorage.setItem('shenzhou-reentry-panels',JSON.stringify(panels));}catch{}});
  narrow.onchange=()=>{panels={ctl:!narrow.matches,info:!narrow.matches};applyPanels();};applyPanels();
  addEventListener('keydown',(e)=>{if(document.activeElement?.matches('input,select,textarea,button,[role="button"]'))return;if(e.code==='Space'){e.preventDefault();setPlaying(!state.playing);}if(e.key==='ArrowRight')setMet(state.met+(e.shiftKey?300:10));if(e.key==='ArrowLeft')setMet(state.met-(e.shiftKey?300:10));});

  const timeline=()=>[...data.events].sort((a,b)=>a.met-b.met);
  const fmtLL=(lat,lon)=>`${Math.abs(lat).toFixed(3)}°${lat<0?'S':'N'} ${Math.abs(lon).toFixed(3)}°${lon<0?'W':'E'}`;
  function compareRows(){const T0=t0ms(),shift=(T0-A.dateT0ms(M.date,clockSeconds(M.t0_default)))/1000;const rep=M.reported,land=EV.landing;
    const t=(utc)=>utc.slice(11,19)+'Z';
    return [['Deorbit ignition',`${A.fmtHMS(T0)}Z (model)${shift?` · shifted ${shift>0?'+':'−'}${A.fmtMET(Math.abs(shift)).slice(2)}`:''}`],
      ['Orbital module sep.',`${t(rep.om_separation_utc)} reported · ignition ${((Date.parse(rep.om_separation_utc)-A.dateT0ms(M.date,clockSeconds(M.t0_default)))/-1000).toFixed(0)} s later`],
      ['Deorbit burn',`${D.dv_ms.toFixed(1)} m/s in ${D.burn_s.toFixed(0)} s · perigee ${D.perigee_km.toFixed(0)} km`],
      ['Entry interface',`${EV.entry_interface?A.fmtHMS(T0+EV.entry_interface.met*1000)+'Z':'—'} · ${D.ei_v_kms.toFixed(2)} km/s · γ ${D.ei_fpa_deg.toFixed(2)}°`],
      ['Bank angle',`±${Math.abs(D.bank_deg).toFixed(0)}° (L/D 0.30)`],
      ['Max deceleration',`${D.max_g.toFixed(1)} g`],['Peak heating',`${D.peak_heating_Wcm2.toFixed(0)} W/cm² (Sutton–Graves)`],
      ['Blackout',`${(D.blackout_s/60).toFixed(1)} min`],['Parachute deploy',`${D.v_chute_ms.toFixed(0)} m/s at 10 km`],
      ['Touchdown',`${land?A.fmtHMS(T0+land.met*1000)+'Z':'—'} model · ${t(rep.landing_utc)} reported`],
      ['Landing point',`${fmtLL(...D.landing)} model\n${fmtLL(...rep.landing)} reported (${Math.hypot(D.miss_north_km,D.miss_east_km).toFixed(2)} km)`]];
  }
  function buildTables(){const T0=t0ms();$('t0v').textContent=A.fmtHMS(T0)+'Z';
    $('compare').querySelector('tbody').innerHTML=compareRows().map(([k,v])=>`<tr><td>${esc(k)}</td><td>${esc(v).replace(/\n/g,'<br>')}</td></tr>`).join('');
    $('events').querySelector('tbody').innerHTML=timeline().map((e)=>`<tr class="${e.official?'official':''}"><td><button class="time-jump" data-met="${e.met}">${A.fmtMET(e.met)}</button></td><td>${A.fmtHMS(T0+e.met*1000)}</td><td>${esc(e.label)}</td></tr>`).join('');
    const R=data.tle_ref,sets=R?.sets||[];$('tle').textContent=sets.length?sets.map((s)=>{const t=A.tleForT0(s,R.t0,R.raan_rate_deg_per_min,T0);return `${t.name}\n${t.l1}\n${t.l2}`;}).join('\n\n'):'No TLE supplied for this mission.';$('copytle').disabled=!sets.length;
    document.querySelectorAll('[data-t0]').forEach((b)=>b.classList.toggle('on',clockSeconds(b.dataset.t0)===state.t0));tablesDirty=false;
  }
  function updateUI(s){const utc=t0ms()+state.met*1000,st=styleAt(state.met,t0ms()),ll=A.vecToLL(...s.u),fr=A.siteFrame(ll.lon,ll.lat),sunAlt=A.lookAngles(fr,sunAt(utc)).el;
    $('c-date').textContent=A.fmtDate(utc);$('c-utc').textContent=A.fmtHMS(utc);$('c-met').textContent=A.fmtMET(state.met);$('c-cst').textContent=A.fmtHMS(utc,8);$('metv').textContent=A.fmtMET(state.met);if(document.activeElement!==$('met'))$('met').value=state.met;
    if(tablesDirty)buildTables();
    const range=greatCircleKm(ll.lon,ll.lat,M.site[0],M.site[1]),left=MET_END-state.met;
    const rows=[['Phase',phaseOf(state.met)],['Altitude',s.alt.toFixed(s.alt<20?2:1)+' km WGS-84'],
      ['Speed',s.vrel!==null?`${s.vrel>=1?s.vrel.toFixed(2)+' km/s':(s.vrel*1000).toFixed(0)+' m/s'} air-relative · ${s.vin.toFixed(2)} km/s inertial`:'—'],
      ['Mach · load',s.mach!==null&&s.alt<150&&s.mach>0?`Mach ${s.mach<10?s.mach.toFixed(1):s.mach.toFixed(0)} · ${s.g.toFixed(2)} g`:'—'],
      ['Sub-point',`${ll.lat.toFixed(2)}°, ${ll.lon.toFixed(2)}°`],['Illumination',st.hud],['Ground below',`${A.lightingClass(sunAlt)} · ${sunAlt.toFixed(1)}°`],
      ['To landing site',`${range.toFixed(range<10?1:0)} km · ${left>0?A.fmtMET(left).slice(2)+' to touchdown':'landed'}`]];
    $('status').querySelector('tbody').innerHTML=rows.map(([k,v])=>`<tr><td>${k}</td><td>${esc(v)}</td></tr>`).join('');
    const next=timeline().find((e)=>e.met>state.met);document.querySelectorAll('#events [data-met]').forEach((b)=>{b.closest('tr').classList.toggle('past',+b.dataset.met<=state.met);b.closest('tr').classList.toggle('next',next?.met===+b.dataset.met);});
  }
  const ray=new THREE.Raycaster(),globe=new THREE.Sphere(new THREE.Vector3(),1),hit=new THREE.Vector3();
  function trackAt(x,y){const r=view.getBoundingClientRect();let nearest=null,best=13;
    for(const tr of flight)for(let i=0;i<tr.n;i+=tr===T.orbit?3:1){const p=new THREE.Vector3(...tr.pt(i,1));if(!visible(p))continue;const q=p.project(camera),d=Math.hypot((q.x+1)*r.width/2+r.left-x,(1-q.y)*r.height/2+r.top-y);if(d<best){best=d;nearest={met:tr.metAt(i),alt:tr.alt[i]};}}
    return nearest;}
  function groundAt(x,y){const r=view.getBoundingClientRect();ray.setFromCamera({x:(x-r.left)/r.width*2-1,y:1-(y-r.top)/r.height*2},camera);return ray.ray.intersectSphere(globe,hit)?A.vecToLL(hit.x,hit.y,hit.z):null;}
  const pointers=new Set();let press=null;
  renderer.domElement.addEventListener('pointerdown',(e)=>{if(e.isPrimary)pointers.clear();pointers.add(e.pointerId);press=pointers.size===1&&e.button===0?{x:e.clientX,y:e.clientY,t:performance.now(),slop:e.pointerType==='mouse'?4:10}:null;fly=null;setFollow(false);});
  renderer.domElement.addEventListener('pointercancel',(e)=>{pointers.delete(e.pointerId);press=null;});
  renderer.domElement.addEventListener('pointerup',(e)=>{const p=press;press=null;pointers.delete(e.pointerId);
    if(!p||Math.hypot(e.clientX-p.x,e.clientY-p.y)>p.slop||performance.now()-p.t>600)return;
    const track=trackAt(e.clientX,e.clientY);if(track){setPlaying(false);setMet(track.met);return;}
    const ll=groundAt(e.clientX,e.clientY);if(ll)openSky({lat:+ll.lat.toFixed(4),lon:+ll.lon.toFixed(4),custom:true},false,{x:e.clientX,y:e.clientY});});
  renderer.domElement.addEventListener('pointerleave',()=>{$('inspect').hidden=true;});
  renderer.domElement.addEventListener('pointermove',(e)=>{if(e.buttons||e.pointerType==='touch')return;const nearest=trackAt(e.clientX,e.clientY);
    $('inspect').hidden=!nearest;renderer.domElement.style.cursor=nearest?'pointer':groundAt(e.clientX,e.clientY)?'crosshair':'';if(nearest){$('inspect').textContent=`${A.fmtMET(nearest.met)} · ${nearest.alt.toFixed(1)} km\nClick to seek`;Object.assign($('inspect').style,{left:Math.max(16,Math.min(innerWidth-240,e.clientX+15))+'px',top:Math.min(innerHeight-80,e.clientY+15)+'px'});}});
  function declutterLabels(){
    const boxes=['ctl','info','legend'].map((id)=>$(id)).filter((el)=>el.getClientRects().length).map((el)=>el.getBoundingClientRect());
    const overlap=(a,b)=>a.left<b.right+4 && a.right+4>b.left && a.top<b.bottom+3 && a.bottom+3>b.top;
    const objects=[shipLabel,...eventGroup.children,...zoneLabels.children,...cityGroup.children];
    for(const o of objects){if(!o.isCSS2DObject || o.element.style.display==='none')continue;const r=o.element.getBoundingClientRect();const show=r.left>=16 && r.right<=innerWidth-16 && r.top>=50 && r.bottom<=innerHeight-24 && !boxes.some((b)=>overlap(r,b));o.element.style.visibility=show?'visible':'hidden';if(show)boxes.push(r);}
  }
  let last=null,lastUI=0;
  function frame(now){const dt=Math.min(.1,(now-(last??now))/1000);last=now;
    if(state.live){const met=(Date.now()-t0ms())/1000;state.met=clamp(met,metMin,MET_END);if(met>=MET_END){state.live=false;$('live').classList.remove('on');message('Modeled return complete.');}}
    else if(state.playing){state.met=Math.min(MET_END,state.met+dt*state.speed);if(state.met===MET_END)setPlaying(false);}
    const s=shipAt(state.met),sv=sunVecAt(t0ms()+state.met*1000),sty=styleAt(state.met,t0ms());earthMat.uniforms.sunDir.value.set(...sv);earthMat.uniforms.lights.value=state.show.lights?1:0;termGroup.quaternion.setFromUnitVectors(Y,new THREE.Vector3(...sv));termGroup.visible=state.show.term;
    ship.position.set(...drawPoint(s));shipLabel.position.copy(ship.position);ship.material.color.setScalar(sty.lit||sty.plasma?1:.45);
    burnGlow.position.copy(ship.position);plasmaGlow.position.copy(ship.position);burnGlow.visible=state.show.plasma&&sty.powered;plasmaGlow.visible=state.show.plasma&&sty.plasma;
    const ahead=shipAt(Math.min(MET_END,state.met+2)),p0=ship.position.clone().project(camera),p1=new THREE.Vector3(...drawPoint(ahead)).project(camera);if(state.met<MET_END-2)ship.material.rotation=Math.atan2((p1.y-p0.y)*view.clientHeight,(p1.x-p0.x)*view.clientWidth)+Math.PI/2;
    updateFootprint(s);gtGroup.visible=state.show.gt;gridGroup.visible=state.show.grid;zoneGroup.visible=state.show.zones;zoneLabels.visible=state.show.zones;plasmaGroup.visible=state.show.plasma;cityGroup.visible=state.show.cities;
    if(fly){const k=clamp((now-fly.start)/1200,0,1),t=k*k*(3-2*k),d=THREE.MathUtils.lerp(fly.from.length(),fly.to.length(),t);camera.position.copy(fly.from.clone().normalize().lerp(fly.to.clone().normalize(),t).normalize().multiplyScalar(d));controls.target.copy(fly.target).multiplyScalar(1-t);if(k===1)fly=null;}
    else if(state.follow){const d=camera.position.length();camera.position.normalize().lerp(new THREE.Vector3(...s.u),1-Math.exp(-dt*2.5)).normalize().multiplyScalar(d);controls.target.multiplyScalar(Math.exp(-dt*2.5));}
    controls.panSpeed=clamp((camera.position.length()-1)/Math.max(1e-6,camera.position.distanceTo(controls.target)),.01,1);
    controls.rotateSpeed=Math.min(1,.12+.3*(camera.position.length()-1));controls.update();
    if(camera.position.length()<1.05){camera.position.setLength(1.05);camera.lookAt(controls.target);}
    mapTiles.update(now,view.clientWidth,view.clientHeight);
    boundaryLayer.update(now,view.clientWidth,view.clientHeight,renderer.getPixelRatio(),state.show.borders);
    for(const g of [zoneLabels,eventGroup])for(const o of g.children)if(o.isCSS2DObject)o.visible=state.show.labels&&visible(o.position);
    shipLabel.visible=state.show.labels&&visible(ship.position);site.visible=visible(site.position);
    siteMark.visible=!!skySite&&sky.isOpen()&&visible(siteMark.position);
    const cityDistance=camera.position.length();
    for(const o of cityGroup.children)o.visible=visible(o.position)&&cityInRange(o.userData.tier,cityDistance)&&(!o.isCSS2DObject||state.show.labels);
    renderer.render(scene,camera);labels.render(scene,camera);declutterLabels();if(sky.isOpen()&&now-lastUI>80)sky.render();if(now-lastUI>100){lastUI=now;updateUI(s);}requestAnimationFrame(frame);
  }
  function resize(){const w=view.clientWidth,h=view.clientHeight,oldScale=cameraScale();camera.aspect=w/h;const d=camera.position.length();if(d>0)camera.position.setLength(clamp(1+(d-1)*cameraScale()/oldScale,1.05,14));renderer.setSize(w,h);labels.setSize(w,h);camera.updateProjectionMatrix();for(const m of materials)m.resolution.set(w,h);}
  addEventListener('resize',resize);resize();
  const cam=(qs.get('cam')||'').split(',').map(Number),v=M.views[Math.min(1,M.views.length-1)];
  const [lon,lat,dist]=cam.length===3&&cam.every(Number.isFinite)?[cam[0],clamp(cam[1],-90,90),clamp(cam[2],1.05,14)]:v.slice(1);
  const pan=(qs.get('pan')||'').split(',').map(Number);if(pan.length===3&&pan.every(Number.isFinite))controls.target.set(...pan).clampLength(0,.95);
  camera.position.set(...A.llToVec(lon,lat,qs.has('cam')?dist:clamp(1+(dist-1)*cameraScale(),1.05,14)));camera.lookAt(controls.target);buildTrajectory();
  requestAnimationFrame((t)=>{frame(t);$('loading').remove();});
  const want=qs.get('sky'),city=CITIES.find((c)=>c[0].toLowerCase()===want?.toLowerCase()),ll=(want||'').split(',').map(Number);
  if(city)openSky({name:city[0],lon:city[1],lat:city[2]});else if(ll.length===2&&ll.every(Number.isFinite)&&Math.abs(ll[0])<=90&&Math.abs(ll[1])<=180)openSky({lat:ll[0],lon:ll[1],custom:true});
  window.__sz={state,setMet,setT0,setPlaying,flyTo,camera,controls,pick:groundAt,trackAt,observerMarker:siteMark,shareURL,sky,shipAt,styleAt,footprint:()=>fp,boundaryCoverage:boundaryData.coverage,earth:earthMat,mapLOD:mapTiles,boundaries:boundaryLayer,meta:M,events:data.events,groups:{trajGroup,plasmaGroup,termGroup,cityGroup,gridGroup,zoneGroup,eventGroup},profile:profile.id,mission:entry.id,metEnd:MET_END};
}
