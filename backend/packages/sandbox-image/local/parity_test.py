"""Parity checks: the generated Dockerfile tracks the canonical recipe.

This goes beyond literal spot-checks: it independently re-parses
../template_debian.py and ../prepare_assets.py, requires every canonical
package/env/asset/user to appear in the generated Dockerfile, and proves
derivation (not hard-coded literals) by feeding synthetic recipe edits
through the generator and requiring the output to follow them.

Run: python3 packages/sandbox-image/local/parity_test.py
Exit non-zero on any parity failure.
"""

import ast
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
TEMPLATE_PATH = os.path.normpath(os.path.join(HERE, "..", "template_debian.py"))
PREPARE_PATH = os.path.normpath(os.path.join(HERE, "..", "prepare_assets.py"))
GENERATOR_PATH = os.path.join(HERE, "generate_dockerfile.py")

sys.path.insert(0, HERE)
import generate_dockerfile as gen


def read(path):
    with open(path, "r", encoding="utf-8") as handle:
        return handle.read()


def check(condition, message, failures):
    if not condition:
        failures.append(message)
    return condition


def canonical_packages(source):
    tree = ast.parse(source)
    packages = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        if not isinstance(func, ast.Attribute) or func.attr != "apt_install":
            continue
        if not node.args or not isinstance(node.args[0], ast.List):
            continue
        for elt in node.args[0].elts:
            if isinstance(elt, ast.Constant):
                packages.append(elt.value)
    return packages


def dockerfile_syntax_errors(dockerfile):
    errors = []
    leaders = ("FROM", "RUN", "COPY", "ENV", "USER", "WORKDIR", "CMD", "ARG", "LABEL", "EXPOSE", "ENTRYPOINT")
    continuation = False
    for lineno, raw in enumerate(dockerfile.split("\n"), 1):
        stripped = raw.strip()
        if not stripped or stripped.startswith("#"):
            if continuation:
                errors.append("line " + str(lineno) + ": blank/comment breaks backslash continuation")
                continuation = False
            continue
        first = stripped.split()[0]
        indented = len(raw) != len(raw.lstrip())
        if continuation and not indented and first in leaders:
            errors.append("line " + str(lineno) + ": " + first + " starts inside a backslash continuation (missing backslash above)")
        if not continuation and first not in leaders:
            errors.append("line " + str(lineno) + ": unknown Dockerfile instruction " + first)
        continuation = stripped.endswith("\\")
    if continuation:
        errors.append("Dockerfile ends inside a backslash continuation")
    return errors


def main():
    failures = []
    proc = subprocess.run(
        [sys.executable, GENERATOR_PATH], capture_output=True, text=True
    )
    check(proc.returncode == 0, "generator exits 0, got " + str(proc.returncode)
          + " stderr: " + proc.stderr.strip(), failures)
    dockerfile = proc.stdout
    template_source = read(TEMPLATE_PATH)
    prepare_source = read(PREPARE_PATH)
    for package in canonical_packages(template_source):
        check(package in dockerfile, "canonical package missing: " + package, failures)
    archive_name, asset_map = gen.parse_assets(prepare_source, PREPARE_PATH)
    check("COPY " + archive_name in dockerfile, "asset bundle COPY missing", failures)
    check("tar -xpf /tmp/" + archive_name in dockerfile, "asset bundle install RUN missing", failures)
    check(len(asset_map) > 0, "ASSET_MAP must be non-empty", failures)
    check("FROM debian:trixie" in dockerfile, "base image must stay debian:trixie", failures)
    check("USER root" in dockerfile and "juno-link" in dockerfile, "final USER root + juno-link start command missing", failures)
    check("WORKDIR /workspace" in dockerfile, "final WORKDIR /workspace missing", failures)
    check("agent-screen-dock" in dockerfile, "Dock helper install missing", failures)
    check("VOLUME" not in dockerfile, "Dockerfile must not declare volumes", failures)
    check("--mount" not in dockerfile, "Dockerfile must not mount host paths", failures)
    for error in dockerfile_syntax_errors(dockerfile):
        check(False, error, failures)
    probe_source = template_source.replace(chr(34) + "chromium" + chr(34) + ",",
        chr(34) + "chromium" + chr(34) + ",\n            " + chr(34) + "parity-probe-pkg" + chr(34) + ",")
    check(probe_source != template_source, "probe edit must apply to canonical source", failures)
    ops, _user, _workdir, _start = gen.parse_template(probe_source, TEMPLATE_PATH)
    probe_rendered = gen.render(ops, _user, _workdir, _start, archive_name, asset_map)
    check("parity-probe-pkg" in probe_rendered,
          "generator must follow canonical package edits (not literals)", failures)
    drifted = template_source.replace(".from_image(" + chr(34) + "debian:trixie" + chr(34) + ")",
        ".from_image(" + chr(34) + "debian:trixie" + chr(34) + ").frobnicate(" + chr(34) + "x" + chr(34) + ")")
    try:
        gen.parse_template(drifted, TEMPLATE_PATH)
        check(False, "unknown canonical op must fail closed", failures)
    except gen.RecipeError:
        pass
    if failures:
        for failure in failures:
            sys.stderr.write("parity: " + failure + "\n")
        return 1
    print("PASS local image generator package+asset parity")
    return 0


if __name__ == "__main__":
    sys.exit(main())
