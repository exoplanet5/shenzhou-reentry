// Cartoon of the launch vehicle, drawn nozzle-down on a square canvas from meta.stack: segment lengths and widths in metres, with the width doubled so the
// shape reads at sprite size. The stack shortens as stages separate, so each state has its own segments and scale. A state may carry side
// boosters, {count, len, w, burn}: two are drawn in profile beside the core, with their own flames while burn is set.
// A crewed-capsule stack uses the kinds 'service', 'capsule' and 'orbital' (a Shenzhou or Soyuz in profile), and a state may add plasma: true (the
// entry sheath around the heat shield), chute: 'drogue' or 'main' (the capsule hangs under its parachute) and scorched: true (after the heating).
const COL = {outline: '#0a0d12', body: ['#8d97a2', '#f6f8fa', '#d7dde3', '#7c8792'], dark: ['#27303a', '#59656f', '#39434d', '#1a2027'], band: '#c8372d', gold: ['#8a6a1f', '#ecc75a', '#c79c36', '#73581a']};
const WIDTH_BOOST = 2.0;   // default; a stack may set its own width_boost, 1 for true proportions

// Missions without meta.stack get a plain rocket: the full stack under power, then the payload.
export const genericStack = (meta) => ({
  total_m: 30, burn_end: meta.insertion_met,
  segments: {core: {len: 18, w: 3, kind: 'solid', band: true}, upper: {len: 4, w: 3, kind: 'liquid'}, fairing: {len: 8, w: 3.6, kind: 'fairing'}, payload: {len: 3, w: 2, kind: 'payload'}},
  states: [{until: meta.insertion_met, segs: ['core', 'upper', 'fairing'], zoom: 1, burn: 'liquid'}, {segs: ['payload'], zoom: 3.2, burn: null}],
});

export const vehicleStateAt = (met, stack, poweredAt) => {
  const found = stack.states.findIndex((s) => s.until !== undefined && met < s.until);
  return {state: found < 0 ? stack.states.length - 1 : found, burning: poweredAt(met) && met <= stack.burn_end};
};

function shade(g, x, w, stops) {
  const grad = g.createLinearGradient(x - w / 2, 0, x + w / 2, 0);
  grad.addColorStop(0, stops[0]); grad.addColorStop(.32, stops[1]); grad.addColorStop(.68, stops[2]); grad.addColorStop(1, stops[3]);
  return grad;
}
function flame(g, x, y, w, len, kind) {
  const solid = kind === 'solid';
  const plume = (wid, l, stops) => {
    const grad = g.createLinearGradient(0, y, 0, y + l);
    stops.forEach(([p, c]) => grad.addColorStop(p, c));
    g.fillStyle = grad; g.beginPath(); g.moveTo(x - wid / 2, y);
    g.bezierCurveTo(x - wid * .62, y + l * .3, x - wid * .22, y + l * .72, x, y + l);
    g.bezierCurveTo(x + wid * .22, y + l * .72, x + wid * .62, y + l * .3, x + wid / 2, y); g.closePath(); g.fill();
  };
  if (solid) {
    plume(w, len, [[0, 'rgba(255,190,80,.95)'], [.45, 'rgba(255,120,30,.72)'], [1, 'rgba(255,70,10,0)']]);
    plume(w * .5, len * .62, [[0, 'rgba(255,255,240,1)'], [.6, 'rgba(255,225,130,.85)'], [1, 'rgba(255,190,80,0)']]);
  } else {
    plume(w, len, [[0, 'rgba(150,205,255,.85)'], [1, 'rgba(90,160,255,0)']]);
    plume(w * .45, len * .6, [[0, 'rgba(240,248,255,1)'], [1, 'rgba(170,215,255,0)']]);
  }
}

