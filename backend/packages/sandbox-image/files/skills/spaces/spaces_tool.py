#!/usr/bin/python3
"""Helpers for building an app (a "space") in /workspace/spaces/<slug>.

  spaces_tool.py new SLUG [--template app|static]   copy a template and install its dependencies (offline)
  spaces_tool.py port SLUG                          print the port the platform allocated (written by space_publish)
  spaces_tool.py build SLUG                         build the client of an `app`
  spaces_tool.py start SLUG                         run the app in the foreground on its port (start it as a background process)
  spaces_tool.py dev SLUG                           like start, but restarts when server files change

The platform allocates the port when you call space_publish; there is nothing to configure here and no credential in this computer.
"""
import argparse
import os
import re
import shutil
import subprocess
import sys

SPACES_DIR = "/workspace/spaces"
TEMPLATES = os.path.join(os.path.dirname(os.path.abspath(__file__)), "templates")
BUN_CACHE_SEED = "/opt/juno/bun-cache"  # filled at image build; read-only for agents
BUN_CACHE = os.path.join(os.path.expanduser("~"), ".bun", "install", "cache")
SLUG = re.compile(r"^[a-z0-9][a-z0-9-]{0,40}$")


def die(message):
    print("error: " + message, file=sys.stderr)
    sys.exit(1)


def app_dir(slug):
    if not SLUG.match(slug):
        die("slug must be lower-case letters, digits and dashes (at most 41 characters)")
    path = os.path.join(SPACES_DIR, slug)
    if not os.path.isdir(path):
        die(path + " does not exist; create it with: spaces_tool.py new " + slug)
    return path


def seed_cache():
    """Bun writes to its cache while installing, so each agent gets its own copy of the preinstalled one (once, about a second)."""
    if os.path.isdir(BUN_CACHE) and os.listdir(BUN_CACHE):
        return
    os.makedirs(os.path.dirname(BUN_CACHE), exist_ok=True)
    shutil.copytree(BUN_CACHE_SEED, BUN_CACHE, dirs_exist_ok=True)


def bun(args, cwd, replace=False, **extra_env):
    env = {**os.environ, **extra_env}
    if replace:
        os.chdir(cwd)
        os.execvpe("bun", ["bun"] + args, env)
    result = subprocess.run(["bun"] + args, cwd=cwd, env=env)
    if result.returncode != 0:
        die("bun " + " ".join(args) + " failed with exit code " + str(result.returncode))


def read_port(path):
    try:
        with open(os.path.join(path, ".juno-port"), encoding="utf-8") as handle:
            port = int(handle.read().strip())
    except (OSError, ValueError):
        die("no port yet: call space_publish {path: \"" + path + "\", title: ...} once; it allocates a port and writes .juno-port")
    return port


def cmd_new(args):
    if not SLUG.match(args.slug):
        die("slug must be lower-case letters, digits and dashes (at most 41 characters)")
    dest = os.path.join(SPACES_DIR, args.slug)
    if os.path.exists(dest):
        die(dest + " already exists")
    os.makedirs(SPACES_DIR, exist_ok=True)
    shutil.copytree(os.path.join(TEMPLATES, args.template), dest, ignore=shutil.ignore_patterns("node_modules", "dist", "data"))
    if args.template == "app":
        seed_cache()
        bun(["install", "--frozen-lockfile", "--offline"], dest)
    print("created " + dest + " from the " + args.template + " template")
    print("next: edit it, " + ("run `spaces_tool.py build " + args.slug + "`, " if args.template == "app" else "") + "call space_publish to get a port, start it with `spaces_tool.py start " + args.slug + "` as a background process, then call space_publish again")


def cmd_port(args):
    print(read_port(app_dir(args.slug)))


def cmd_build(args):
    path = app_dir(args.slug)
    if os.path.exists(os.path.join(path, "node_modules")):
        bun(["run", "build"], path)
    else:
        print("nothing to build (static app)")


def cmd_start(args, watch=False):
    path = app_dir(args.slug)
    port = read_port(path)
    bun((["--watch"] if watch else []) + ["run", "server.ts"], path, replace=True, PORT=str(port))


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    new = sub.add_parser("new")
    new.add_argument("slug")
    new.add_argument("--template", choices=["app", "static"], default="app")
    new.set_defaults(run=cmd_new)
    for name, run in (("port", cmd_port), ("build", cmd_build), ("start", cmd_start), ("dev", lambda a: cmd_start(a, watch=True))):
        command = sub.add_parser(name)
        command.add_argument("slug")
        command.set_defaults(run=run)
    args = parser.parse_args()
    args.run(args)


if __name__ == "__main__":
    main()
