"""Generate a local Dockerfile from the canonical E2B desktop recipe.

The Docker Desktop image (linux/arm64, no second physical Linux machine) must
match the remote E2B Debian 13 / Chromium / XFCE / Dock / Office environment
without a second hand-maintained package/theme/asset recipe. This script is
the single translation point: it AST-parses ../template_debian.py (never
imports the e2b package) and the ASSET_MAP in ../prepare_assets.py, then
prints a Dockerfile to stdout:

    python3 packages/sandbox-image/local/generate_dockerfile.py

Unknown Template chain calls fail closed (non-zero exit), so a canonical
recipe update using a new operation can never silently drift from the local
image: the generator must learn the operation first. build.sh places the
canonical sandbox-assets.tar (built by prepare_assets.py) next to the
generated Dockerfile in a disposable build context.
"""

import ast
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
TEMPLATE_PATH = os.path.normpath(os.path.join(HERE, "..", "template_debian.py"))
PREPARE_PATH = os.path.normpath(os.path.join(HERE, "..", "prepare_assets.py"))

KNOWN_OPS = frozenset(
    [
        "from_image",
        "set_user",
        "set_workdir",
        "set_envs",
        "set_start_cmd",
        "apt_install",
        "git_clone",
        "make_symlink",
        "run_cmd",
        "copy_items",
    ]
)


class RecipeError(Exception):
    """Fail-closed parse error: canonical recipe outgrew the generator."""


def fail(message):
    raise RecipeError(message)


def const_str(node, constants, what):
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    if isinstance(node, ast.Name) and node.id in constants:
        return constants[node.id]
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
        left = const_str(node.left, constants, what)
        right = const_str(node.right, constants, what)
        return left + right
    lineno = getattr(node, "lineno", "?")
    fail("cannot resolve " + what + " expression at line " + str(lineno))
    return ""


def str_list(node, constants, what):
    if not isinstance(node, ast.List):
        fail(what + " must be a list literal")
    return [const_str(elt, constants, what) for elt in node.elts]


def str_dict(node, constants, what):
    if not isinstance(node, ast.Dict):
        fail(what + " must be a dict literal")
    out = {}
    for key, value in zip(node.keys, node.values):
        out[const_str(key, constants, what)] = const_str(value, constants, what)
    return out


def const_bool(node, name, default=False):
    if node is None:
        return default
    if isinstance(node, ast.Constant) and isinstance(node.value, bool):
        return node.value
    fail("keyword " + name + " must be a bool literal")
    return default


def kwargs_of(call):
    out = {}
    for keyword in call.keywords:
        out[keyword.arg] = keyword.value
    return out


def collect_chain(value, label):
    ops = []
    node = value
    while isinstance(node, ast.Call):
        func = node.func
        if not isinstance(func, ast.Attribute):
            break
        if func.attr not in KNOWN_OPS:
            fail("unknown canonical operation ." + func.attr + " in " + label
                 + "; generator must learn it first")
        ops.append(node)
        node = func.value
    ops.reverse()
    return ops, node


def parse_simple(call, constants, method):
    kwargs = kwargs_of(call)
    if len(call.args) != 1 or kwargs:
        fail("." + method + " takes exactly one positional string")
    return {"method": method, "value": const_str(call.args[0], constants, method)}


def parse_op(call, constants):
    method = call.func.attr
    if method in ("from_image", "set_user", "set_workdir"):
        return parse_simple(call, constants, method)
    if method == "set_start_cmd":
        if len(call.args) != 2:
            fail(".set_start_cmd takes (start command, ready command)")
        return {"method": method, "value": const_str(call.args[0], constants, method)}
    if method == "set_envs":
        kwargs = kwargs_of(call)
        if len(call.args) != 1 or kwargs:
            fail(".set_envs takes exactly one dict")
        envs = str_dict(call.args[0], constants, "set_envs")
        return {"method": method, "envs": envs}
    if method == "apt_install":
        return parse_apt(call, constants)
    if method == "git_clone":
        return parse_clone(call, constants)
    if method == "make_symlink":
        return parse_symlink(call, constants)
    if method == "run_cmd":
        kwargs = kwargs_of(call)
        if len(call.args) != 1 or kwargs:
            fail(".run_cmd takes exactly one command list")
        commands = str_list(call.args[0], constants, "run_cmd")
        if not commands:
            fail(".run_cmd list must not be empty")
        return {"method": method, "commands": commands}
    if method == "copy_items":
        return parse_copy(call, constants)
    fail("unhandled canonical operation ." + method)
    return {"method": method}


def parse_apt(call, constants):
    kwargs = kwargs_of(call)
    if len(call.args) != 1:
        fail(".apt_install takes exactly one package list")
    for name in kwargs:
        if name != "no_install_recommends":
            fail("unknown .apt_install keyword " + name)
    flag_node = kwargs.get("no_install_recommends")
    return {
        "method": "apt_install",
        "packages": str_list(call.args[0], constants, "apt_install"),
        "no_recommends": const_bool(flag_node, "no_install_recommends"),
    }