// Starship and Super Heavy, kinds 'starship' and 'superheavy', in profile: stainless hulls with only the parts that identify them. Each is drawn from its
// base (x, bot) upward over length l at width w; heights are fractions of l and spans fractions of w, so the shapes keep their proportions at any width_boost.
const STEEL = ['#858f9a', '#f4f6f8', '#cdd3d9', '#747e89'], TILE = '#232830', DARK = '#2b3139';
const poly = (g, pts) => { g.beginPath(); pts.forEach(([px, py], i) => (i ? g.lineTo(px, py) : g.moveTo(px, py))); g.closePath(); g.fill(); g.stroke(); };
const OWN_BASE = new Set(['starship', 'superheavy', 'capsule']);   // these draw their own base, so the stack adds no nozzle

// Return capsule, kind 'capsule': a blunt heat shield at the base, bell-shaped sides and a rounded top a little under half the base width, as on
// Shenzhou and Soyuz. Drawn from its base (x, bot) upward; returns the width of its top, where the next segment sits.
const HULL = ['#7e8891', '#eef1f4', '#cfd5db', '#6d7780'], CHAR = ['#3d342e', '#8f8378', '#6f655c', '#2f2823'], SHIELD = ['#1c1613', '#5a4334', '#3f2e24', '#15100d'];
function capsule(g, x, bot, w, l, scorched) {
  const sh = bot - l * .2, top = bot - l, tw = w * .44, lw = g.lineWidth;
  const body = new Path2D();
  body.moveTo(x - w / 2, sh); body.bezierCurveTo(x - w * .47, sh - l * .34, x - tw * .62, top + l * .2, x - tw / 2, top + l * .07);
  body.quadraticCurveTo(x, top - l * .06, x + tw / 2, top + l * .07);
  body.bezierCurveTo(x + tw * .62, top + l * .2, x + w * .47, sh - l * .34, x + w / 2, sh); body.closePath();
  const shield = new Path2D();
  shield.moveTo(x - w / 2, sh); shield.bezierCurveTo(x - w * .42, bot + l * .03, x + w * .42, bot + l * .03, x + w / 2, sh); shield.closePath();
  g.fillStyle = shade(g, x, w, SHIELD); g.fill(shield); g.stroke(shield);
  g.fillStyle = shade(g, x, w, scorched ? CHAR : HULL); g.fill(body);
  g.save(); g.clip(body);
  if (scorched) {                                            // soot streaks swept back from the shoulder
    g.strokeStyle = 'rgba(28,20,16,.5)'; g.lineWidth = w * .05;
    for (const f of [-.36, -.15, .08, .3]) { g.beginPath(); g.moveTo(x + f * w, sh); g.lineTo(x + f * w * .5, top + l * .3); g.stroke(); }
  }
  g.fillStyle = scorched ? 'rgba(25,18,14,.55)' : 'rgba(70,80,90,.5)'; g.fillRect(x - w / 2, sh - l * .09, w, l * .045);   // shoulder band above the shield
  g.restore(); g.lineWidth = lw; g.strokeStyle = COL.outline; g.stroke(body);
  g.fillStyle = '#18222c'; g.beginPath(); g.arc(x - w * .13, bot - l * .56, Math.max(1.5, w * .075), 0, 2 * Math.PI); g.fill();   // window
  g.strokeStyle = scorched ? '#5d544c' : '#aeb7c0'; g.lineWidth = Math.max(1, lw * .7); g.stroke(); g.strokeStyle = COL.outline; g.lineWidth = lw;
  return tw;
}
// Entry plasma: drawn before the capsule. A hot cap pressed on the heat shield, a sheath flowing round the shoulder and a wake that closes behind the
// top. The capsule flies heat shield first, so the wake runs up the sprite.
function plasma(g, x, bot, w, l, size) {
  const sh = bot - l * .2, reach = Math.min(bot - l - size * .04, size * .36);
  const wake = (wid, len, stops) => {
    const grad = g.createLinearGradient(0, bot + l * .12, 0, bot - l - len);
    stops.forEach(([p, c]) => grad.addColorStop(p, c));
    g.fillStyle = grad; g.beginPath(); g.moveTo(x - wid / 2, sh);
    g.bezierCurveTo(x - wid * .56, bot + l * .2, x + wid * .56, bot + l * .2, x + wid / 2, sh);
    g.bezierCurveTo(x + wid * .5, sh - l * .7, x + wid * .12, bot - l - len * .55, x, bot - l - len);
    g.bezierCurveTo(x - wid * .12, bot - l - len * .55, x - wid * .5, sh - l * .7, x - wid / 2, sh); g.closePath(); g.fill();
  };
  wake(w * 1.5, reach, [[0, 'rgba(255,120,60,.5)'], [.25, 'rgba(255,96,48,.34)'], [.7, 'rgba(230,70,110,.14)'], [1, 'rgba(200,60,140,0)']]);
  wake(w * 1.2, reach * .7, [[0, 'rgba(255,214,150,.9)'], [.3, 'rgba(255,150,70,.55)'], [1, 'rgba(255,110,50,0)']]);
  const cap = g.createRadialGradient(x, bot - l * .02, 0, x, bot - l * .02, w * .62);
  cap.addColorStop(0, 'rgba(255,255,245,1)'); cap.addColorStop(.45, 'rgba(255,224,150,.9)'); cap.addColorStop(1, 'rgba(255,150,70,0)');
  g.fillStyle = cap; g.beginPath(); g.ellipse(x, bot - l * .03, w * .62, l * .2, 0, 0, 2 * Math.PI); g.fill();
}
// Parachute above the capsule: a small ribbon drogue high on a long riser, or the main canopy in red and white gores.
function parachute(g, x, top, w, size, kind) {
  const main = kind === 'main', cw = main ? size * .56 : size * .2, ch = main ? size * .17 : size * .07, rim = main ? size * .25 : size * .17, crown = rim - ch;
  const join = top - (top - rim) * (main ? .2 : .12), n = main ? 8 : 4, lw = g.lineWidth;
  g.strokeStyle = 'rgba(222,228,234,.85)'; g.lineWidth = Math.max(.8, size * .0035);
  for (let i = 0; i <= n; i++) { g.beginPath(); g.moveTo(x, join); g.lineTo(x - cw / 2 + cw * i / n, rim); g.stroke(); }
  g.beginPath(); g.moveTo(x, top); g.lineTo(x, join); g.stroke();
  const dome = new Path2D();
  dome.moveTo(x - cw / 2, rim); dome.bezierCurveTo(x - cw * .5, crown + ch * .1, x - cw * .26, crown, x, crown);
  dome.bezierCurveTo(x + cw * .26, crown, x + cw * .5, crown + ch * .1, x + cw / 2, rim);
  dome.quadraticCurveTo(x, rim - ch * .16, x - cw / 2, rim); dome.closePath();
  g.fillStyle = '#f2f4f6'; g.fill(dome);
  g.save(); g.clip(dome); g.fillStyle = main ? '#c8372d' : '#e08a2e';
  for (let i = 0; i < n; i += 2) {                           // every other gore, narrowing toward the crown
    const a = x - cw / 2 + cw * i / n, b = a + cw / n;
    g.beginPath(); g.moveTo(a, rim + 2); g.quadraticCurveTo(x + (a - x) * .86, crown + ch * .4, x + (a - x) * .1, crown - 2);
    g.lineTo(x + (b - x) * .1, crown - 2); g.quadraticCurveTo(x + (b - x) * .86, crown + ch * .4, b, rim + 2); g.closePath(); g.fill();
  }
  g.restore(); g.strokeStyle = COL.outline; g.lineWidth = lw; g.stroke(dome);
}
// Service module, kind 'service': a cylinder on a flared skirt with two solar wings. Orbital module, kind 'orbital': a short domed cylinder with its
// docking collar. Both are drawn from their base upward and return the width of their top.
const PANEL = ['#16335c', '#2f62a6'];
function serviceModule(g, x, bot, w, l) {
  const top = bot - l, skirt = w * 1.1, wing = w * 1.45, wy = bot - l * .62, wh = l * .3, lw = g.lineWidth;
  for (const s of [-1, 1]) {
    const a = x + s * w / 2, b = a + s * wing;
    g.strokeStyle = '#8f99a3'; g.beginPath(); g.moveTo(a, wy + wh / 2); g.lineTo(a + s * w * .14, wy + wh / 2); g.stroke();
    const grad = g.createLinearGradient(a, 0, b, 0); grad.addColorStop(0, PANEL[0]); grad.addColorStop(1, PANEL[1]);
    g.fillStyle = grad; g.strokeStyle = COL.outline; g.beginPath(); g.rect(Math.min(a + s * w * .14, b), wy, wing - w * .14, wh); g.fill(); g.stroke();
    g.strokeStyle = 'rgba(190,215,245,.5)'; g.lineWidth = Math.max(.7, lw * .45);
    for (let i = 1; i < 4; i++) { const px = a + s * (w * .14 + (wing - w * .14) * i / 4); g.beginPath(); g.moveTo(px, wy); g.lineTo(px, wy + wh); g.stroke(); }
    g.beginPath(); g.moveTo(a + s * w * .14, wy + wh / 2); g.lineTo(b, wy + wh / 2); g.stroke(); g.lineWidth = lw; g.strokeStyle = COL.outline;
  }
  g.fillStyle = shade(g, x, skirt, HULL);
  g.beginPath(); g.moveTo(x - skirt / 2, bot); g.lineTo(x - w / 2, bot - l * .2); g.lineTo(x - w / 2, top); g.lineTo(x + w / 2, top); g.lineTo(x + w / 2, bot - l * .2); g.lineTo(x + skirt / 2, bot); g.closePath(); g.fill(); g.stroke();
  g.fillStyle = 'rgba(40,50,60,.6)'; g.fillRect(x - w / 2 + 1, top + l * .08, w - 2, Math.max(1.5, l * .05)); g.fillRect(x - w / 2 + 1, bot - l * .25, w - 2, Math.max(1.5, l * .04));
  return w;
}
function orbitalModule(g, x, bot, w, l) {
  const top = bot - l, r = w * .32, ring = w * .42;
  g.fillStyle = shade(g, x, ring, COL.dark); g.beginPath(); g.rect(x - ring / 2, top - l * .09, ring, l * .13); g.fill(); g.stroke();   // docking collar
  g.fillStyle = shade(g, x, w, HULL);
  g.beginPath(); g.moveTo(x - w / 2, bot - r * .5); g.quadraticCurveTo(x - w / 2, bot, x - w / 2 + r, bot); g.lineTo(x + w / 2 - r, bot); g.quadraticCurveTo(x + w / 2, bot, x + w / 2, bot - r * .5);
  g.lineTo(x + w / 2, top + r * .7); g.quadraticCurveTo(x + w / 2, top, x + w / 2 - r, top); g.lineTo(x - w / 2 + r, top); g.quadraticCurveTo(x - w / 2, top, x - w / 2, top + r * .7); g.closePath(); g.fill(); g.stroke();
  g.fillStyle = '#18222c'; g.beginPath(); g.arc(x + w * .12, bot - l * .55, Math.max(1.2, w * .07), 0, 2 * Math.PI); g.fill();
  g.fillStyle = 'rgba(40,50,60,.6)'; g.fillRect(x - w / 2 + 1, bot - l * .3, w - 2, Math.max(1.5, l * .04));
  return ring;
}

