#!/opt/juno/venv/bin/python
"""Join a Slack huddle as the agent's own Slack user, record its audio, transcribe it.

  huddle_tool.py join URL (--announce TEXT | --announced) [--cdp-port N]
  huddle_tool.py status ID
  huddle_tool.py transcript ID
  huddle_tool.py leave ID

Slack has no bot API for huddles, so this drives the Slack web client in the agent's own running Chromium (attached over
CDP, the same profile and Slack sign-in the owner did once through takeover). The tab's sound goes to the PulseAudio null
sink `juno_out`; ffmpeg records its monitor into 30 s WAV chunks under /workspace/huddles/<id>/chunks/. `transcript`
sends finished chunks to an OpenAI-compatible /audio/transcriptions endpoint (HUDDLE_ASR_URL, HUDDLE_ASR_KEY,
HUDDLE_ASR_MODEL, optional HUDDLE_ASR_LANGUAGE) and writes /workspace/huddles/<id>/transcript.txt.
"""
import argparse
import array
import glob
import json
import os
import re
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid
import wave

# ---------------------------------------------------------------------------------------------------------------------
# Slack web client selectors: the ONLY place to fix when Slack changes its markup. Each entry is a list tried in order
# (CSS, or "role=button[name=/regex/i]" for an accessible-name match). They are best guesses from Slack's data-qa /
# aria conventions and have not been run against a live workspace yet.
# ---------------------------------------------------------------------------------------------------------------------
SELECTORS = {
    "workspace_ready": ['[data-qa="channel_sidebar"]', '[data-qa="slack_kit_list"]', ".p-client_container"],
    "signed_out": ['input[type="email"]', '[data-qa="signin_domain_input"]', 'a[href*="/signin"]'],
    "message_input": ['[data-qa="message_input"] [contenteditable="true"]', 'div[role="textbox"][contenteditable="true"]'],
    "huddle_button": ['[data-qa="huddle_channel_header_button"]', 'role=button[name=/huddle/i]'],
    "huddle_join": ['role=button[name=/^(join|start)( a)? huddle/i]', 'role=button[name=/^join$/i]', '[data-qa="huddle_join_button"]'],
    "huddle_surface": ['[data-qa="huddle_mini_player"]', '[data-qa="huddle_window"]', '[data-qa="huddle-sidebar"]'],
    "mic_button": ['[data-qa="huddle_mute_button"]', 'role=button[name=/^(mute|unmute)/i]'],
    "participant": ['[data-qa="huddle_participant"]', '[data-qa="huddle_participant_tile"]', '[data-qa="huddle_member"]'],
    "leave_button": ['[data-qa="huddle_leave_button"]', 'role=button[name=/^leave/i]'],
    "ended_text": [r"text=/huddle (has )?ended|you left the huddle|no one else is here/i"],
}
SIGNED_OUT_URL = re.compile(r"slack\.com/(signin|workspace-signin|get-started|ssb/|sign_in)", re.I)
SINK = "juno_out"
CHUNK_SECONDS = 30
ROOT = os.environ.get("HUDDLE_ROOT", "/workspace/huddles")
SILENT_PEAK = 150  # 16-bit peak below this = silence: not sent to the ASR (avoids invented text)


def die(message):
    print("error: " + message, file=sys.stderr)
    sys.exit(1)


# ---- state -----------------------------------------------------------------------------------------------------------

def huddle_dir(hid):
    if not re.fullmatch(r"[a-z0-9-]{4,40}", hid):
        die("bad huddle id")
    return os.path.join(ROOT, hid)


def load_meta(hid):
    path = os.path.join(huddle_dir(hid), "meta.json")
    try:
        with open(path, encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, ValueError):
        die("no huddle " + hid + " (join one first)")


def save_meta(hid, meta):
    with open(os.path.join(huddle_dir(hid), "meta.json"), "w", encoding="utf-8") as handle:
        json.dump(meta, handle, indent=1)


def pid_alive(pid):
    if not pid:
        return False
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    try:  # a zombie still answers kill 0
        with open("/proc/%d/stat" % pid) as handle:
            return handle.read().rsplit(")", 1)[1].split()[0] != "Z"
    except OSError:
        return True


def cdp_port(explicit):
    if explicit:
        return explicit
    display = os.environ.get("DISPLAY", "")
    found = re.search(r":(\d+)", display)
    if not found:
        die("cannot tell which browser is yours: pass --cdp-port (9222 + the display number)")
    return 9222 + int(found.group(1))


# ---- audio -----------------------------------------------------------------------------------------------------------