def parse_clone(call, constants):
    kwargs = kwargs_of(call)
    if len(call.args) != 2:
        fail(".git_clone takes (url, dest)")
    for name in kwargs:
        if name != "branch":
            fail("unknown .git_clone keyword " + name)
    branch = kwargs.get("branch")
    resolved = None
    if branch is not None:
        resolved = const_str(branch, constants, "git_clone branch")
    return {
        "method": "git_clone",
        "url": const_str(call.args[0], constants, "git_clone url"),
        "dest": const_str(call.args[1], constants, "git_clone dest"),
        "branch": resolved,
    }


def parse_symlink(call, constants):
    kwargs = kwargs_of(call)
    if len(call.args) != 2:
        fail(".make_symlink takes (target, link)")
    for name in kwargs:
        if name != "force":
            fail("unknown .make_symlink keyword " + name)
    return {
        "method": "make_symlink",
        "target": const_str(call.args[0], constants, "make_symlink target"),
        "link": const_str(call.args[1], constants, "make_symlink link"),
        "force": const_bool(kwargs.get("force"), "force"),
    }


def parse_copy(call, constants):
    kwargs = kwargs_of(call)
    if len(call.args) != 1 or kwargs:
        fail(".copy_items takes exactly one item list")
    items_node = call.args[0]
    if not isinstance(items_node, ast.List):
        fail(".copy_items argument must be a list literal")
    items = []
    for item in items_node.elts:
        items.append(parse_copy_item(item, constants))
    if not items:
        fail(".copy_items list must not be empty")
    return {"method": "copy_items", "items": items}


def parse_copy_item(item, constants):
    if not isinstance(item, ast.Call):
        fail(".copy_items entries must be CopyItem(src=..., dest=...)")
    func = item.func
    if not isinstance(func, ast.Name) or func.id != "CopyItem":
        fail(".copy_items entries must be CopyItem(src=..., dest=...)")
    item_kwargs = kwargs_of(item)
    if set(item_kwargs) != {"src", "dest"}:
        fail("CopyItem needs exactly src= and dest=")
    return {
        "src": const_str(item_kwargs["src"], constants, "CopyItem src"),
        "dest": const_str(item_kwargs["dest"], constants, "CopyItem dest"),
    }


def parse_template(source, filename):
    tree = ast.parse(source, filename=filename)
    constants = {}
    template_value = None
    final_value = None
    for node in tree.body:
        if not isinstance(node, ast.Assign):
            continue
        if len(node.targets) != 1 or not isinstance(node.targets[0], ast.Name):
            continue
        name = node.targets[0].id
        if name == "template":
            template_value = node.value
            continue
        if name == "template_with_user_workdir":
            final_value = node.value
            continue
        try:
            constants[name] = const_str(node.value, constants, name)
        except RecipeError:
            continue
    if template_value is None:
        fail("canonical recipe has no template = ... assignment")
    if final_value is None:
        fail("canonical recipe has no template_with_user_workdir = ... assignment")
    ops, base = collect_chain(template_value, "template")
    if not isinstance(base, ast.Call):
        fail("template chain must start from Template(...)")
    if not isinstance(base.func, ast.Name) or base.func.id != "Template":
        fail("template chain must start from Template(...)")
    if not ops or ops[0].func.attr != "from_image":
        fail("template chain must start with .from_image(...)")
    parsed = [parse_op(op, constants) for op in ops]
    final_user, final_workdir, start_cmd = parse_final(final_value, constants)
    return parsed, final_user, final_workdir, start_cmd


def parse_final(value, constants):
    final_ops, final_base = collect_chain(value, "template_with_user_workdir")
    if not isinstance(final_base, ast.Name) or final_base.id != "template":
        fail("template_with_user_workdir must extend template")
    final_user = None
    final_workdir = None
    start_cmd = None
    for op in final_ops:
        method = op.func.attr
        if method not in ("set_user", "set_workdir", "set_start_cmd"):
            fail("template_with_user_workdir supports only .set_user/.set_workdir/.set_start_cmd, found ." + method)
        parsed_op = parse_op(op, constants)
        if method == "set_user":
            final_user = parsed_op["value"]
        elif method == "set_workdir":
            final_workdir = parsed_op["value"]
        else:
            start_cmd = parsed_op["value"]
    if final_user is None or final_workdir is None:
        fail("template_with_user_workdir must set both user and workdir")
    if start_cmd is None:
        fail("template_with_user_workdir must set the start command (juno-link)")
    return final_user, final_workdir, start_cmd


