# Debian 13 desktop modelled on OpenAI dots: XFCE window manager with a bottom
# dock (no top panel, icons, notifications or power manager), Debian Chromium,
# LibreOffice Writer/Calc/Impress, Orchis theme with Papirus icons and Inter, user "agent" WITHOUT sudo (agents get their own juno-<id> users at runtime, BACKEND 7.9), working directory /workspace.
# juno-link (BACKEND 7.11) is a root daemon computerd starts after create that dials out to computerd and serves everything the platform does inside the computer.
# The E2B desktop SDK waits for xfce4-session, xfwm4 and xfdesktop at startup,
# so those still run; xfdesktop just draws a plain color.
from e2b import CopyItem, Template

XFCONF = "/home/agent/.config/xfce4/xfconf/xfce-perchannel-xml"

template = (
    Template(file_context_path="files")
    .from_image("debian:trixie")
    .set_user("root")
    .set_workdir("/")
    .set_envs(
        {
            "DEBIAN_FRONTEND": "noninteractive",
            "DEBIAN_PRIORITY": "high",
        }
    )
    .apt_install(
        [
            # display and the tools the E2B desktop SDK calls
            "xserver-xorg",
            "x11-xserver-utils",
            "xvfb",
            "x11-utils",
            "xauth",
            "dbus-x11",
            "xdotool",
            "scrot",
            # the computer clipboard side channel (M-CLIP): puts a pasted image on the X clipboard and reads what was copied
            "xclip",
            "x11vnc",
            # bare XFCE: session, window manager, desktop, settings, terminal
            "xfce4-session",
            "xfwm4",
            "xfdesktop4",
            "xfce4-settings",
            "xfconf",
            "xfce4-terminal",
            "mousepad",
            "xfce4-panel",
            # browser and look
            "chromium",
            "adwaita-icon-theme",
            "orchis-gtk-theme",
            "papirus-icon-theme",
            "fonts-inter",
            "fonts-dejavu",
            "fonts-liberation",
            "fonts-noto-color-emoji",
            "fonts-noto-cjk",
            # basics (sudo stays installed for the E2B tooling; no sudoers entry grants it to any agent)
            "sudo",
            "ca-certificates",
            "curl",
            "git",
            "wget",
            "python3",
            "python3-numpy",
            "python3-websocket",
            # secure input (BACKEND 8.7): the helper unseals values encrypted to the sandbox's X25519 key
            "python3-cryptography",
            "ffmpeg",
            # huddle skill (BACKEND 5.12b): a PulseAudio null sink is the browser's output; ffmpeg records its monitor
            "pulseaudio",
            "pulseaudio-utils",
            # platform skills (BACKEND 5.11): the venv for their Python libraries, and md -> docx/html
            "python3-venv",
            "pandoc",
            "net-tools",
            # Spaces (BACKEND 5.12): unpacks the pinned Bun release in install-runtime.sh
            "unzip",
            # Original jev-browser MCP (explicit opt-in): Node >=20 runtime for the production wrapper.
            "nodejs",
            "npm",
            # durable storage (BACKEND 7.10): the JuiceFS client mounts /juno and /workspace through FUSE
            "fuse3",
            # per-agent isolation (BACKEND 7.9): one network namespace per agent (iproute2: ip netns, veth; nftables: the forward and NAT
            # rules), /workspace default ACL. E2B's base image already has iproute2 and nftables; the local Docker image needs these lines.
            "iproute2",
            "nftables",
            "acl",
            "netcat-openbsd",
            "desktop-file-utils",
            "devilspie2",
            # accessibility tree for agents: AT-SPI from Python, and the GTK/LibreOffice bridge into it
            "gir1.2-atspi-2.0",
            "libatk-adaptor",
        ]
    )
    # lightweight office: Writer, Calc, Impress without the recommended extras;
    # poppler-utils (pdftoppm) makes first-page thumbnails of published PDFs and Office files (BACKEND 5.11)
    .apt_install(
        ["libreoffice-writer", "libreoffice-calc", "libreoffice-impress", "libreoffice-gtk3", "poppler-utils"],
        no_install_recommends=True,
    )
    # noVNC and websockify for the stream
    .git_clone(
        "https://github.com/e2b-dev/noVNC.git", "/opt/noVNC", branch="e2b-desktop"
    )
    .make_symlink("/opt/noVNC/vnc.html", "/opt/noVNC/index.html")
    .git_clone(
        "https://github.com/novnc/websockify.git",
        "/opt/noVNC/utils/websockify",
        branch="v0.12.0",
    )
    # voxl (https://github.com/tembo/voxl): H.264-over-WebSocket desktop streamer, an alternative to noVNC (BACKEND 7.1b). Pinned to crate
    # voxl-server 0.3.3 (= tag at commit 47bb94e) and built here with a throwaway Rust toolchain and esbuild; only /usr/local/bin/voxl and its
    # runtime libraries stay. The build fails if the binary does not run or has an unresolved library. GPL (it links x264); the platform starts
    # it only when SCREEN_STREAM includes voxl.
    .apt_install(
        ["build-essential", "pkg-config", "clang", "libclang-dev", "libxcb1-dev", "libx264-dev", "libyuv-dev", "libopus-dev", "libpulse-dev"],
        no_install_recommends=True,
    )
    .run_cmd(
        [
            "set -e;"
            " export CARGO_HOME=/var/tmp/cargo RUSTUP_HOME=/var/tmp/rustup CARGO_TARGET_DIR=/var/tmp/voxl-target CARGO_PROFILE_RELEASE_DEBUG=0; df -h /tmp /var/tmp /usr/local;"
            " curl -fsSL https://sh.rustup.rs | sh -s -- -y --no-modify-path --profile minimal --default-toolchain stable"
            " && mkdir /var/tmp/esbuild && npm install --prefix /var/tmp/esbuild esbuild@0.25.5"
            " && ESBUILD=/var/tmp/esbuild/node_modules/.bin/esbuild /var/tmp/cargo/bin/cargo install voxl-server --version 0.3.3 --locked --root /usr/local"
            " && rm -rf /var/tmp/cargo /var/tmp/rustup /var/tmp/esbuild /var/tmp/voxl-target /root/.cargo /root/.npm"
            # runtime libraries by name, then dev packages and the compilers go (no autoremove: it takes busybox, which E2B builds need)
            " && apt-get install -y --no-install-recommends libx264-164 libyuv0 libopus0 libpulse0"
            " && apt-get purge -y build-essential clang libclang-dev libxcb1-dev libx264-dev libyuv-dev libopus-dev libpulse-dev"
            " && apt-get clean && rm -rf /var/lib/apt/lists/*"
            " && voxl --version && ! ldd /usr/local/bin/voxl | grep 'not found'"
        ]
    )
    .run_cmd(
        [
            # Chromium is the browser
            "update-alternatives --set x-www-browser /usr/bin/chromium",
            "update-alternatives --set gnome-www-browser /usr/bin/chromium",
            # nothing pops up: no notification daemon or power manager autostart
            "rm -f /etc/xdg/autostart/xfce4-notifyd.desktop /etc/xdg/autostart/xfce4-power-manager.desktop /etc/xdg/autostart/xscreensaver.desktop /etc/xdg/autostart/light-locker.desktop",
            # drop background services pulled in as recommends: login manager,
            # network discovery, colour management, printing, ssh, NFS
            "apt-get purge -y $(dpkg-query -W -f='${binary:Package} ' lightdm avahi-daemon colord xiccd system-config-printer-common system-config-printer-udev cups-pk-helper openssh-server rpcbind nfs-common 2>/dev/null)",  # no autoremove: it takes busybox, which E2B builds need
            "rm -f /etc/xdg/autostart/print-applet.desktop /etc/xdg/autostart/xiccd.desktop /etc/xdg/autostart/xdg-user-dirs-kde.desktop",
            # user like dots: agent (no sudo), the shared group every agent user joins, /workspace shared through it
            "groupadd juno",
            "useradd -m -s /bin/bash -G juno agent",
            "mkdir -p /workspace /etc/chromium/policies/managed /etc/juno",
            # /etc/juno holds the platform's root-only state (routes, keys, markers)
            "chmod 0700 /etc/juno",
            "chgrp juno /workspace && chmod 2770 /workspace && setfacl -d -m g:juno:rwX /workspace",
            # Execute-only Chromium (BACKEND 8.7): the kernel marks a process whose binary the user cannot read as non-dumpable, so the
            # agent's own shell (the same Linux user as its browser) cannot ptrace it or read /proc/<pid>/mem (a securely filled value).
            "chmod 0711 /usr/lib/chromium/chromium",
            # Chromium puts page content into the accessibility tree and serves CDP inside the VM only
            "echo \x27export ACCESSIBILITY_ENABLED=1; export CHROMIUM_FLAGS=\"$CHROMIUM_FLAGS --force-renderer-accessibility --user-data-dir=/home/agent/.config/chromium-agent --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222\"\x27 > /etc/chromium.d/agent-accessibility",
        ]
    )
    .make_symlink(
        "/usr/bin/xfce4-terminal.wrapper",
        "/etc/alternatives/x-terminal-emulator",
        force=True,
    )
    # Assets ship as one deterministic bundle built by prepare_assets.py: a
    # single COPY plus a single install RUN below instead of one COPY layer
    # per asset.
    .copy_items(
        [
            CopyItem(src="sandbox-assets.tar", dest="/tmp/sandbox-assets.tar"),
        ]
    )
    # One install layer: unpack the bundle to the original paths, then run
    # the desktop-database, Dock-seed, permission and ownership fixups.
    .run_cmd(
        [
            (
                "set -e; "
                "mkdir -p " + XFCONF + " /home/agent/.config/autostart"
                " /home/agent/.config/devilspie2"
                " /usr/local/share/agent-screen-dock/launchers"
                " && tar -xpf /tmp/sandbox-assets.tar -C /"
                " && rm -f /tmp/sandbox-assets.tar"
                " && update-desktop-database /usr/share/applications/"
                " && for f in xfce4-terminal org.xfce.terminal org.xfce.mousepad"
                " libreoffice-writer libreoffice-calc libreoffice-impress;"
                " do cp -f /usr/share/applications/$f.desktop"
                " /usr/local/share/agent-screen-dock/launchers/$f.desktop 2>/dev/null || true; done"
                " && cp /usr/local/share/agent-screen-dock/agent-screen-dock"
                " /usr/local/bin/agent-screen-dock"
                " && chmod 0755 /usr/local/bin/agent-screen-dock"
                " && chmod 0755 /usr/local/bin/agent-browser /usr/local/bin/agent-meet /usr/local/bin/juno-app-open"
                " && for i in 1:chromium 2:xfce4-terminal 3:org.xfce.mousepad"
                " 4:libreoffice-writer 5:libreoffice-calc 6:libreoffice-impress;"
                " do n=${i%%:*}; f=${i#*:}.desktop;"
                " mkdir -p /home/agent/.config/xfce4/panel/launcher-$n;"
                " cp /usr/share/applications/$f /home/agent/.config/xfce4/panel/launcher-$n/$f; done"
                " && chown -R agent:agent /home/agent && chown -R agent:juno /workspace"
                " && chmod -R g+rwX /workspace"
            )
        ]
    )
    # Platform skills' Python libraries, pinned in the bundle's requirements file: installed at image build time, never at run time.
    .run_cmd(
        [
            "python3 -m venv /opt/juno/venv"
            " && /opt/juno/venv/bin/pip install --no-cache-dir -r /opt/juno/skills/_lib/requirements.txt"
        ]
    )
    # Spaces (BACKEND 5.12): the official Bun binary (version and checksums pinned in the script, which is the one place
    # that knows them) at /usr/local/bin/bun, and the app template's dependencies in the shared /opt/juno/bun-cache, so
    # `bun install --frozen-lockfile --offline` works without network when an agent creates an app.
    .run_cmd(["sh /opt/juno/spaces/install-runtime.sh"])
    # Durable storage (BACKEND 7.10): the pinned JuiceFS client (version and checksums live in the script).
    .run_cmd(["sh /opt/juno/storage/install-juicefs.sh"])
    # Original jev-browser MCP (explicit opt-in): pinned upstream plus locked deps, Node runtime.
    .run_cmd(["sh /opt/juno/jev-browser/install-jev-browser.sh"])
    # Web & video apps (BACKEND 10.18): Agent Reach at one pinned commit and bilibili-cli 0.6.2 with their own pinned dependencies.
    # /usr/local/bin/agent-reach passes only the read actions through, so nothing is installed or updated at run time.
    .run_cmd(["sh /opt/juno/reach/install-reach.sh"])
    # Web & video apps, login channels (BACKEND 10.18): OpenCLI at one pinned version, reading the agent's own Chromium over CDP.
    .run_cmd(["sh /opt/juno/reach/install-opencli.sh"])
)

# No start command: E2B runs it as the template user ("agent"), but the daemon needs root, so computerd starts /usr/local/bin/juno-link
# as root right after create (e2b-driver.ts). Everything else the platform does in the computer goes through that daemon (BACKEND 7.11).
template_with_user_workdir = template.set_user("agent").set_workdir("/workspace")