// Ship: barrel and blunt ogive nose (29 % of the length), tiled windward side on the left, large aft flaps and small forward flaps set on the nose.
function starship(g, x, bot, w, l) {
  const top = bot - l, nose = l * .29, sh = top + nose, L = x - w / 2, R = x + w / 2;
  for (const s of [-1, 1]) {
    const e = x + s * w / 2;
    g.fillStyle = s < 0 ? TILE : STEEL[3];
    poly(g, [[e, bot - l * .29], [e + s * w * .48, bot - l * .16], [e + s * w * .48, bot - l * .015], [e, bot - l * .015]]);                 // aft flap
    poly(g, [[x + s * w * .15, top + l * .07], [e + s * w * .2, top + l * .185], [e + s * w * .2, top + l * .25], [x + s * w * .3, top + l * .275]]);   // forward flap
  }
  const body = new Path2D();
  body.moveTo(L, bot); body.lineTo(L, sh); body.bezierCurveTo(L, sh - nose * .58, x - w * .17, top, x, top);
  body.bezierCurveTo(x + w * .17, top, R, sh - nose * .58, R, sh); body.lineTo(R, bot); body.closePath();
  g.fillStyle = shade(g, x, w, STEEL); g.fill(body);
  g.save(); g.clip(body); g.fillStyle = TILE; g.fillRect(L, top, w * .46, l); g.restore();
  g.stroke(body);
}

