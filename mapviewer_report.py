#!/usr/bin/env python3
"""Map Viewer report wrapper.

Usage:
  py mapviewer_report.py <map-file> [output-html] [--gap <value>]

Examples:
  py mapviewer_report.py D:\\inputs\\app.map
  py mapviewer_report.py D:\\inputs\\app.map D:\\reports\\app_report.html
  py mapviewer_report.py D:\\inputs\\app.map D:\\reports\\app_report.html --gap 0x80
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
from pathlib import Path

# Project path macro:
# 1) Set MAPVIEWER_ROOT to override project root explicitly.
# 2) Otherwise, use the folder where this script is located.
PROJECT_ROOT = Path(os.environ.get("MAPVIEWER_ROOT", Path(__file__).resolve().parent))
FRONTEND_DIR = PROJECT_ROOT / "frontend"
CLI_JS = FRONTEND_DIR / "cli" / "index.js"
DIST_HTML = FRONTEND_DIR / "dist" / "index.html"


def run_command(cmd: list[str], cwd: Path | None = None) -> int:
    result = subprocess.run(cmd, cwd=str(cwd) if cwd else None)
    return int(result.returncode)


def ensure_built() -> None:
    if DIST_HTML.exists():
        return
    print(f"[mapviewer] Build template not found: {DIST_HTML}")
    print("[mapviewer] Running: pnpm build")
    code = run_command(["pnpm", "build"], cwd=FRONTEND_DIR)
    if code != 0:
        raise SystemExit(code)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Generate an embedded HTML report from an IAR map file.",
        formatter_class=argparse.RawTextHelpFormatter,
    )
    parser.add_argument("map_file", help="Path to .map file")
    parser.add_argument(
        "output_html",
        nargs="?",
        default=None,
        help="Optional output html path. Default: <map-name>_report.html beside map file",
    )
    parser.add_argument(
        "--gap",
        default=None,
        help="Optional merge threshold (examples: 64B, 128, 1KB, 0x40)",
    )

    args = parser.parse_args()

    if not CLI_JS.exists():
        print(f"[mapviewer] CLI not found: {CLI_JS}", file=sys.stderr)
        return 1

    map_file = Path(args.map_file).expanduser().resolve()
    if not map_file.exists():
        print(f"[mapviewer] Map file not found: {map_file}", file=sys.stderr)
        return 1

    if args.output_html:
        output_html = Path(args.output_html).expanduser().resolve()
    else:
        output_html = map_file.with_name(f"{map_file.stem}_report.html")

    ensure_built()

    cmd = [
        "node",
        str(CLI_JS),
        str(map_file),
        "--out",
        str(output_html),
    ]

    if args.gap is not None:
        cmd.extend(["--gap", args.gap])

    code = run_command(cmd)
    if code == 0:
        print(f"[mapviewer] Report generated: {output_html}")
    return code


if __name__ == "__main__":
    raise SystemExit(main())
