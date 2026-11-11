#!/usr/bin/env python3
"""Reentry visibility map (SatObserver-MX look: Blue Marble, Menlo, halo labels): where the plasma trail of the
return capsule stands 10 degrees or more above the horizon, on the night side.

    ~/.venvs/astro313/bin/python tools/plot_visibility.py --id sz23-1129      # out/sz23-1129_visibility.png

The trail is the entry track between the blackout heights of the mission file (80 and 40 km). The zone is every
sea-level site that has some point of it at 10 degrees elevation or more, clipped to sites where the Sun is below
the horizon at the reference epoch (the middle of the blackout). The Sun 0 and -12 degree lines are drawn at the
same epoch when they cross the map. If the capsule comes out of the Earth's shadow on the plotted track, the first
sunlit point is marked. Export: 13.2 in long side at 300 dpi (3960 px)."""
import sys, json, csv, argparse, math
from pathlib import Path
from datetime import datetime, timedelta, timezone
import numpy as np

sys.path.insert(0, '/Users/mickey/sda/starship-ITF-14/work')
import ift14_style as st
import matplotlib.pyplot as plt
from matplotlib import patheffects as pe
from matplotlib.lines import Line2D
from matplotlib.patches import Patch, Rectangle

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'model'))
import shenzhou_reentry as R

PLASMA, CORE, COAST, CHUTE, ORBIT = '#ff7043', '#ffd9a0', st.WARN, '#c792ea', '#3987e5'
MIN_EL = 10.0
EXTENT = (66.0, 112.0, 30.0, 51.0)
CITIES = [('Ürümqi', 87.60, 43.80, .5, .35, 'left'), ('Kashgar', 75.99, 39.47, -.5, .45, 'right'), ('Aksu', 80.26, 41.17, -.45, .5, 'right'), ('Korla', 86.15, 41.77, .45, .45, 'left'),
          ('Hami', 93.51, 42.82, .5, .35, 'left'), ('Dunhuang', 94.66, 40.14, -.45, -.55, 'right'), ('Jiuquan', 98.49, 39.73, .45, -.55, 'left'), ('Hotan', 79.93, 37.12, .5, -.5, 'left'),
          ('Golmud', 94.90, 36.40, .5, .35, 'left'), ('Xining', 101.78, 36.62, .5, .35, 'left'), ('Lanzhou', 103.83, 36.06, .5, -.5, 'left'), ('Yinchuan', 106.23, 38.49, .5, .35, 'left'),
          ('Hohhot', 111.70, 40.80, -.5, .45, 'right'), ('Ulaanbaatar', 106.92, 47.92, .5, .35, 'left'), ('Almaty', 76.95, 43.24, .5, .35, 'left'), ('Bishkek', 74.59, 42.87, -.5, .45, 'right'),
          ('Tashkent', 69.24, 41.30, .5, .35, 'left'), ('Dushanbe', 68.78, 38.56, .5, -.5, 'left'), ('Kabul', 69.17, 34.53, .5, .35, 'left'), ('Islamabad', 73.05, 33.69, .5, .35, 'left'),
          ('Lhasa', 91.13, 29.65, .5, .4, 'left'), ('Chengdu', 104.07, 30.66, .5, .4, 'left'), ("Xi'an", 108.94, 34.34, .5, .35, 'left'), ('Yining', 81.32, 43.92, .5, .35, 'left'),
          ('Altay', 88.13, 47.85, .5, .35, 'left'), ('Ruoqiang', 88.17, 39.02, .5, -.5, 'left'), ('Ejin Banner', 101.07, 41.95, .5, .5, 'left'), ('Karamay', 84.89, 45.58, .5, .35, 'left')]


def sun_ecef(times):
    """Geometric Earth-to-Sun vectors (ECEF km, DE440s) at a list of UTC datetimes."""
    from skyfield.api import Loader, load_file
    from skyfield.framelib import itrs
    directory = Path.home() / 'JPLDE'
    ts = Loader(str(directory)).timescale(builtin=True)
    eph = load_file(str(directory / 'de440s.bsp'))
    try:
        return (eph['sun'] - eph['earth']).at(ts.from_datetimes(times)).frame_xyz(itrs).km.T
    finally:
        eph.close()


