"""Bundle sandbox image assets into one deterministic tar archive.

Each per-asset COPY in the image recipe serially snapshots an intermediate
VM on the build host, which exhausted its disk. The recipe therefore copies
a single archive built here and installs it in a single RUN instead.

The archive is generated from tracked plain source in files/ immediately
before Template.build (see build_debian.py) and removed afterwards, so the
binary tar is never checked into the repo. Only the standard library is
used, no subprocess is spawned, and importing or running this module never
touches the network or E2B:

    python3 prepare_assets.py --output /tmp/any/sandbox-assets.tar

Archive layout: one member per destination path (leading slash stripped,
sorted by destination for determinism). Member bytes and permission bits
come straight from the source file, so extraction with ``tar -xpf`` to /
restores the original paths, contents and modes. Sources shipped to two
destinations (xfce4-panel.xml) become two members with identical bytes.
"""

import argparse
import io
import os
import stat
import tarfile

HERE = os.path.dirname(os.path.abspath(__file__))
FILES_DIR = os.path.join(HERE, "files")
ARCHIVE_FILENAME = "sandbox-assets.tar"
ARCHIVE_PATH = os.path.join(FILES_DIR, ARCHIVE_FILENAME)

# Explicit mapping of original source assets in files/ to their exact image
# destinations, mirroring the recipe install paths.
ASSET_MAP = [
    ("chromium.desktop", "/usr/share/applications/chromium.desktop"),
    ("chromium-policies.json", "/etc/chromium/policies/managed/policies.json"),
    ("mimeapps.list", "/home/agent/.config/mimeapps.list"),
    ("xfce4-session.xml", "/home/agent/.config/xfce4/xfconf/xfce-perchannel-xml/xfce4-session.xml"),
    ("xfce4-desktop-plain.xml", "/home/agent/.config/xfce4/xfconf/xfce-perchannel-xml/xfce4-desktop.xml"),
    ("xsettings.xml", "/home/agent/.config/xfce4/xfconf/xfce-perchannel-xml/xsettings.xml"),
    ("xfwm4.xml", "/home/agent/.config/xfce4/xfconf/xfce-perchannel-xml/xfwm4.xml"),
    ("xfce4-panel.xml", "/home/agent/.config/xfce4/xfconf/xfce-perchannel-xml/xfce4-panel.xml"),
    ("wallpaper.png", "/usr/local/share/juno/wallpaper.png"),
    ("agent-screen-dock", "/usr/local/share/agent-screen-dock/agent-screen-dock"),
    ("xfce4-panel.xml", "/usr/local/share/agent-screen-dock/xfce4-panel.xml"),
    ("xfce4-desktop-plain.xml", "/usr/local/share/agent-screen-dock/xfce4-desktop.xml"),
    ("gtk.css", "/usr/local/share/agent-screen-dock/gtk.css"),
    ("screensaver.desktop", "/home/agent/.config/autostart/screensaver.desktop"),
    ("maximize.lua", "/home/agent/.config/devilspie2/maximize.lua"),
    ("devilspie2.desktop", "/home/agent/.config/autostart/devilspie2.desktop"),
    ("start-browser.desktop", "/home/agent/.config/autostart/start-browser.desktop"),
    ("quiet-libreoffice.xcd", "/usr/lib/libreoffice/share/registry/quiet-libreoffice.xcd"),
    # The computer link daemon (BACKEND 7.11), compiled by ../juno-link/build.sh (bun build --compile); never checked in.
    ("juno-link", "/usr/local/bin/juno-link"),
    ("agent-browser", "/usr/local/bin/agent-browser"),
    ("agent-meet", "/usr/local/bin/agent-meet"),
    ("agent_browser_jev.py", "/usr/local/bin/agent_browser_jev.py"),
    ("agent_browser_jev_scripts.py", "/usr/local/bin/agent_browser_jev_scripts.py"),
    ("agent_browser_jev.LICENSE", "/usr/local/bin/agent_browser_jev.LICENSE"),
    ("agent_browser_cdp.py", "/usr/local/bin/agent_browser_cdp.py"),
    ("agent_browser_refs.py", "/usr/local/bin/agent_browser_refs.py"),
    ("agent_browser_nav.py", "/usr/local/bin/agent_browser_nav.py"),
    ("agent_browser_select.py", "/usr/local/bin/agent_browser_select.py"),
    ("agent_browser_input.py", "/usr/local/bin/agent_browser_input.py"),
    ("agent_browser_attrs.py", "/usr/local/bin/agent_browser_attrs.py"),
    ("agent_browser_bounds.py", "/usr/local/bin/agent_browser_bounds.py"),
    ("agent_browser_frames.py", "/usr/local/bin/agent_browser_frames.py"),
    ("agent_browser_notices.py", "/usr/local/bin/agent_browser_notices.py"),
    ("agent_browser_watch.py", "/usr/local/bin/agent_browser_watch.py"),
    ("agent_browser_seal.py", "/usr/local/bin/agent_browser_seal.py"),
    ("agent_browser_mask.py", "/usr/local/bin/agent_browser_mask.py"),
    ("jev-browser/jev-preload.mjs", "/opt/juno/jev-browser/jev-preload.mjs"),
    ("jev-browser/jev_redact.py", "/opt/juno/jev-browser/jev_redact.py"),
    ("jev-browser/agent_jev_supervise.py", "/opt/juno/jev-browser/agent_jev_supervise.py"),
    ("jev-browser/install-jev-browser.sh", "/opt/juno/jev-browser/install-jev-browser.sh"),
    ("jev-browser/package-lock.json", "/opt/juno/jev-browser/package-lock.json"),
    ("agent-home/index.html", "/usr/local/share/agent-home/index.html"),
    ("juno-app-open", "/usr/local/bin/juno-app-open"),
    ("juno-app.desktop", "/usr/share/applications/juno-app.desktop"),
    # Platform skills (BACKEND 5.11): a SKILL.md plus a CLI each, read-only in the image; the venv is built from _lib/requirements.txt.
    ("skills/_lib/juno_skill.py", "/opt/juno/skills/_lib/juno_skill.py"),
    ("skills/_lib/requirements.txt", "/opt/juno/skills/_lib/requirements.txt"),
    ("skills/docx/SKILL.md", "/opt/juno/skills/docx/SKILL.md"),
    ("skills/docx/docx_tool.py", "/opt/juno/skills/docx/docx_tool.py"),
    ("skills/pptx/SKILL.md", "/opt/juno/skills/pptx/SKILL.md"),
    ("skills/pptx/pptx_tool.py", "/opt/juno/skills/pptx/pptx_tool.py"),
    ("skills/xlsx/SKILL.md", "/opt/juno/skills/xlsx/SKILL.md"),
    ("skills/xlsx/xlsx_tool.py", "/opt/juno/skills/xlsx/xlsx_tool.py"),
    ("skills/pdf/SKILL.md", "/opt/juno/skills/pdf/SKILL.md"),
    ("skills/pdf/pdf_tool.py", "/opt/juno/skills/pdf/pdf_tool.py"),
    ("skills/markdown/SKILL.md", "/opt/juno/skills/markdown/SKILL.md"),
    ("skills/markdown/markdown_tool.py", "/opt/juno/skills/markdown/markdown_tool.py"),
    ("skills/card/SKILL.md", "/opt/juno/skills/card/SKILL.md"),
    ("skills/card/card_tool.py", "/opt/juno/skills/card/card_tool.py"),
    # Spaces (BACKEND 5.12): the skill with its two templates (bun.lock files committed), the in-VM gateway and the image-build script that installs Bun.
    ("spaces/gateway.mjs", "/opt/juno/spaces/gateway.mjs"),
    ("spaces/install-runtime.sh", "/opt/juno/spaces/install-runtime.sh"),
    ("storage/install-juicefs.sh", "/opt/juno/storage/install-juicefs.sh"),
    # Web & video apps (BACKEND 10.18): the image-build script, its pinned dependency sets and the entry point it links to /usr/local/bin/agent-reach.
    ("reach/install-reach.sh", "/opt/juno/reach/install-reach.sh"),
    ("reach/constraints-agent-reach.txt", "/opt/juno/reach/constraints-agent-reach.txt"),
    ("reach/constraints-bili-cli.txt", "/opt/juno/reach/constraints-bili-cli.txt"),
    ("reach/agent-reach", "/opt/juno/reach/agent-reach"),
    # Login channels (BACKEND 10.18): OpenCLI's install script and its pinned dependency tree.
    ("reach/install-opencli.sh", "/opt/juno/reach/install-opencli.sh"),
    ("reach/opencli/package.json", "/opt/juno/reach/opencli/package.json"),
    ("reach/opencli/package-lock.json", "/opt/juno/reach/opencli/package-lock.json"),
    ("skills/huddle/SKILL.md", "/opt/juno/skills/huddle/SKILL.md"),
    ("skills/huddle/huddle_tool.py", "/opt/juno/skills/huddle/huddle_tool.py"),
    ("skills/shopping/SKILL.md", "/opt/juno/skills/shopping/SKILL.md"),
    ("skills/spaces/SKILL.md", "/opt/juno/skills/spaces/SKILL.md"),
    ("skills/spaces/spaces_tool.py", "/opt/juno/skills/spaces/spaces_tool.py"),
    ("skills/spaces/templates/app/.gitignore", "/opt/juno/skills/spaces/templates/app/.gitignore"),
    ("skills/spaces/templates/app/bun.lock", "/opt/juno/skills/spaces/templates/app/bun.lock"),
    ("skills/spaces/templates/app/db.ts", "/opt/juno/skills/spaces/templates/app/db.ts"),
    ("skills/spaces/templates/app/drizzle.config.ts", "/opt/juno/skills/spaces/templates/app/drizzle.config.ts"),
    ("skills/spaces/templates/app/index.html", "/opt/juno/skills/spaces/templates/app/index.html"),
    ("skills/spaces/templates/app/package.json", "/opt/juno/skills/spaces/templates/app/package.json"),
    ("skills/spaces/templates/app/schema.ts", "/opt/juno/skills/spaces/templates/app/schema.ts"),
    ("skills/spaces/templates/app/server.ts", "/opt/juno/skills/spaces/templates/app/server.ts"),
    ("skills/spaces/templates/app/tsconfig.json", "/opt/juno/skills/spaces/templates/app/tsconfig.json"),
    ("skills/spaces/templates/app/vite.config.ts", "/opt/juno/skills/spaces/templates/app/vite.config.ts"),
    ("skills/spaces/templates/app/migrations/0000_init.sql", "/opt/juno/skills/spaces/templates/app/migrations/0000_init.sql"),
    ("skills/spaces/templates/app/migrations/meta/0000_snapshot.json", "/opt/juno/skills/spaces/templates/app/migrations/meta/0000_snapshot.json"),
    ("skills/spaces/templates/app/migrations/meta/_journal.json", "/opt/juno/skills/spaces/templates/app/migrations/meta/_journal.json"),
    ("skills/spaces/templates/app/src/App.tsx", "/opt/juno/skills/spaces/templates/app/src/App.tsx"),
    ("skills/spaces/templates/app/src/main.tsx", "/opt/juno/skills/spaces/templates/app/src/main.tsx"),
    ("skills/spaces/templates/app/src/style.css", "/opt/juno/skills/spaces/templates/app/src/style.css"),
    ("skills/spaces/templates/static/.gitignore", "/opt/juno/skills/spaces/templates/static/.gitignore"),
    ("skills/spaces/templates/static/package.json", "/opt/juno/skills/spaces/templates/static/package.json"),
    ("skills/spaces/templates/static/server.ts", "/opt/juno/skills/spaces/templates/static/server.ts"),
    ("skills/spaces/templates/static/public/app.js", "/opt/juno/skills/spaces/templates/static/public/app.js"),
    ("skills/spaces/templates/static/public/index.html", "/opt/juno/skills/spaces/templates/static/public/index.html"),
    ("skills/spaces/templates/static/public/style.css", "/opt/juno/skills/spaces/templates/static/public/style.css"),
]


