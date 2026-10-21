#!/usr/bin/env python3
"""Entry profile figure from the model trajectory: altitude, speed, Mach, load and heating against time.
    ~/.venvs/astro313/bin/python tools/plot_profile.py [--id sz20]"""
import sys, json, csv, argparse
from pathlib import Path
import numpy as np, matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib import font_manager

ROOT = Path(__file__).resolve().parents[1]
font_manager.fontManager.addfont('/System/Library/Fonts/Menlo.ttc')
plt.rcParams['font.family'] = 'Menlo'
BG, PANEL, FG, DIM, GRID = '#101418', '#171c22', '#e8eaed', '#9aa4ae', '#2a323c'
ACCENT, SUN, WARN, DANGER, OK, PLASMA, DESCENT = '#4fc3f7', '#ffd54f', '#ffb84f', '#ff5252', '#7ad97a', '#ff7043', '#c792ea'

ap = argparse.ArgumentParser(); ap.add_argument('--id', default='sz20'); a = ap.parse_args()
sol = json.loads((ROOT / 'out' / f'{a.id}_solution.json').read_text())
rows = list(csv.DictReader(open(ROOT / 'out' / f'{a.id}_trajectory.csv')))
col = lambda k: np.array([float(r[k]) for r in rows])
t = col('met_s') / 60; h = col('alt_km'); v = col('v_rel_kms'); M = col('mach'); g = col('g_load'); q = col('heating_Wcm2'); rng = col('range_to_site_km')
ev = {e['key']: e for e in sol['events']}; d = sol['diag']
name = sol['inputs']['name']

fig = plt.figure(figsize=(13.2, 8.4), facecolor=BG)
fig.text(0.012, 0.975, f'{name} reentry', color='#cfd6dd', fontsize=13, fontweight='bold', va='center')
fig.text(0.19, 0.975, f"deorbit burn {d['t_ign_utc'][:10]} {d['t_ign_utc'][11:19]} UTC  ·  touchdown {d['landing_utc'][11:19]} UTC  ·  3-DOF reconstruction", color=DIM, fontsize=11, va='center')
axes = [fig.add_axes([0.07, 0.56, 0.86, 0.38]), fig.add_axes([0.07, 0.09, 0.86, 0.40])]
for ax in axes:
    ax.set_facecolor(PANEL)
    for s in ax.spines.values(): s.set_edgecolor(GRID)
    ax.tick_params(colors=DIM, labelsize=9); ax.grid(color=GRID, lw=0.6, alpha=0.8)
    ax.set_xlim(-2, t[-1] + 1)
ax = axes[0]
phases = [(0, ev['burn_end']['met'] / 60, SUN, 'burn'), (ev['sm_separation']['met'] / 60, ev['entry_interface']['met'] / 60, WARN, None),
          (ev['blackout_start']['met'] / 60, ev['blackout_end']['met'] / 60, PLASMA, 'blackout'), (ev['chute']['met'] / 60, t[-1], DESCENT, 'parachutes')]
for x0, x1, c, lab in phases:
    ax.axvspan(x0, x1, color=c, alpha=0.10, lw=0)
    if lab: ax.text((x0 + x1) / 2, 14, lab, color=c, fontsize=9, ha='center', va='bottom')
ax.plot(t, h, color=ACCENT, lw=2.0, label='altitude')
ax.set_ylabel('altitude  km (WGS-84)', color=FG, fontsize=10); ax.set_ylim(0, 400)
ax2 = ax.twinx(); ax2.plot(t, v, color=SUN, lw=1.6, label='air-relative speed'); ax2.set_ylim(0, 9.0)
ax2.set_ylabel('speed  km/s', color=SUN, fontsize=10); ax2.tick_params(colors=DIM, labelsize=9)
for s in ax2.spines.values(): s.set_edgecolor(GRID)
marks = [('ignition', 'burn ignition', (8, -4), 'left', 'top'), ('sm_separation', 'SM sep\n145 km', (6, 12), 'left', 'bottom'), ('entry_interface', 'entry\n100 km', (6, 12), 'left', 'bottom'),
         ('peak_heating', 'peak\nheating', (6, 10), 'left', 'bottom'), ('max_g', f"max {d['max_g']:.1f} g", (8, 8), 'left', 'bottom'), ('chute', 'chutes\n10 km', (8, 6), 'left', 'bottom'), ('landing', 'touchdown', (-8, 8), 'right', 'bottom')]
