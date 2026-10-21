import {test} from 'node:test';
import assert from 'node:assert/strict';
import {LIMITS,rangeMin,clampView,rig,headingOf,localFrame} from '../docs/js/globe-math.js';
import {llToVec} from '../docs/js/astro.js';

const norm=(v)=>Math.hypot(...v),dot=(a,b)=>a.reduce((s,x,i)=>s+x*b[i],0);
const views=[];for(const [lon,lat]of [[104,30.7],[0,0],[-170,-45],[111.6,38.9]])for(const heading of [0,37,180,300])for(const tilt of [0,25,60,80])views.push({pivot:llToVec(lon,lat),heading,tilt,range:.6});

test('an untilted view looks straight down at the pivot with north up, matching the old camera',()=>{
  const pivot=llToVec(104,30.7),{position,up,target}=rig({pivot,heading:0,tilt:0,range:2.6});
  position.forEach((v,i)=>assert.ok(Math.abs(v-3.6*pivot[i])<1e-12));
  assert.ok(Math.abs(norm(position)-3.6)<1e-12);
  const {north}=localFrame(pivot);up.forEach((v,i)=>assert.ok(Math.abs(v-north[i])<1e-12));
  assert.deepEqual(target,pivot.map((v)=>v/norm(pivot)));
});

test('screen-up stays perpendicular to the view and encodes the heading at every tilt below 90°',()=>{
  for(const view of views){
    const {position,up,target}=rig(view),look=target.map((v,i)=>v-position[i]);
    assert.ok(Math.abs(dot(up,look))<1e-9,'up is perpendicular to the view direction');
    assert.ok(Math.abs(norm(up)-1)<1e-12);
    assert.ok(Math.abs(norm(look)-view.range)<1e-12,'the pivot is one range away');
    const back=headingOf(view.pivot,up),diff=Math.abs(((back-view.heading)%360+540)%360-180);
    assert.ok(diff<1e-9,`heading ${view.heading} at tilt ${view.tilt} read back as ${back}`);
  }
});

test('tilting never brings the camera closer to the centre than the minimum distance',()=>{
  assert.ok(Math.abs(rangeMin(0)-(LIMITS.minDistance-1))<1e-12);
  for(let tilt=0;tilt<=LIMITS.maxTilt;tilt+=5){
    const r=rangeMin(tilt),{position}=rig({pivot:llToVec(100,35),heading:45,tilt,range:r});
    assert.ok(Math.abs(norm(position)-LIMITS.minDistance)<1e-9,`tilt ${tilt}`);
    assert.ok(rangeMin(tilt+5)>=r,'a steeper tilt needs more range');
  }
  const near=rig({pivot:llToVec(100,35),heading:45,tilt:LIMITS.maxTilt,range:rangeMin(LIMITS.maxTilt)/2});
  assert.ok(norm(near.position)<LIMITS.minDistance,'the raw rig can go lower, so views must be clamped');
});

test('view clamping wraps the heading and bounds tilt and range',()=>{
  assert.deepEqual(clampView({heading:999,tilt:-50,range:0}),{heading:279,tilt:0,range:rangeMin(0)});
  assert.equal(clampView({heading:-90,tilt:95,range:99}).heading,270);
  assert.equal(clampView({heading:0,tilt:95,range:99}).tilt,LIMITS.maxTilt);
  assert.equal(clampView({heading:0,tilt:95,range:99}).range,LIMITS.maxRange);
  assert.equal(clampView({heading:0,tilt:LIMITS.maxTilt,range:.05}).range,rangeMin(LIMITS.maxTilt));
  assert.equal(clampView({heading:0,tilt:30,range:2}).range,2);
});

test('local frames are right-handed and handle the poles',()=>{
  for(const n of [llToVec(20,50),[0,1,0],[0,-1,0]]){
    const {east,north,up}=localFrame(n);
    for(const v of [east,north,up])assert.ok(Math.abs(norm(v)-1)<1e-12);
    assert.ok(Math.abs(dot(east,north))<1e-12&&Math.abs(dot(east,up))<1e-12&&Math.abs(dot(north,up))<1e-12);
  }
  const {east,north}=localFrame(llToVec(0,0));
  assert.ok(Math.abs(east[2]+1)<1e-12,'east at lon 0 points toward lon 90E (scene −z)');
  assert.ok(Math.abs(north[1]-1)<1e-12,'north at the equator is the pole axis');
});