def member_name(dest):
    """Archive member name for an image destination path."""
    return dest.lstrip("/")


def build_archive(output_path=ARCHIVE_PATH, with_daemon=True):
    """Write the deterministic asset archive and return its path. `with_daemon=False` leaves juno-link out (a bundle unpacked into a computer that already runs it)."""
    parent = os.path.dirname(os.path.abspath(output_path))
    os.makedirs(parent, exist_ok=True)
    entries = sorted((item for item in ASSET_MAP if with_daemon or item[0] != "juno-link"), key=lambda item: item[1])
    with tarfile.open(output_path, "w", format=tarfile.PAX_FORMAT) as tar:
        for src, dest in entries:
            src_path = os.path.join(FILES_DIR, src)
            if not os.path.exists(src_path) and src == "juno-link":
                raise SystemExit("files/juno-link is missing: build the daemon first with packages/juno-link/build.sh")
            with open(src_path, "rb") as handle:
                data = handle.read()
            info = tarfile.TarInfo(name=member_name(dest))
            info.size = len(data)
            info.mtime = 0
            info.uid = 0
            info.gid = 0
            info.uname = "root"
            info.gname = "root"
            info.mode = stat.S_IMODE(os.stat(src_path).st_mode)
            tar.addfile(info, io.BytesIO(data))
    return output_path


def main(argv=None):
    parser = argparse.ArgumentParser(description="Bundle sandbox image assets into one tar archive.")
    parser.add_argument("--output", default=ARCHIVE_PATH, help="archive path to write")
    parser.add_argument("--without-daemon", action="store_true", help="leave the juno-link binary out (for unpacking into a computer that already runs it)")
    args = parser.parse_args(argv)
    print(build_archive(args.output, with_daemon=not args.without_daemon))


if __name__ == "__main__":
    main()
