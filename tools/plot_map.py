#!/usr/bin/env python3
"""Ground-track map of the modeled return (SatObserver-MX look: Blue Marble, Menlo, halo labels): the entry corridor
from the service-module separation to Dongfeng, with a global inset for the deorbit burn and coast.
    ~/.venvs/astro313/bin/python tools/plot_map.py [--id sz20]
Export: 13.2 in long side at 300 dpi (3960 px)."""
import sys, json, csv, argparse
from pathlib import Path
import numpy as np
sys.path.insert(0, '/Users/mickey/sda/starship-ITF-14/work')
from ift14_style import *                      # new_figure, draw_base, plot_track, label, sq, star, hud, HALO, colors
from matplotlib.lines import Line2D
from matplotlib.patches import Rectangle

ROOT = Path(__file__).resolve().parents[1]
ap = argparse.ArgumentParser(); ap.add_argument('--id', default='sz20'); a = ap.parse_args()
sol = json.loads((ROOT / 'out' / f'{a.id}_solution.json').read_text())
rows = list(csv.DictReader(open(ROOT / 'out' / f'{a.id}_trajectory.csv')))
col = lambda k: np.array([float(r[k]) for r in rows])
met, lon, lat, h = col('met_s'), col('lon_deg'), col('lat_deg'), col('alt_km')
ev = {e['key']: e for e in sol['events']}; d = sol['diag']; inp = sol['inputs']
name = inp['name']; site = (inp['reported']['landing_lon'], inp['reported']['landing_lat'])
t_ei = np.datetime64(ev['entry_interface']['utc'].replace('Z', ''))
PLASMA = '#ff7043'
page = json.loads((ROOT / 'docs' / 'data' / f'{a.id}.json').read_text())
orb = page['tracks']['orbit']; om = np.array(orb['met0']) + np.arange(len(orb['lon'])) * orb['dt']
seg = lambda k0, k1: (met >= ev[k0]['met']) & (met <= ev[k1]['met'])
def at(key):
    i = int(np.argmin(np.abs(met - ev[key]['met']))); return lon[i], lat[i], ev[key]['utc'][11:19]

def tracks(ax, lw=1.0):
    keep = om >= -2400
    plot_track(ax, np.array(orb['lon'])[keep], np.array(orb['lat'])[keep], color=ACCENT, lw=1.2 * lw, alpha=0.8, zorder=5)
    s = seg('ignition', 'sm_separation'); plot_track(ax, lon[s], lat[s], color=WARN, lw=1.8 * lw, zorder=5)
    s = seg('sm_separation', 'chute'); plot_track(ax, lon[s], lat[s], color=PLASMA, lw=2.0 * lw, zorder=5)
    s = seg('blackout_start', 'blackout_end'); plot_track(ax, lon[s], lat[s], color=PLASMA, lw=9 * lw, alpha=0.25, zorder=5); plot_track(ax, lon[s], lat[s], color='#ffd9a0', lw=1.2 * lw, zorder=6)
    s = (met >= ev['burn_end']['met'] - 170) & (met <= ev['burn_end']['met']); plot_track(ax, lon[s], lat[s], color=SUN, lw=4 * lw, zorder=6)

