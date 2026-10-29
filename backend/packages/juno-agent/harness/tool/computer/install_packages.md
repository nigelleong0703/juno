---
id: tool.computer.install_packages
placement: T
vars: []
---
Install system packages (Debian apt names, e.g. "ffmpeg", "libreoffice-calc") on this computer. You have no sudo, so this is the only way to add system software; the user approves every call, so say in `reason` what you need them for. For Python and Node libraries use pip install --user, npm with the default user prefix or uv in a shell instead; they need no tool.
