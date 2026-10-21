import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as A from '../docs/js/astro.js';
import {validateManifest,validateMission,selectProfile,createFlight,solarEphemeris,sunlightClearance,greatCircleKm,clockSeconds,Track} from '../docs/js/profile.js';
const load=(name)=>JSON.parse(fs.readFileSync(new URL('../docs/data/'+name,import.meta.url)));
const data=load('sz20.json'),index=load('profiles.json'),flight=createFlight(data),sun=solarEphemeris(data.sun);
const M=data.meta,T0=A.dateT0ms(M.date,clockSeconds(M.t0_default)),EV=Object.fromEntries(data.events.filter((e)=>e.key).map((e)=>[e.key,e]));
const near=(a,b,tol=1e-7)=>assert.ok(Math.abs(a-b)<tol,`${a} vs ${b}`);

test('manifest selects the Shenzhou profile and sz20 mission by default',()=>{
  validateManifest(index);
  const sel=selectProfile(index,new URLSearchParams());assert.equal(sel.profile.id,'shenzhou');assert.equal(sel.entry.id,'sz20');
  assert.equal(selectProfile(index,new URLSearchParams('mission=unknown')).entry.id,'sz20');
});
test('mission schema rejects gaps, nonfinite samples, bad intervals and short solar coverage',()=>{
  validateMission(data);
  for(const change of [(d)=>d.tracks.entry.met0++, (d)=>d.tracks.deorbit.alt.pop(), (d)=>d.tracks.orbit.lon[3]=NaN, (d)=>d.sun.vectors.length=2,
      (d)=>d.meta.plasma_intervals=[[-1e9,0]], (d)=>d.tracks.entry.g=[1], (d)=>d.meta.met_min=5]){
    const bad=structuredClone(data);change(bad);assert.throws(()=>validateMission(bad));
  }
});
test('flight starts a full orbit before the burn and ends at the landing site',()=>{
  near(flight.start,M.met_min);
  const end=flight.shipAt(flight.end),ll=A.vecToLL(...end.u);
  near(ll.lon,M.site[0],1e-3);near(ll.lat,M.site[1],1e-3);near(end.alt,M.site_alt,1e-3);
  near(greatCircleKm(ll.lon,ll.lat,...M.site),0,0.2);
});
test('segment joins are continuous in position and speed',()=>{
  for(let i=1;i<flight.flight.length;i++){const a=flight.flight[i-1],b=flight.flight[i];
    near(a.end,b.met0,1e-6);near(Math.hypot(...a.sample(a.end).p.map((v,j)=>v-b.sample(b.met0).p[j])),0,1e-6);near(a.sample(a.end).vrel,b.sample(b.met0).vrel,1e-9);}
});
test('events are ordered and consistent with the published heights',()=>{
  const h=(k)=>flight.shipAt(EV[k].met).alt;
  near(h('sm_separation'),145,0.5);near(h('entry_interface'),100,0.5);near(h('blackout_start'),80,0.5);near(h('blackout_end'),40,0.5);near(h('chute'),10,0.5);
  assert.ok(EV.ignition.met===0 && EV.burn_end.met>EV.ignition.met && EV.sm_separation.met>EV.burn_end.met && EV.entry_interface.met>EV.sm_separation.met && EV.landing.met>EV.chute.met);
  assert.ok(flight.poweredAt(10) && !flight.poweredAt(EV.burn_end.met+1) && flight.plasmaAt((EV.blackout_start.met+EV.blackout_end.met)/2) && !flight.plasmaAt(EV.chute.met));
});
test('capsule decelerates: hypersonic at entry, subsonic at the parachute, walking pace at touchdown',()=>{
  const ei=flight.shipAt(EV.entry_interface.met),ch=flight.shipAt(EV.chute.met),land=flight.shipAt(flight.end);
  assert.ok(ei.mach>20 && ei.vrel>7 && ch.mach<1 && ch.vrel*1000>150 && ch.vrel*1000<220 && land.vrel*1000<10);
  const gmax=Math.max(...flight.tracks.entry.g);assert.ok(gmax>2.5 && gmax<6,`max g ${gmax}`);
});
test('reported landing is matched by the reconstruction within the stated tolerance',()=>{
  const d=M.diag,land=Date.parse(d.landing_utc),rep=Date.parse(M.reported.landing_utc);
  assert.ok(Math.abs(land-rep)<30000 && Math.hypot(d.miss_north_km,d.miss_east_km)<1);
  near(T0+EV.landing.met*1000,land,1500);
});
test('solar table covers extreme T0 and MET combinations; no extrapolation',()=>{
  for(const t of [M.t0_min,M.t0_max])for(const met of [M.met_min-600,flight.end])assert.ok(sun(A.dateT0ms(M.date,clockSeconds(t))+met*1000).every(Number.isFinite));
  assert.throws(()=>sun(T0-2*86400000));
});
test('time shift changes illumination but never the physical track',()=>{
  const met=EV.entry_interface.met,before=flight.shipAt(met).p;
  const litA=sunlightClearance(before,sun(T0+met*1000))>0,litB=sunlightClearance(before,sun(T0+met*1000+8*3600000))>0;
  assert.notEqual(litA,litB);assert.deepEqual(flight.shipAt(met).p,before);
});
test('burn point is in Earth shadow over the South Atlantic and the plasma phase is around sunrise over Xinjiang',()=>{
  const b=flight.shipAt(0),bl=A.vecToLL(...b.u);assert.ok(bl.lat<-20 && bl.lon<0 && !(sunlightClearance(b.p,sun(T0))>0));
  const mid=(EV.blackout_start.met+EV.blackout_end.met)/2,p=flight.shipAt(mid),pl=A.vecToLL(...p.u);
  assert.ok(pl.lon>80 && pl.lon<100 && pl.lat>39 && pl.lat<43);
  const el=A.lookAngles(A.siteFrame(pl.lon,pl.lat),sun(T0+mid*1000)).el;assert.ok(el>-6 && el<6,`sun elevation ${el}`);
});
test('Cartesian track interpolation crosses the antimeridian locally',()=>{
  const t=new Track({met0:0,dt:10,lon:[179,-179],lat:[0,0],alt:[100,100],color:'#ffffff',label:'x'});
  assert.ok(Math.abs(A.vecToLL(...t.sample(5).u).lon)>179.99);
});
test('both element sets carry valid checksums and the deorbit ellipse dips below the surface',()=>{
  for(const s of data.tle_ref.sets){assert.equal(s.l1[68],A.tleChecksum(s.l1));assert.equal(s.l2[68],A.tleChecksum(s.l2));}
  assert.ok(M.diag.synthetic_tle.perigee_km<0 && M.diag.synthetic_tle.apogee_km>350);
});