def parse_assets(source, filename):
    tree = ast.parse(source, filename=filename)
    archive_name = None
    asset_map = None
    for node in tree.body:
        if not isinstance(node, ast.Assign):
            continue
        if len(node.targets) != 1 or not isinstance(node.targets[0], ast.Name):
            continue
        name = node.targets[0].id
        if name == "ARCHIVE_FILENAME" and isinstance(node.value, ast.Constant):
            archive_name = node.value.value
        if name == "ASSET_MAP" and isinstance(node.value, ast.List):
            asset_map = parse_asset_entries(node.value)
    if not archive_name:
        fail("prepare_assets.py has no ARCHIVE_FILENAME literal")
    if not asset_map:
        fail("prepare_assets.py has an empty ASSET_MAP")
    return archive_name, asset_map


def parse_asset_entries(items_node):
    entries = []
    for elt in items_node.elts:
        if not isinstance(elt, ast.Tuple) or len(elt.elts) != 2:
            fail("ASSET_MAP entries must be (src, dest) pairs")
        src = elt.elts[0]
        dest = elt.elts[1]
        if not isinstance(src, ast.Constant) or not isinstance(dest, ast.Constant):
            fail("ASSET_MAP entries must be string literals")
        entries.append((src.value, dest.value))
    return entries


def render(ops, final_user, final_workdir, start_cmd, archive_name, asset_map):
    lines = []
    lines.append("# Generated from packages/sandbox-image/template_debian.py + prepare_assets.py.")
    lines.append("# Do not hand-edit: rerun local/generate_dockerfile.py after canonical changes.")
    lines.append("# Canonical asset bundle: " + archive_name + " holds "
                 + str(len(asset_map)) + " assets per prepare_assets.py ASSET_MAP.")
    for op in ops:
        render_op(lines, op)
    # The daemon is root's (BACKEND 7.11): E2B runs the start command as root while commands default to final_user; Docker has one
    # user per container, so the image starts as root and the platform never uses `docker exec` (juno-link serves everything).
    lines.append("# juno-link is the container's main process: it runs as root, dials computerd, and no port is published.")
    lines.append("USER root")
    lines.append("WORKDIR " + final_workdir)
    lines.append("CMD [\"" + start_cmd + "\"]")
    return "\n".join(lines) + "\n"


def render_op(lines, op):
    method = op["method"]
    if method == "from_image":
        lines.append("FROM " + op["value"])
        return
    if method == "set_user":
        lines.append("USER " + op["value"])
        return
    if method == "set_workdir":
        lines.append("WORKDIR " + op["value"])
        return
    if method == "set_envs":
        for key in sorted(op["envs"]):
            lines.append("ENV " + key + "=" + op["envs"][key])
        return
    if method == "apt_install":
        render_apt(lines, op)
        return
    if method == "git_clone":
        render_clone(lines, op)
        return
    if method == "make_symlink":
        flag = "f" if op["force"] else ""
        lines.append("RUN ln -s" + flag + " " + op["target"] + " " + op["link"])
        return
    if method == "run_cmd":
        for command in op["commands"]:
            if "\n" in command:
                fail("run_cmd entries must be single-line for Dockerfile continuations")
        joiner = " && \\" + "\n" + "    "
        lines.append("RUN " + joiner.join(op["commands"]))
        return
    if method == "copy_items":
        for item in op["items"]:
            lines.append("COPY " + item["src"] + " " + item["dest"])
        return
    fail("unhandled canonical operation ." + method)


def render_apt(lines, op):
    flag = ""
    if op["no_recommends"]:
        flag = " --no-install-recommends"
    lines.append("RUN apt-get update && apt-get install -y" + flag + " "
                 + " ".join(op["packages"])
                 + " && rm -rf /var/lib/apt/lists/*")


def render_clone(lines, op):
    if op["branch"] is not None:
        lines.append("RUN git clone --branch " + op["branch"] + " --depth 1 "
                     + op["url"] + " " + op["dest"])
        return
    lines.append("RUN git clone --depth 1 " + op["url"] + " " + op["dest"])


def generate(template_path=TEMPLATE_PATH, prepare_path=PREPARE_PATH):
    with open(template_path, "r", encoding="utf-8") as handle:
        template_source = handle.read()
    with open(prepare_path, "r", encoding="utf-8") as handle:
        prepare_source = handle.read()
    ops, final_user, final_workdir, start_cmd = parse_template(template_source, template_path)
    archive_name, asset_map = parse_assets(prepare_source, prepare_path)
    copies = [op for op in ops if op["method"] == "copy_items"]
    if len(copies) != 1 or len(copies[0]["items"]) != 1:
        fail("canonical recipe must copy exactly one asset bundle; "
             + "generator must learn the new layout first")
    bundle = copies[0]["items"][0]
    if bundle["src"] != archive_name:
        fail("recipe bundle src " + bundle["src"]
             + " != prepare_assets.py ARCHIVE_FILENAME " + archive_name)
    return render(ops, final_user, final_workdir, start_cmd, archive_name, asset_map)


def main():
    try:
        sys.stdout.write(generate())
    except RecipeError as exc:
        sys.stderr.write("generate_dockerfile.py: " + str(exc) + "\n")
        return 1
    except OSError as exc:
        sys.stderr.write("generate_dockerfile.py: cannot read canonical source: " + str(exc) + "\n")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
