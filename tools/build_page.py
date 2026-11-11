#!/usr/bin/env python3
"""Build the 3D page in docs/ from the launch-page template and this project's missions.

    ~/.venvs/astro313/bin/python tools/build_page.py              # export every mission and register it in docs/
    ~/.venvs/astro313/bin/python tools/build_page.py --upgrade    # first rebuild docs/ from the current template

The page code is the template's (~/launch/launch-page-template, created by the launch-page skill's new_page.py);
nothing in docs/js or docs/index.html is edited here. What belongs to this project is the mission data
(tools/export_mission.py), docs/model.html and docs/img/, which --upgrade carries over. Missions are every file in
model/missions/ that has a solution in out/: forecasts first, by date, then reconstructions."""
import argparse, json, shutil, subprocess, sys, tempfile
from datetime import datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
NEW_PAGE = Path.home() / '.claude/skills/launch-page/scripts/new_page.py'
PROFILE = ['--profile', 'shenzhou', '--profile-label', 'Shenzhou · return from the China Space Station', '--family', 'low-inclination']
KEEP = ['model.html', 'img']                 # this project's own files in docs/
DEFAULT = 'sz23-1129'                        # the pass the 13 November reboost phases over the site
TITLE = 'Shenzhou reentry'
DESCRIPTION = ('Shenzhou returns from the China Space Station in 3D: deorbit burn, capsule entry, plasma trail, parachutes and touchdown '
               'at Dongfeng, with sunlight and observer sky charts. Forecast for Shenzhou-23 and reconstruction of Shenzhou-20.')


def missions():
    out = []
    for path in sorted((ROOT / 'model' / 'missions').glob('*.json')):
        cfg = json.loads(path.read_text())
        if not (ROOT / 'out' / f"{cfg['id']}_solution.json").exists():
            continue
        land = json.loads((ROOT / 'out' / f"{cfg['id']}_solution.json").read_text())['diag']['landing_utc']
        t = datetime.fromisoformat(land.replace('Z', '+00:00')) + timedelta(seconds=30)      # to the nearest minute
        if cfg.get('kind') == 'prediction':
            label = f"{cfg['name']} · {t.day} {t:%b %H:%M} UTC (forecast)"
        else:
            label = f"{cfg['name']} · {t.day} {t:%b %Y}" + (' (uncrewed)' if 'ncrewed' in cfg.get('description', '') else '')
        out.append((cfg.get('kind') != 'prediction', cfg['date'], cfg['id'], label))
    return [(i, label) for _, _, i, label in sorted(out)]


def run(*args):
    result = subprocess.run([sys.executable, *map(str, args)], cwd=ROOT)
    if result.returncode:
        sys.exit(result.returncode)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--upgrade', action='store_true', help='rebuild docs/ from the current template, keeping ' + ' and '.join(KEEP))
    a = ap.parse_args()
    todo = missions()
    if not todo:
        sys.exit('No solved missions in out/.')
    order = [DEFAULT] + [i for i, _ in todo if i != DEFAULT] if any(i == DEFAULT for i, _ in todo) else [i for i, _ in todo]
    labels = dict(todo)
    for mid in order:
        run(ROOT / 'tools' / 'export_mission.py', '--id', mid)
    docs = ROOT / 'docs'
    with tempfile.TemporaryDirectory() as tmp:
        if a.upgrade and docs.exists():
            for name in KEEP:
                if (docs / name).exists():
                    shutil.move(str(docs / name), str(Path(tmp) / name))
            shutil.rmtree(docs)
        fresh = not docs.exists()
        for k, mid in enumerate(order):
            extra = ['--title', TITLE, '--description', DESCRIPTION, '--vehicle', 'Shenzhou'] if fresh and k == 0 else ['--add']
            run(NEW_PAGE, ROOT, '--mission', ROOT / 'out' / 'web' / f'{mid}.json', '--id', mid, '--label', labels[mid], *PROFILE, *extra)
        for name in KEEP:
            if (Path(tmp) / name).exists():
                shutil.move(str(Path(tmp) / name), str(docs / name))
    # menu order and default: new_page.py appends and takes the first mission as the default
    path = docs / 'data' / 'profiles.json'
    manifest = json.loads(path.read_text())
    profile = next(p for p in manifest['profiles'] if p['id'] == 'shenzhou')
    profile['missions'] = [dict(id=i, label=label, file=f'data/{i}.json') for i, label in todo]
    profile['default_mission'] = order[0]
    manifest['default_profile'] = 'shenzhou'
    path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
    for stale in (docs / 'data').glob('sz*.json'):
        if stale.stem not in labels:
            stale.unlink()
    print('missions:', ', '.join(f'{i} ({label})' for i, label in todo), '| default', order[0])


if __name__ == '__main__':
    main()