def ensure_audio():
    """The PulseAudio server of this user, with the null sink the browser plays into."""
    def sinks():
        return subprocess.run(["pactl", "list", "short", "sinks"], capture_output=True, text=True)
    result = sinks()
    if result.returncode != 0:
        subprocess.run(["pulseaudio", "--start", "--exit-idle-time=-1"], capture_output=True)
        for _ in range(20):
            time.sleep(0.25)
            result = sinks()
            if result.returncode == 0:
                break
        else:
            die("PulseAudio is not running and could not be started")
    if SINK not in result.stdout:
        subprocess.run(["pactl", "load-module", "module-null-sink", "sink_name=" + SINK, "sink_properties=device.description=Juno-output"], check=True, capture_output=True)
        subprocess.run(["pactl", "load-module", "module-remap-source", "master=%s.monitor" % SINK, "source_name=juno_mic", "source_properties=device.description=Juno-mic"], capture_output=True)
    subprocess.run(["pactl", "set-default-sink", SINK], capture_output=True)


def start_recording(folder):
    chunks = os.path.join(folder, "chunks")
    os.makedirs(chunks, exist_ok=True)
    log = open(os.path.join(folder, "ffmpeg.log"), "ab")
    process = subprocess.Popen(
        ["ffmpeg", "-nostdin", "-loglevel", "warning", "-f", "pulse", "-i", SINK + ".monitor", "-ac", "1", "-ar", "16000",
         "-f", "segment", "-segment_time", str(CHUNK_SECONDS), "-reset_timestamps", "1", os.path.join(chunks, "chunk-%05d.wav")],
        stdout=log, stderr=log, start_new_session=True)
    return process.pid


def stop_recording(pid):
    if not pid_alive(pid):
        return
    os.kill(pid, signal.SIGINT)  # lets ffmpeg finalize the last WAV header
    for _ in range(40):
        if not pid_alive(pid):
            return
        time.sleep(0.25)
    os.kill(pid, signal.SIGKILL)


def chunk_files(folder):
    return sorted(glob.glob(os.path.join(folder, "chunks", "chunk-*.wav")))