# ---- main map: entry corridor
ext = (52, 116, 21, 52)
W = 13.2; H = W * (ext[3] - ext[2]) / (ext[1] - ext[0]) * 1.07
fig, ax = new_figure(W, H, f'{name} reentry', f"—  deorbit burn {d['t_ign_utc'][:10]} {d['t_ign_utc'][11:19]} UTC  ·  touchdown {d['landing_utc'][11:19]} UTC  ·  3-DOF reconstruction, not official ephemeris", '')
glon, glat, alt = draw_base(ax, ext, t_ei, grat=10, night=True, sun=False)
ax.contour(glon, glat, alt, levels=[0], colors=[SUN], linewidths=1.4, zorder=4)
ax.contour(glon, glat, alt, levels=[-12], colors=[ACCENT], linewidths=1.2, zorder=4)
tracks(ax)
x, y, u = at('sm_separation'); sq(ax, x, y, WARN, f'service module separation\n{u}Z · 145 km', dx=0.4, dy=-0.9, va='top')
x, y, u = at('entry_interface'); sq(ax, x, y, PLASMA, f'entry 100 km  {u}Z\nγ {d["ei_fpa_inertial_deg"]:.2f}° · {d["ei_v_inertial_kms"]:.2f} km/s', dx=0.5, dy=-1.6, va='top', hollow=True)
x, y, u = at('blackout_start'); sq(ax, x, y, PLASMA, f'blackout begins 80 km\n{u}Z', dx=-0.4, dy=1.0, ha='right', va='bottom', size=6)
x, y, u = at('peak_heating'); ax.plot(x, y, 'o', ms=4, mfc='#ffd9a0', mec=(8/255, 10/255, 14/255, 0.9), zorder=7)
label(ax, x + 0.2, y - 1.0, f'peak heating {d["peak_heating_Wcm2"]:.0f} W/cm² · {u}Z · {h[int(np.argmin(np.abs(met - ev["peak_heating"]["met"])))]:.0f} km', ha='right', va='top', size=8.5)
x, y, u = at('blackout_end'); sq(ax, x, y, PLASMA, f'blackout ends 40 km\n{u}Z · max {d["max_g"]:.1f} g', dx=0.3, dy=1.3, ha='left', va='bottom', size=6)
x, y, u = at('chute'); sq(ax, x, y, '#c792ea', None, size=5)
star(ax, *site, SUN, ms=16)
label(ax, site[0] + 1.0, site[1] - 0.9, f'Dongfeng landing site\ntouchdown {d["landing_utc"][11:19]}Z (reported 01:34Z)\n{site[1]:.3f}°N {site[0]:.3f}°E', va='top', size=9)
for nm, cx, cy, dx, dy, ha in [('Ürümqi', 87.60, 43.80, .6, .3, 'left'), ('Lanzhou', 103.83, 36.06, .6, .3, 'left'), ('Jiuquan', 98.49, 39.73, -.6, -.9, 'right'), ('Kashgar', 75.99, 39.47, .6, -.9, 'left'),
                   ('Tashkent', 69.24, 41.30, -.6, .3, 'right'), ('Bishkek', 74.59, 42.87, .6, .3, 'left'), ('Almaty', 76.95, 43.24, .6, .3, 'left'), ('Dushanbe', 68.78, 38.56, -.6, -.3, 'right'),
                   ('Kabul', 69.17, 34.53, .6, .3, 'left'), ('Islamabad', 73.05, 33.69, .6, .3, 'left'), ('New Delhi', 77.20, 28.60, .6, .3, 'left'), ('Tehran', 51.39, 35.69, .6, .3, 'left'),
                   ('Lhasa', 91.13, 29.65, .6, .3, 'left'), ('Chengdu', 104.07, 30.66, .6, .3, 'left'), ('Hohhot', 111.70, 40.80, -.6, .3, 'right'), ("Xi'an", 108.94, 34.34, .6, .3, 'left'),
                   ('Korla', 86.15, 41.77, .5, -.9, 'left'), ('Hami', 93.51, 42.82, -.5, .3, 'right'), ('Dunhuang', 94.66, 40.14, .5, -.9, 'left'), ('Xining', 101.78, 36.62, .6, .3, 'left'),
                   ('Golmud', 94.90, 36.40, .6, .3, 'left'), ('Hotan', 79.93, 37.12, .6, .4, 'left'), ('Ejin Banner', 101.07, 41.95, .7, .3, 'left'), ('Ulaanbaatar', 106.92, 47.92, .6, .3, 'left'),
                   ('Kathmandu', 85.30, 27.70, .6, .3, 'left'), ('Mashhad', 59.61, 36.30, .6, .3, 'left'), ('Ashgabat', 58.38, 37.95, .6, .3, 'left'), ('Baku', 49.87, 40.41, .6, .3, 'left')]:
    if not (ext[0] < cx < ext[1] and ext[2] < cy < ext[3]): continue
    ax.plot(cx, cy, 'o', ms=3.4, mfc='#c9ccd1', mec=(8/255, 10/255, 14/255, 0.9), mew=0.8, zorder=7)
    label(ax, cx + dx, cy + dy, nm, size=8, color='#e3e7eb', ha=ha)