for key, lab, off, ha, va in marks:
    e = ev[key]; i = int(np.argmin(np.abs(t - e['met'] / 60)))
    ax.plot(t[i], h[i], 's', ms=5, mfc=FG, mec=BG, zorder=5)
    ax.annotate(lab, (t[i], h[i]), xytext=off, textcoords='offset points', color=FG, fontsize=8.5, ha=ha, va=va)
ax.text(0.99, 0.96, f"Δv {d['dv_ms']:.0f} m/s in {d['burn_s']:.0f} s  ·  perigee {d['deorbit_perigee_km']:.0f} km  ·  entry γ {d['ei_fpa_inertial_deg']:.2f}° at 100 km  ·  bank ±{abs(d['bank_deg']):.0f}° (L/D 0.30)",
        transform=ax.transAxes, color=DIM, fontsize=9, ha='right', va='top')
lines = ax.get_legend_handles_labels(); lines2 = ax2.get_legend_handles_labels()
ax.legend(lines[0] + lines2[0], lines[1] + lines2[1], loc='lower left', fontsize=9, facecolor=BG, edgecolor=GRID, labelcolor=FG)

ax = axes[1]
sel = (t > ev['entry_interface']['met'] / 60 - 1) & (t < ev['chute']['met'] / 60 + 1)
ax.plot(t[sel], g[sel], color=DANGER, lw=1.8, label='deceleration  g')
ax.plot(t[sel], q[sel] / 10, color=WARN, lw=1.6, label='stagnation heating  ×10 W/cm² (Sutton–Graves, R 2.5 m)')
ax.plot(t[sel], M[sel] / 10, color=OK, lw=1.4, label='Mach  ×10')
ax.set_ylim(0, 8); ax.set_ylabel('g  ·  W/cm²/10  ·  Mach/10', color=FG, fontsize=10)
ax.set_xlabel('minutes from deorbit burn ignition', color=FG, fontsize=10)
for key, c in [('blackout_start', PLASMA), ('blackout_end', PLASMA), ('entry_interface', ACCENT), ('chute', DESCENT)]:
    ax.axvline(ev[key]['met'] / 60, color=c, lw=1, ls=(0, (3, 3)), alpha=0.9)
ax.text(0.02, 0.60, f"blackout 80 → 40 km between the orange dashed lines · {d['blackout_s'] / 60:.1f} min", transform=ax.transAxes, color=PLASMA, fontsize=9, va='top')
ax.text(0.99, 0.96, f"peak heating {d['peak_heating_Wcm2']:.0f} W/cm² at {d['peak_heating_alt_km']:.0f} km  ·  max {d['max_g']:.1f} g at {d['max_g_alt_km']:.0f} km  ·  {d['v_at_chute_ms']:.0f} m/s at parachute deploy  ·  {d['v_touchdown_ms']:.1f} m/s under the main chute",
        transform=ax.transAxes, color=DIM, fontsize=9, ha='right', va='top')
ax.legend(loc='upper left', bbox_to_anchor=(0, 0.9), fontsize=9, facecolor=BG, edgecolor=GRID, labelcolor=FG)
fig.text(0.988, 0.012, 'Illustration: Mickey', color=DIM, fontsize=7.5, ha='right', va='bottom')
out = ROOT / 'out' / f'{a.id}_profile.png'
fig.savefig(out, dpi=200, facecolor=BG)
print('wrote', out)