// Booster: plain barrel with the hot-stage ring on top, the engine section at the base, and grid fins edge-on below the ring. The V3 booster has three
// fins; in this profile the third is behind the barrel.
function superHeavy(g, x, bot, w, l) {
  const top = bot - l, L = x - w / 2, fin = top + l * .1, th = l * .026;
  g.fillStyle = DARK;
  for (const s of [-1, 1]) g.fillRect(x + s * w / 2, fin, s * w * .42, th), g.strokeRect(x + s * w / 2, fin, s * w * .42, th);
  g.fillStyle = shade(g, x, w, STEEL); g.fillRect(L, top, w, l);
  g.fillStyle = DARK; g.fillRect(L, top, w, l * .04); g.fillRect(L, bot - l * .03, w, l * .03);
  g.strokeRect(L, top, w, l);
}

export function drawVehicle(g, size, stack, state, burning) {
  const st = stack.states[state], unit = size * .72 / stack.total_m * st.zoom, x = size / 2;
  const segs = st.segs.map((k) => stack.segments[k]), h = segs.reduce((a, q) => a + q.len, 0) * unit;
  let y = size / 2 + h / 2;                               // base of the stack; the sprite centre stays on the stack's centre
  const boost = stack.width_boost ?? WIDTH_BOOST, baseW = segs[0].w * unit * boost, own = OWN_BASE.has(segs[0].kind);
  g.clearRect(0, 0, size, size); g.lineJoin = 'round';
  if (st.boosters) {
    const b = st.boosters, bw = b.w * unit * boost, bl = b.len * unit, lw = Math.max(1.4, size * .007);
    for (const side of [-1, 1]) {
      const bx = x + side * (baseW / 2 + bw * .42);
      if (burning && b.burn) flame(g, bx, y + bw * .2, bw * .62, Math.min(size * .22, size - y - bw * .3), b.burn);
      g.fillStyle = shade(g, bx, bw * .8, COL.dark); g.strokeStyle = COL.outline; g.lineWidth = lw;
      g.beginPath(); g.moveTo(bx - bw * .2, y); g.lineTo(bx - bw * .34, y + bw * .22); g.lineTo(bx + bw * .34, y + bw * .22); g.lineTo(bx + bw * .2, y); g.closePath(); g.fill(); g.stroke();
      g.fillStyle = shade(g, bx, bw, COL.body); g.beginPath(); g.rect(bx - bw / 2, y - bl, bw, bl); g.fill(); g.stroke();
      g.beginPath(); g.moveTo(bx - bw / 2, y - bl); g.quadraticCurveTo(bx - bw * .42, y - bl - bw * .7, bx, y - bl - bw * .95); g.quadraticCurveTo(bx + bw * .42, y - bl - bw * .7, bx + bw / 2, y - bl); g.closePath(); g.fill(); g.stroke();
      g.fillStyle = COL.band; g.fillRect(bx - bw / 2 + 1, y - bl * .55, bw - 2, Math.max(2, bl * .05));
    }
  }
  g.strokeStyle = COL.outline; g.lineWidth = Math.max(1.4, size * .007);
  if (segs[0].kind === 'capsule') {
    if (st.chute) parachute(g, x, y - h, baseW, size, st.chute);
    if (st.plasma) plasma(g, x, y, baseW, segs[0].len * unit, size);
  }
  if (own) { if (burning && st.burn) flame(g, x, y, baseW * .8, size * .15, st.burn); }
  else {
    if (burning && st.burn) flame(g, x, y + baseW * .24, baseW * (st.burn === 'solid' ? .62 : .42), st.burn === 'solid' ? Math.min(size * .34, size - y - baseW * .3) : size * .13, st.burn);
    g.fillStyle = shade(g, x, baseW * .8, COL.dark);   // nozzle
    g.beginPath(); g.moveTo(x - baseW * .2, y); g.lineTo(x - baseW * .36, y + baseW * .28); g.lineTo(x + baseW * .36, y + baseW * .28); g.lineTo(x + baseW * .2, y); g.closePath(); g.fill(); g.stroke();
  }
  let prevW = baseW;
  for (const seg of segs) {
    const w = seg.w * unit * boost, l = seg.len * unit, top = y - l;
    if (w < prevW) {                                       // conical step down to a narrower stage
      const step = (prevW - w) * .55;
      g.fillStyle = shade(g, x, prevW, COL.body); g.beginPath(); g.moveTo(x - prevW / 2, y); g.lineTo(x - w / 2, y - step); g.lineTo(x + w / 2, y - step); g.lineTo(x + prevW / 2, y); g.closePath(); g.fill(); g.stroke();
      y -= step;
    }
    if (seg.kind === 'capsule' || seg.kind === 'service' || seg.kind === 'orbital') {
      prevW = seg.kind === 'capsule' ? capsule(g, x, y, w, l, !!st.scorched) : seg.kind === 'service' ? serviceModule(g, x, y, w, l) : orbitalModule(g, x, y, w, l);
      y = top; continue;
    }
    if (seg.kind === 'starship') { starship(g, x, y, w, l); break; }   // the ship is the top of its stack
    if (seg.kind === 'superheavy') { superHeavy(g, x, y, w, l); y = top; prevW = w; continue; }
    if (seg.kind === 'fairing') {
      const boat = (w - prevW) * 1.1, cyl = l * .46, nose = y - boat - cyl;
      g.fillStyle = shade(g, x, w, COL.body); g.beginPath(); g.moveTo(x - prevW / 2, y); g.lineTo(x - w / 2, y - boat); g.lineTo(x - w / 2, nose);
      g.quadraticCurveTo(x - w * .46, nose - l * .34, x, nose - l * .5 + boat * .2); g.quadraticCurveTo(x + w * .46, nose - l * .34, x + w / 2, nose); g.lineTo(x + w / 2, y - boat); g.lineTo(x + prevW / 2, y); g.closePath(); g.fill(); g.stroke();
      g.strokeStyle = 'rgba(40,50,60,.55)'; g.lineWidth = Math.max(1, size * .004); g.beginPath(); g.moveTo(x, y - boat); g.lineTo(x, nose - l * .22); g.stroke();
      break;
    }
    if (seg.kind === 'payload') {
      g.fillStyle = shade(g, x, w, COL.gold); g.strokeStyle = COL.outline; g.lineWidth = Math.max(1.4, size * .007);
      g.beginPath(); g.rect(x - w / 2, y - l, w, l); g.fill(); g.stroke();
      g.fillStyle = 'rgba(30,50,90,.85)'; g.fillRect(x - w * .9, y - l * .68, w * .34, l * .36); g.fillRect(x + w * .56, y - l * .68, w * .34, l * .36);   // stowed panels
      break;
    }
    const liquid = seg.kind === 'liquid';
    g.fillStyle = shade(g, x, w, liquid ? COL.dark : COL.body); g.strokeStyle = COL.outline; g.lineWidth = Math.max(1.4, size * .007);
    g.beginPath(); g.rect(x - w / 2, top, w, l); g.fill(); g.stroke();
    if (seg.band) { g.fillStyle = COL.band; g.fillRect(x - w / 2 + 1, y - l * .52, w - 2, Math.max(2, l * .055)); g.fillStyle = 'rgba(25,32,40,.92)'; g.fillRect(x - w / 2 + 1, y - l * .13, w - 2, Math.max(2, l * .05)); }
    if (!liquid) { g.fillStyle = 'rgba(25,32,40,.85)'; g.fillRect(x - w / 2 + 1, top, w - 2, Math.max(2, unit * .55)); }   // interstage ring
    y = top; prevW = w;
  }
}