hud(ax, [(f'{name}  ·  {inp["date"]}', FG, True),
         (f'burn {d["t_ign_utc"][11:16]}Z  Δv {d["dv_ms"]:.0f} m/s  perigee {d["deorbit_perigee_km"]:.0f} km', FG, False),
         (f'entry {ev["entry_interface"]["utc"][11:16]}Z  γ {d["ei_fpa_inertial_deg"]:.2f}°  bank ±{abs(d["bank_deg"]):.0f}°', FG, False),
         (f'max {d["max_g"]:.1f} g  ·  {d["peak_heating_Wcm2"]:.0f} W/cm²  ·  blackout {d["blackout_s"]/60:.1f} min', FG, False),
         (f'touchdown {d["landing_utc"][11:16]}Z  (reported 01:34Z)', SUN, False)], x0=0.012, y0=0.845, width=0.335, fontsize=10)
hand = [Line2D([], [], color=ACCENT, lw=1.2), Line2D([], [], color=WARN, lw=1.8), Line2D([], [], color=SUN, lw=4), Line2D([], [], color=PLASMA, lw=2),
        Line2D([], [], color=PLASMA, lw=7, alpha=0.4), Line2D([], [], color=SUN, lw=1.4), Line2D([], [], color=ACCENT, lw=1.2), Line2D([], [], marker='*', color=SUN, ls='none', ms=10)]
labs = ['orbit', 'deorbit coast', 'burn', 'capsule entry', 'plasma 80–40 km', 'Sun 0°', 'Sun −12°', 'landing']
leg = ax.legend(hand, labs, loc='lower right', ncol=4, fontsize=8.5, facecolor=(0.04, 0.05, 0.07, 0.82), edgecolor='#2a323c', labelcolor=FG, borderpad=0.6, handlelength=2.2)
leg.set_zorder(11)
ax.text(0.5, 0.985, f'terminators at the entry interface, {ev["entry_interface"]["utc"][11:16]} UTC', transform=ax.transAxes, color=FGDIM, fontsize=8.5, ha='center', va='top', path_effects=[HALO], zorder=11)

# ---- inset: deorbit burn and coast, global context
ins = fig.add_axes([0.016, 0.045, 0.30, 0.345]); ins.set_facecolor('#05070a')
for s_ in ins.spines.values(): s_.set_edgecolor('#2a323c')
draw_base(ins, (-45, 130, -50, 62), t_ei, grat=30, night=True, sun=False, label_step=60)
tracks(ins, lw=0.7)
ins.add_patch(Rectangle((ext[0], ext[2]), ext[1] - ext[0], ext[3] - ext[2], fill=False, edgecolor=FG, lw=0.9, ls=(0, (3, 2)), zorder=8))
x, y, u = at('ignition'); sq(ins, x, y, SUN, f'deorbit burn {u}Z\n{d["dv_ms"]:.0f} m/s · {d["burn_s"]:.0f} s', dx=3, dy=-2, va='top', size=6)
ins.text(0.02, 0.97, 'deorbit burn over the South Atlantic · 27 min coast', transform=ins.transAxes, color=FG, fontsize=8, va='top', path_effects=[HALO], zorder=9)
star(ins, *site, SUN, ms=8)
fig.text(0.988, 0.008, 'Illustration: Mickey · base map NASA Blue Marble', color=FG, fontsize=7.5, ha='right', va='bottom')
out = ROOT / 'out' / f'{a.id}_map.png'
fig.savefig(out, dpi=300, facecolor=BG)
print('wrote', out)
