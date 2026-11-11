// Every mission on the page passes the page's own validator, and says what the model solved.
//   node --test tests/*.test.mjs
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as A from '../docs/js/astro.js';
import {validateManifest,validateMission,selectProfile,createFlight,solarEphemeris,sunlightClearance,greatCircleKm,clockSeconds} from '../docs/js/profile.js';
import {vehicleStateAt} from '../docs/js/vehicle-art.js';
const read=(path)=>JSON.parse(fs.readFileSync(new URL('../'+path,import.meta.url)));
const index=validateManifest(read('docs/data/profiles.json')),entries=index.profiles[0].missions;
const near=(a,b,tol,what='')=>assert.ok(Math.abs(a-b)<=tol,`${what} ${a} vs ${b}`);

test('manifest: the Shenzhou-23 forecast and the Shenzhou-20 reconstruction, default on the forecast',()=>{
  assert.deepEqual(entries.map((m)=>m.id),['sz23-1129','sz20']);
  assert.equal(selectProfile(index,new URLSearchParams()).entry.id,'sz23-1129');
  assert.equal(selectProfile(index,new URLSearchParams('mission=sz20')).entry.id,'sz20');
  assert.match(entries[0].label,/forecast/);
});
for(const entry of entries)test(`${entry.id}: valid mission, continuous from orbit to touchdown at the site`,()=>{
  const data=validateMission(read('docs/'+entry.file)),m=data.meta,f=createFlight(data),sol=read(`out/${entry.id}_solution.json`),ev=Object.fromEntries(data.events.map((e)=>[e.key,e]));
  assert.equal(data.schema_version,1);assert.deepEqual(m.flight_segments,['orbit','deorbit','entry','descent']);
  assert.equal(f.start,m.met_min);near(f.end,ev.landing.met,.11,'end');assert.ok(m.met_min<=-m.period_s);
  // T0 is the solved ignition, and the events are the solution's
  assert.equal(`${m.date}T${m.t0_default}Z`,sol.parameters.t_ign_utc);
  for(const e of sol.events)near(ev[e.key].met,e.met,1e-9,e.key);
  const order=['om_separation','ignition','burn_end','sm_separation','trim','entry_interface','blackout_start','peak_heating','blackout_end','mach1','chute','main','shield','landing'].map((k)=>ev[k].met);
  assert.deepEqual(order,[...order].sort((a,b)=>a-b));
  // the track: 380-400 km orbit, 100 km at the entry interface, the site at touchdown
  assert.ok(f.shipAt(m.met_min).alt>370&&f.shipAt(-1).alt<400);near(f.shipAt(ev.entry_interface.met).alt,100,.05,'entry height');
  const down=A.vecToLL(...f.shipAt(f.end).u);near(greatCircleKm(down.lon,down.lat,m.landing.lon,m.landing.lat),0,.05,'landing miss km');near(f.shipAt(f.end).alt,m.landing.alt_km,.01,'site height');
  for(let t=m.met_min;t<f.end;t+=20){const a=f.shipAt(t).p,b=f.shipAt(t+20).p;assert.ok(Math.hypot(...a.map((v,i)=>v-b[i]))<170,`jump at ${t}`);}
  // entry figures and the plasma interval between the blackout heights
  const [b0,b1]=m.plasma_intervals[0];near(b0,ev.blackout_start.met,1e-9);near(f.shipAt(b0).alt,80,.05);near(f.shipAt(b1).alt,40,.05);
  const peak=f.shipAt(ev.max_g.met);near(peak.g,sol.diag.max_g,.05,'max g');assert.ok(peak.mach>5&&f.shipAt(ev.chute.met).vrel<.25&&f.shipAt(f.end-30).vrel<.012);
  // the capsule cartoon follows the sequence
  const st=(t)=>m.stack.states[vehicleStateAt(t,m.stack,f.poweredAt).state];
  assert.equal(st(ev.om_separation.met-1).segs.length,3);assert.deepEqual(st(1).segs,['sm','rm']);assert.ok(vehicleStateAt(1,m.stack,f.poweredAt).burning);
  assert.deepEqual(st(ev.sm_separation.met+1).segs,['rm']);assert.ok(st((b0+b1)/2).plasma);assert.equal(st(ev.chute.met+1).chute,'drogue');assert.equal(st(ev.main.met+1).chute,'main');
  // Sun and Moon tables cover every T0 of the slider, from the first sample to touchdown
  for(const table of [data.sun,data.moon]){const at=solarEphemeris(table);for(const t0 of [m.t0_min,m.t0_max])for(const met of [m.met_min,f.end])assert.ok(at(A.dateT0ms(m.date,clockSeconds(t0))+met*1000).every(Number.isFinite));}
  assert.ok(m.summary.rows.length>=9&&m.notes.length>=4&&m.model_badge.length<=40);
});
test('the Shenzhou-23 forecast lands at night, on the pass of the orbit forecast that crosses the site',()=>{
  const fc=read('out/sz23_orbit_forecast.json');
  for(const entry of entries.slice(0,1)){
    const data=read('docs/'+entry.file),m=data.meta,f=createFlight(data),sun=solarEphemeris(data.sun),T0=A.dateT0ms(m.date,clockSeconds(m.t0_default)),utc=T0+f.end*1000;
    const el=A.lookAngles(A.siteFrame(m.landing.lon,m.landing.lat),sun(utc)).el;assert.ok(el<-18,`Sun ${el} at the site`);   // astronomical night
    // the whole plasma arc is in the Earth's shadow, so only its own light shows
    const [b0,b1]=m.plasma_intervals[0];for(const t of [b0,(b0+b1)/2,b1])assert.ok(sunlightClearance(f.shipAt(t).p,sun(T0+t*1000))<0);
    const pass=fc.passes.find((p)=>p.closest_utc===fc.chosen[m.date]);near((utc-Date.parse(pass.closest_utc))/1000,927,25,'touchdown after the pass, s');
    assert.match(m.model_badge,/Forecast/);assert.equal(m.t0_presets.length,3);
  }
  assert.ok(Math.abs(fc.passes.find((p)=>p.closest_utc===fc.chosen['2026-11-29']).cross_track_km)<5);
});
test('Shenzhou-20 keeps its reconstruction: reported landing minute and point',()=>{
  const d=read('out/sz20_solution.json').diag;assert.equal(d.landing_utc,'2026-01-19T01:34:30Z');near(d.dv_ms,138.8,.1);near(Math.hypot(d.miss_north_km,d.miss_east_km),0,.01);
});
