"""Shared helpers for the platform skill CLIs: spec loading, errors, headless Chromium."""
import json
import os
import shutil
import subprocess
import sys
import tempfile

CHROMIUM = "/usr/lib/chromium/chromium"  # the binary itself: the /usr/bin wrapper adds the desktop's debug-port flags and never exits


def die(message):
    print("error: " + message, file=sys.stderr)
    sys.exit(1)


def load_spec(path):
    try:
        with open(path, encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, ValueError) as error:
        die("cannot read spec " + path + ": " + str(error))


def chromium(args, timeout=90):
    """Run headless Chromium with a throwaway profile; raise on failure or timeout."""
    binary = CHROMIUM if os.path.exists(CHROMIUM) else (shutil.which("chromium") or die("chromium not found"))
    profile = tempfile.mkdtemp(prefix="juno-chromium-")
    command = [binary, "--headless", "--no-sandbox", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=1",
               "--allow-file-access-from-files", "--user-data-dir=" + profile] + args
    try:
        subprocess.run(command, check=True, timeout=timeout, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                       env={**os.environ, "HOME": profile})
    except subprocess.TimeoutExpired:
        die("chromium timed out after " + str(timeout) + "s")
    except subprocess.CalledProcessError as error:
        die("chromium failed with exit code " + str(error.returncode))
    finally:
        shutil.rmtree(profile, ignore_errors=True)


def html_to_pdf(html_path, pdf_path):
    chromium(["--no-pdf-header-footer", "--virtual-time-budget=2000", "--print-to-pdf=" + os.path.abspath(pdf_path),
              "file://" + os.path.abspath(html_path)])
    if not os.path.exists(pdf_path):
        die("chromium produced no PDF")
