#!/opt/juno/venv/bin/python
"""Render an HTML file to a PNG card or a short MP4 (headless Chromium, ffmpeg).

  card_tool.py png IN.html OUT.png [--width 1080] [--height 1350]
  card_tool.py mp4 IN.html OUT.mp4 [--width 1080] [--height 1350] [--seconds 3] [--fps 10]

The MP4 is frame-by-frame: Chromium's virtual clock is advanced to each frame's time, so CSS animations,
transitions, setTimeout and requestAnimationFrame play exactly as they would live.
"""
import argparse
import os
import shutil
import subprocess
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "_lib"))
from juno_skill import chromium, die  # noqa: E402


def shot(html_path, out, width, height, at_ms):
    args = ["--window-size=%d,%d" % (width, height), "--screenshot=" + out]
    if at_ms is not None:
        args.insert(0, "--virtual-time-budget=" + str(max(int(at_ms), 1)))
    chromium(args + ["file://" + os.path.abspath(html_path)])
    if not os.path.exists(out):
        die("chromium produced no image for " + html_path)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("kind", choices=["png", "mp4"])
    parser.add_argument("html")
    parser.add_argument("out")
    parser.add_argument("--width", type=int, default=1080)
    parser.add_argument("--height", type=int, default=1350)
    parser.add_argument("--seconds", type=float, default=3)
    parser.add_argument("--fps", type=int, default=10)
    args = parser.parse_args()
    if args.kind == "png":
        shot(args.html, args.out, args.width, args.height, 1000)
    else:
        if args.seconds > 15 or args.fps > 30:
            die("at most 15 seconds and 30 fps")
        width, height = args.width // 2 * 2, args.height // 2 * 2  # H.264 needs even sizes
        frames = int(args.seconds * args.fps)
        folder = tempfile.mkdtemp(prefix="juno-card-")
        try:
            with ThreadPoolExecutor(max_workers=4) as pool:
                list(pool.map(lambda i: shot(args.html, os.path.join(folder, "f%04d.png" % i), width, height, i * 1000 / args.fps + 1), range(frames)))
            subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-framerate", str(args.fps), "-i", os.path.join(folder, "f%04d.png"),
                            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", args.out], check=True)
        finally:
            shutil.rmtree(folder, ignore_errors=True)
    print("wrote " + args.out)


main()