def sunlit(p, s):
    """True when the segment from p to the Sun centre clears the WGS-84 ellipsoid (the page's sunlightClearance)."""
    axes = np.array([R.A_E, R.A_E, R.A_E * math.sqrt(1 - R.E2)])
    r, d = p / axes, (s - p) / axes
    t = np.clip(-(r @ d) / (d @ d), 0, 1)
    return float(np.sum((r + t * d) ** 2)) - 1 > 0


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--id', default='sz23-1129')
    a = ap.parse_args()
    sol = json.loads((ROOT / 'out' / f'{a.id}_solution.json').read_text())
    rows = list(csv.DictReader(open(ROOT / 'out' / f'{a.id}_trajectory.csv')))
    col = lambda k: np.array([float(r[k]) for r in rows])
    met, lon, lat, h = col('met_s'), col('lon_deg'), col('lat_deg'), col('alt_km')
    ev = {e['key']: e for e in sol['events']}
    d, inp = sol['diag'], sol['inputs']
    name, forecast = inp['name'], inp.get('kind') == 'prediction'
    site = (d['target'][1], d['target'][0])
    t_ign = R.utc(sol['parameters']['t_ign_utc'])
    at = lambda key: (float(np.interp(ev[key]['met'], met, lon)), float(np.interp(ev[key]['met'], met, lat)), ev[key]['utc'][11:19])
    b0, b1 = ev['blackout_start']['met'], ev['blackout_end']['met']
    t_ref = t_ign + timedelta(seconds=(b0 + b1) / 2)
    ref64 = np.datetime64(t_ref.replace(tzinfo=None).isoformat())

    # ---- 10 degree zone of the plasma trail on a 0.1 degree grid
    x0, x1, y0, y1 = EXTENT
    glon, glat = np.meshgrid(np.arange(x0, x1 + 1e-9, 0.1), np.arange(y0, y1 + 1e-9, 0.1))
    la, lo = np.radians(glat), np.radians(glon)
    N = R.A_E / np.sqrt(1 - R.E2 * np.sin(la) ** 2)
    obs = np.stack([N * np.cos(la) * np.cos(lo), N * np.cos(la) * np.sin(lo), N * (1 - R.E2) * np.sin(la)])
    up = np.stack([np.cos(la) * np.cos(lo), np.cos(la) * np.sin(lo), np.sin(la)])
    best = np.full(glon.shape, -90.0)
    for t in np.arange(b0, b1 + 1e-6, 2.0):
        p = R.ecef(np.interp(t, met, lat), np.interp(t, met, lon), np.interp(t, met, h))
        dv = p[:, None, None] - obs
        best = np.maximum(best, np.degrees(np.arcsin(np.sum(dv * up, axis=0) / np.linalg.norm(dv, axis=0))))
    alt_sun = st.sun_alt(ref64, glon, glat)
    field = np.minimum(best - MIN_EL, -alt_sun)             # positive inside: 10 degrees or more, and the Sun down
    area = float(np.sum((field > 0) * np.cos(la)) * (0.1 * 111.19) ** 2)

    # ---- sunlight on the capsule along the plotted descent
    k = np.arange(0, len(met), 5)
    suns = sun_ecef([t_ign + timedelta(seconds=float(met[i])) for i in k])
    lit = np.array([sunlit(R.ecef(lat[i], lon[i], h[i]), s) for i, s in zip(k, suns)])
    pickup = next((int(k[j]) for j in range(1, len(k)) if lit[j] and not lit[j - 1] and met[k[j]] > ev['sm_separation']['met']), None)

    # ---- figure
    LONG = 13.2
    top_in, bot_in, side = 0.42, 0.62, 0.012
    W = LONG
    ax_w = W * (1 - 2 * side)
    ax_h = ax_w * (y1 - y0) / (x1 - x0) / math.cos(math.radians(40)) * 0.86
    H = ax_h + top_in + bot_in
    fig = plt.figure(figsize=(W, H), facecolor=st.BG)
    ax = fig.add_axes([side, bot_in / H, ax_w / W, ax_h / H])
    ax.set_facecolor('#05070a')
    for s in ax.spines.values():
        s.set_edgecolor('#2a323c')
    title = f'{name} Reentry visibility'
    fig.text(side, 1 - 0.5 * top_in / H, title, color='#cfd6dd', fontsize=13, fontweight='bold', va='center', ha='left')
    fig.text(side + (0.112 * len(title) + 0.25) / W, 1 - 0.5 * top_in / H, (t_ign + timedelta(seconds=b0)).strftime('%Y-%m-%d %H:%M UTC'), color=st.FG, fontsize=12, va='center', ha='left')
    st.draw_base(ax, EXTENT, ref64, grat=10, night=False, sun=False, label_step=10)
    shade = np.zeros(alt_sun.shape + (4,))
    shade[..., 2] = 10 / 255
    shade[..., 3] = np.where(alt_sun < -12, 0.48, np.where(alt_sun < 0, 0.32, 0.0))
    ax.imshow(shade, extent=EXTENT, aspect='auto', origin='lower', zorder=1, interpolation='bilinear')
    ax.set_xlim(x0, x1); ax.set_ylim(y0, y1)
    solar = []
    for level, colour, lw, lab in ((0, st.SUN, 1.5, 'Sun 0°'), (-12, st.ACCENT, 1.3, 'Sun −12°')):
        if alt_sun.min() < level < alt_sun.max():
            ax.contour(glon, glat, alt_sun, levels=[level], colors=[colour], linewidths=lw, linestyles='solid', zorder=3)
            solar.append(Line2D([], [], color=colour, lw=lw, label=lab))
    ax.contourf(glon, glat, field, levels=[0.0, 1e3], colors=[(1, 1, 1, 0.13)], zorder=2)
    ax.contour(glon, glat, np.where(alt_sun < -0.05, best - MIN_EL, np.nan), levels=[0.0], colors=[(1, 1, 1, 0.9)], linewidths=1.3, linestyles=[(0, (5, 3))], zorder=3)

    halo = lambda lw: [pe.withStroke(linewidth=lw + 1.8, foreground=(0, 0, 0, 0.55))]
    def tracks(axis, lw=1.0, orbit=False):
        if orbit:
            page = json.loads((ROOT / 'docs' / 'data' / f'{a.id}.json').read_text())['tracks']['orbit']
            om = page['met0'] + np.arange(len(page['lon'])) * page['dt']
            keep = om >= -2700
            st.plot_track(axis, np.array(page['lon'])[keep], np.array(page['lat'])[keep], color=ORBIT, lw=1.2 * lw, zorder=4)
        seg = lambda k0, k1: (met >= ev[k0]['met']) & (met <= ev[k1]['met'])
        s = seg('ignition', 'sm_separation'); st.plot_track(axis, lon[s], lat[s], color=COAST, lw=1.6 * lw, zorder=5, path_effects=halo(1.6 * lw))
        s = seg('sm_separation', 'chute'); st.plot_track(axis, lon[s], lat[s], color=PLASMA, lw=1.8 * lw, zorder=5, path_effects=halo(1.8 * lw))
        s = seg('blackout_start', 'blackout_end'); st.plot_track(axis, lon[s], lat[s], color=PLASMA, lw=9 * lw, alpha=0.3, zorder=5, solid_capstyle='round'); st.plot_track(axis, lon[s], lat[s], color=CORE, lw=1.4 * lw, zorder=6)
        s = met <= ev['burn_end']['met']; st.plot_track(axis, lon[s], lat[s], color=st.SUN, lw=4 * lw, zorder=6)
    tracks(ax)

    dot = lambda x, y, c: ax.plot(x, y, 'o', ms=4.2, mfc=c, mec=(8 / 255, 10 / 255, 14 / 255, 0.9), mew=0.9, zorder=7)
    x, y, u = at('entry_interface'); dot(x, y, PLASMA); st.label(ax, x, y - 0.75, f'Entry 100 km · {u[:5]}', size=8.5, ha='center', va='top')
    x, y, u = at('blackout_start'); dot(x, y, CORE); st.label(ax, x, y + 0.75, f'80 km · {u}', size=8.5, ha='center', va='bottom')
    x, y, u = at('peak_heating'); dot(x, y, '#ffffff'); st.label(ax, x, y - 0.75, f'Peak heating · {u}', size=8.5, ha='center', va='top')
    x, y, u = at('blackout_end'); dot(x, y, CORE); st.label(ax, x - 0.2, y + 0.75, f'40 km · {u}', size=8.5, ha='center', va='bottom')
    if pickup is not None and x0 < lon[pickup] < x1:
        ax.plot(lon[pickup], lat[pickup], 's', ms=5.5, mfc=st.OK, mec=(0, 0, 0, 0.8), mew=0.7, zorder=8)
    st.star(ax, *site, st.SUN, ms=15)
    st.label(ax, site[0] + 0.75, site[1] + 0.1, f"Dongfeng · {d['landing_utc'][11:19]}", size=9, color=st.SUN)
    for nm, cx, cy, dx, dy, ha in CITIES:
        if not (x0 + 0.5 < cx < x1 - 0.5 and y0 + 0.5 < cy < y1 - 0.5):
            continue
        ax.plot(cx, cy, 'o', ms=3.2, mfc='#c9ccd1', mec=(8 / 255, 10 / 255, 14 / 255, 0.9), mew=0.8, zorder=7)
        st.label(ax, cx + dx, cy + dy, nm, size=7.5, color='#e3e7eb', ha=ha)

    # ---- inset, upper left: the deorbit burn and the coast to the entry
    iw = 0.285
    ih = iw * ax_w / ax_h * (110 / 175) * 0.92
    ins = ax.inset_axes([0.008, 1 - 0.012 - ih, iw, ih])
    ins.set_facecolor('#05070a')
    iext = (-50, 125, -50, 60)
    st.draw_base(ins, iext, ref64, grat=30, night=True, sun=False, label_step=1000)
    for text in list(ins.texts):
        text.remove()
    for sp in ins.spines.values():
        sp.set_edgecolor('#cfd6dd'); sp.set_linewidth(0.8)
    tracks(ins, lw=0.6, orbit=True)
    ins.add_patch(Rectangle((x0, y0), x1 - x0, y1 - y0, fill=False, edgecolor=st.FG, lw=0.8, ls=(0, (3, 2)), zorder=8))
    bx, by, bu = at('ignition')
    ins.plot(bx, by, 's', ms=4.5, mfc=st.SUN, mec=(0, 0, 0, 0.8), mew=0.7, zorder=8)
    st.label(ins, bx + 4, by - 1, f'Burn {bu[:5]} · {d["dv_ms"]:.0f} m/s', size=7.5, va='top')
    ins.plot(*site, '*', ms=9, mfc=st.SUN, mec=(0, 0, 0, 0.8), mew=0.6, zorder=8)

    handles = [Line2D([], [], color=ORBIT, lw=1.3, label='Orbit'), Line2D([], [], color=st.SUN, lw=4, label='Burn'), Line2D([], [], color=COAST, lw=1.8, label='Coast'),
               Line2D([], [], color=PLASMA, lw=2, label='Entry'), Line2D([], [], color=PLASMA, lw=7, alpha=0.45, label='Plasma trail'),
               Patch(facecolor=(1, 1, 1, 0.14), edgecolor='white', ls=(0, (5, 3)), label='10° zone'), *solar,
               Line2D([], [], marker='*', ls='', ms=10, mfc=st.SUN, mec='k', label='Landing')]
    if pickup is not None:
        handles.insert(-1, Line2D([], [], marker='s', ls='', ms=6, mfc=st.OK, mec='k', label='Sunlight pickup'))
    fig.legend(handles=handles, loc='lower left', bbox_to_anchor=(side, 0.06 / H), ncol=math.ceil(len(handles) / 2), frameon=False, fontsize=8.0, labelcolor=st.FG,
               handlelength=2.0, columnspacing=1.2, handletextpad=0.5, borderaxespad=0.0)
    fig.text(1 - side, 0.10 / H, 'Illustration: Mickey · base map NASA Blue Marble', color=st.FGDIM, fontsize=7.5, ha='right', va='bottom')
    out = ROOT / 'out' / f'{a.id}_visibility.png'
    fig.savefig(out, dpi=300, facecolor=st.BG)
    meta = dict(mission=a.id, kind='forecast' if forecast else 'reconstruction', reference_epoch_utc=R.iso(t_ref), min_elevation_deg=MIN_EL,
                plasma_utc=[ev['blackout_start']['utc'], ev['blackout_end']['utc']], zone_area_km2=round(area), extent=list(EXTENT),
                sun_at_site_deg=round(float(st.sun_alt(ref64, site[0], site[1])), 1),
                sunlight_pickup=dict(utc=R.iso(t_ign + timedelta(seconds=float(met[pickup]))), lon=round(float(lon[pickup]), 2), lat=round(float(lat[pickup]), 2), alt_km=round(float(h[pickup]), 1)) if pickup is not None else None,
                notes=['Zone: sea-level sites with some point of the 80-40 km plasma trail at 10 degrees elevation or more and the Sun below the horizon at the reference epoch.',
                       'The trail is self-luminous; its brightness is not modeled. No terrain, weather or extinction.'])
    (ROOT / 'out' / f'{a.id}_visibility.json').write_text(json.dumps(meta, indent=1))
    print(f"wrote {out.relative_to(ROOT)}  {round(W * 300)}x{round(H * 300)} px  zone {area / 1e6:.2f} M km2  Sun at site {meta['sun_at_site_deg']} deg  pickup {meta['sunlight_pickup']}")


if __name__ == '__main__':
    main()