def chunk_peak(path):
    try:
        with wave.open(path, "rb") as handle:
            frames = handle.readframes(handle.getnframes())
    except (wave.Error, EOFError, OSError):
        return 0
    samples = array.array("h")
    samples.frombytes(frames[: len(frames) // 2 * 2])
    return max((abs(value) for value in samples[::7]), default=0)


# ---- ASR -------------------------------------------------------------------------------------------------------------

def asr_endpoint(base):
    base = base.rstrip("/")
    return base if base.endswith("/audio/transcriptions") else base + "/audio/transcriptions"


def multipart(fields, file_field, file_name, file_bytes):
    boundary = uuid.uuid4().hex
    parts = []
    for key, value in fields.items():
        parts.append(('--%s\r\nContent-Disposition: form-data; name="%s"\r\n\r\n%s\r\n' % (boundary, key, value)).encode())
    parts.append(('--%s\r\nContent-Disposition: form-data; name="%s"; filename="%s"\r\nContent-Type: audio/wav\r\n\r\n' % (boundary, file_field, file_name)).encode())
    parts.append(file_bytes)
    parts.append(("\r\n--%s--\r\n" % boundary).encode())
    return b"".join(parts), "multipart/form-data; boundary=" + boundary


def transcribe_file(path, url, key, model, language):
    fields = {"model": model, "response_format": "json"}
    if language:
        fields["language"] = language
    with open(path, "rb") as handle:
        body, content_type = multipart(fields, "file", os.path.basename(path), handle.read())
    request = urllib.request.Request(asr_endpoint(url), data=body, method="POST",
                                     headers={"Content-Type": content_type, "Authorization": "Bearer " + key})
    last = None
    for attempt in range(3):
        try:
            with urllib.request.urlopen(request, timeout=120) as response:
                return str(json.load(response).get("text", "")).strip()
        except urllib.error.HTTPError as error:
            last = "HTTP %d %s" % (error.code, error.read()[:200].decode("utf-8", "replace"))
            if error.code < 500 and error.code != 429:
                break
        except (urllib.error.URLError, OSError, ValueError) as error:
            last = str(error)
        time.sleep(2 * (attempt + 1))
    die("transcription failed for %s: %s" % (os.path.basename(path), last))


def stamp(index):
    seconds = index * CHUNK_SECONDS
    return "%02d:%02d:%02d" % (seconds // 3600, seconds % 3600 // 60, seconds % 60)


def cmd_transcript(args):
    folder = huddle_dir(args.id)
    meta = load_meta(args.id)
    url, key = os.environ.get("HUDDLE_ASR_URL"), os.environ.get("HUDDLE_ASR_KEY")
    if not url or not key:
        die("no speech-to-text configured: set HUDDLE_ASR_URL (an OpenAI-compatible base URL) and HUDDLE_ASR_KEY, optionally HUDDLE_ASR_MODEL. "
            "The recorded chunks are kept in " + os.path.join(folder, "chunks"))
    model, language = os.environ.get("HUDDLE_ASR_MODEL", "whisper-1"), os.environ.get("HUDDLE_ASR_LANGUAGE")
    cache_path = os.path.join(folder, "asr.json")
    try:
        with open(cache_path, encoding="utf-8") as handle:
            cache = json.load(handle)
    except (OSError, ValueError):
        cache = {}
    files = chunk_files(folder)
    if pid_alive(meta.get("recorderPid")) and files:
        files = files[:-1]  # the newest chunk is still being written
    for path in files:
        name = os.path.basename(path)
        if name in cache:
            continue
        cache[name] = "" if chunk_peak(path) < SILENT_PEAK else transcribe_file(path, url, key, model, language)
        with open(cache_path, "w", encoding="utf-8") as handle:
            json.dump(cache, handle)
    started = meta.get("startedAt", 0)
    lines = []
    for path in files:
        text = cache.get(os.path.basename(path), "")
        index = int(re.search(r"chunk-(\d+)", path).group(1))
        if text:
            lines.append("[%s] %s" % (stamp(index), text))
    header = "Huddle %s, recorded from %s (chunk times are offsets from the start of recording)\n" % (
        args.id, time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(started)))
    out = header + "\n".join(lines) + "\n"
    with open(os.path.join(folder, "transcript.txt"), "w", encoding="utf-8") as handle:
        handle.write(out)
    print(out + "(%d of %d chunks had speech)" % (len(lines), len(files)))


# ---- Slack web client ------------------------------------------------------------------------------------------------

def locate(scope, key):
    """First visible element of a SELECTORS entry in a page/frame, or None."""
    for selector in SELECTORS[key]:
        if selector.startswith("role="):
            role, pattern, flag = re.match(r"role=(\w+)\[name=/(.*)/(i?)\]", selector).groups()
            locator = scope.get_by_role(role, name=re.compile(pattern, re.I if flag else 0))
        else:
            locator = scope.locator(selector)
        if locator.count() and locator.first.is_visible():
            return locator.first
    return None


def wait_for(pages_fn, key, seconds):
    """Poll every page of the browser context for a SELECTORS entry; returns (page, element) or (None, None)."""
    deadline = time.time() + seconds
    while time.time() < deadline:
        for page in pages_fn():
            try:
                found = locate(page, key)
            except Exception:  # a page navigating away mid-query
                continue
            if found:
                return page, found
        time.sleep(0.5)
    return None, None


def attach(port):
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        die("playwright is missing from /opt/juno/venv; run this script with /opt/juno/venv/bin/python")
    driver = sync_playwright().start()
    try:
        browser = driver.chromium.connect_over_cdp("http://127.0.0.1:%d" % port)
    except Exception as error:
        driver.stop()
        die("cannot reach your browser on CDP port %d (%s)" % (port, str(error).splitlines()[0]))
    return driver, browser.contexts[0]


def not_signed_in():
    die("not signed in to Slack in your browser: ask the owner to sign in once with request_takeover (use the agent's own Slack account), then retry")


def cmd_join(args):
    if not re.match(r"https://[\w.-]+\.slack\.com/|https://app\.slack\.com/", args.url):
        die("expected a Slack channel URL like https://app.slack.com/client/T123/C456 or https://acme.slack.com/archives/C456")
    if not args.announce and not args.announced:
        die("announce yourself first: pass --announce 'Juno is taking notes of this huddle for <owner>' (posted in the channel as you), or --announced if you already told the channel")
    hid = time.strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:4]
    folder = huddle_dir(hid)
    os.makedirs(folder, exist_ok=True)
    port = cdp_port(args.cdp_port)
    ensure_audio()
    driver, context = attach(port)
    try:
        # the same Chromium the owner signed in to: grant the mic to Slack (the browser denies prompts by default)
        for origin in ("https://app.slack.com", args.url.split("/archives")[0].split("/client")[0]):
            try:
                context.grant_permissions(["microphone"], origin=origin)
            except Exception:
                pass
        page = context.new_page()
        page.goto(args.url, wait_until="domcontentloaded")
        _, ready = wait_for(lambda: [page], "workspace_ready", 25)
        if not ready or SIGNED_OUT_URL.search(page.url) or locate(page, "signed_out"):
            page.close()
            not_signed_in()
        if args.announce:
            box = locate(page, "message_input")
            if not box:
                die("could not find the message box to announce in (selector 'message_input')")
            box.click()
            page.keyboard.type(args.announce)
            page.keyboard.press("Enter")
            time.sleep(1)
        button = locate(page, "huddle_button")
        if not button:
            die("no huddle button in this channel (selector 'huddle_button'); is it a channel or DM you can huddle in?")
        button.click()
        # the huddle may open in a pop-out window or in the page; the join/start confirmation is not always shown
        join_page, join = wait_for(lambda: context.pages, "huddle_join", 6)
        if join:
            join.click()
        surface_page, _ = wait_for(lambda: context.pages, "huddle_surface", 20)
        if not surface_page:
            surface_page, _ = wait_for(lambda: context.pages, "participant", 5)
        if not surface_page:
            die("clicked the huddle button but never saw the huddle (selectors 'huddle_surface'/'participant'); a screenshot of the tab is in " + folder)
        mic = locate(surface_page, "mic_button")
        muted = "unknown"
        if mic:
            label = (mic.get_attribute("aria-label") or mic.inner_text() or "").strip().lower()
            if label.startswith("mute"):
                mic.click()
                muted = "yes"
            elif label.startswith("unmute"):
                muted = "yes"
        participants = 0
        try:
            for selector in SELECTORS["participant"]:
                participants = max(participants, surface_page.locator(selector).count())
        except Exception:
            pass
        pid = start_recording(folder)
        save_meta(hid, {"id": hid, "url": args.url, "startedAt": time.time(), "recorderPid": pid, "cdpPort": port,
                        "huddlePageUrl": surface_page.url, "joinedPageUrl": page.url})
        try:
            page.screenshot(path=os.path.join(folder, "joined.png"))
        except Exception:
            pass
        print(json.dumps({"id": hid, "joined": True, "micMuted": muted, "participantsSeen": participants, "folder": folder}))
    finally:
        driver.stop()  # detaches only: the browser and its tabs stay


def find_huddle_page(context, meta):
    for page in context.pages:
        if page.url == meta.get("huddlePageUrl") or "/huddle" in page.url:
            return page
    for page in context.pages:
        if locate(page, "huddle_surface"):
            return page
    return None


def cmd_status(args):
    meta = load_meta(args.id)
    folder = huddle_dir(args.id)
    state = {"id": args.id, "recording": pid_alive(meta.get("recorderPid")), "chunks": len(chunk_files(folder)),
             "recordedSeconds": len(chunk_files(folder)) * CHUNK_SECONDS, "transcript": os.path.exists(os.path.join(folder, "transcript.txt")),
             "left": bool(meta.get("leftAt"))}
    if not meta.get("leftAt"):
        driver = None
        try:
            driver, context = attach(meta["cdpPort"])
            page = find_huddle_page(context, meta)
            state["huddleOpen"] = bool(page)
            if page:
                state["ended"] = bool(locate(page, "ended_text"))
                state["participantsSeen"] = max([page.locator(s).count() for s in SELECTORS["participant"]] or [0])
            else:
                state["ended"] = True
        except SystemExit:
            state["huddleOpen"] = "unknown (browser unreachable)"
        finally:
            if driver:
                driver.stop()
    print(json.dumps(state))


def cmd_leave(args):
    meta = load_meta(args.id)
    left = "recording stopped only"
    try:
        driver, context = attach(meta["cdpPort"])
        try:
            page = find_huddle_page(context, meta)
            if page:
                button = locate(page, "leave_button")
                if button:
                    button.click()
                    left = "left the huddle"
                else:
                    left = "huddle already closed or leave button not found (selector 'leave_button'); recording stopped"
            else:
                left = "huddle window already gone; recording stopped"
        finally:
            driver.stop()
    except SystemExit:
        left = "browser unreachable; recording stopped"
    stop_recording(meta.get("recorderPid"))
    meta["leftAt"] = time.time()
    save_meta(args.id, meta)
    print(json.dumps({"id": args.id, "result": left, "chunks": len(chunk_files(huddle_dir(args.id)))}))


def build_parser():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    join = sub.add_parser("join")
    join.add_argument("url")
    join.add_argument("--announce", help="message posted in the channel before joining (consent notice)")
    join.add_argument("--announced", action="store_true", help="the channel was already told another way")
    join.add_argument("--cdp-port", type=int)
    join.set_defaults(run=cmd_join)
    for name, run in (("status", cmd_status), ("transcript", cmd_transcript), ("leave", cmd_leave)):
        item = sub.add_parser(name)
        item.add_argument("id")
        item.set_defaults(run=run)
    return parser


def main(argv=None):
    args = build_parser().parse_args(argv)
    args.run(args)


if __name__ == "__main__":
    main()
