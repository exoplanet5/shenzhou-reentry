"""Atmosphere models for the Shenzhou entry simulation.

Two models, same interface  atmo(h_km) -> (density kg/m^3, temperature K, speed of sound m/s):

  us76  US Standard Atmosphere 1976 (model/us76.py, from the Starship IFT-14 reconstruction).
  msis  NRLMSIS 2.1 (pymsis) evaluated once on a 0-500 km column above the landing site at the entry epoch and
        cached as JSON, so re-runs need neither pymsis nor its space-weather download. January at 41 N is a
        cold, low-density winter mesosphere: MSIS gives 15-30 % less density than US76 between 60 and 140 km.

Fixed solar/geomagnetic indices (F10.7 = 150 sfu, Ap = 10) stand in for the daily values; below 100 km MSIS
density is almost insensitive to them, and above 100 km the capsule is still in near-vacuum coast."""
import json
import numpy as np
from pathlib import Path
from us76 import atmo as us76_atmo

HERE = Path(__file__).resolve().parent
GAMMA_R = 1.4 * 287.053
F107, AP = 150.0, 10.0


def _msis_table(lat, lon, iso_utc, h_grid):
    from pymsis import msis
    t = np.array([np.datetime64(iso_utc.replace('Z', ''))])
    out = msis.calculate(t, [lon], [lat], h_grid, f107s=[F107], f107as=[F107], aps=[[AP] * 7], version=2.1)
    rho = out[0, 0, 0, :, 0]
    T = out[0, 0, 0, :, -1]
    if not np.all(np.isfinite(rho)) or not np.all(np.isfinite(T)):
        raise RuntimeError('MSIS returned non-finite values')
    return rho, T


class Atmosphere:
    """kind = 'us76' or 'msis'. For 'msis', site = (lat, lon), epoch = ISO UTC string, cache = JSON path."""

    def __init__(self, kind='msis', site=None, epoch=None, cache=None):
        self.kind = kind
        if kind == 'us76':
            self.describe = 'US Standard Atmosphere 1976'
            return
        if kind != 'msis':
            raise ValueError(kind)
        cache = Path(cache) if cache else HERE / 'atmo_msis_cache.json'
        key = dict(lat=round(site[0], 3), lon=round(site[1], 3), epoch=epoch, f107=F107, ap=AP, version='2.1')
        data = None
        if cache.exists():
            data = json.loads(cache.read_text())
            if data.get('key') != key:
                data = None
        if data is None:
            h = np.r_[np.arange(0.0, 150.0, 0.5), np.arange(150.0, 500.1, 5.0)]
            rho, T = _msis_table(site[0], site[1], epoch, h)
            data = dict(key=key, h_km=h.tolist(), rho=rho.tolist(), T=T.tolist())
            cache.write_text(json.dumps(data))
        self._h = np.array(data['h_km'])
        self._lnrho = np.log(np.array(data['rho']))
        self._T = np.array(data['T'])
        self.describe = (f"NRLMSIS 2.1 column at {key['lat']} N {key['lon']} E, {epoch}, "
                         f"F10.7 {F107:.0f} sfu, Ap {AP:.0f} (fixed)")

    def __call__(self, h_km):
        if self.kind == 'us76':
            return us76_atmo(h_km)
        h = min(max(h_km, 0.0), 500.0)
        rho = float(np.exp(np.interp(h, self._h, self._lnrho)))
        T = float(np.interp(h, self._h, self._T))
        return rho, T, float(np.sqrt(GAMMA_R * min(T, 400.0)))


if __name__ == '__main__':
    a = Atmosphere('msis', site=(41.65, 100.75), epoch='2026-01-19T01:15:00Z')
    b = Atmosphere('us76')
    print(a.describe)
    for h in [0, 10, 20, 40, 60, 70, 80, 90, 100, 120, 145, 200, 390]:
        ra, Ta, ca = a(h)
        rb, Tb, cb = b(h)
        print(f'{h:5.0f} km  msis {ra:.4e} ({Ta:6.1f} K)   us76 {rb:.4e} ({Tb:6.1f} K)   ratio {ra / rb:.3f}')
