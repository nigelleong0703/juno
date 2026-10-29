#!/usr/bin/env node
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(desktop, "chrome-extension");
const vendor = join(desktop, "vendor");
const hostOutput = join(vendor, "chrome-bridge", "juno-chrome-host");
const extensionOutput = join(vendor, "chrome-extension");
function findBun() {
  const candidates = [process.env.BUN, ...String(process.env.PATH ?? "").split(process.platform === "win32" ? ";" : ":").map((entry) => join(entry, process.platform === "win32" ? "bun.exe" : "bun"))].filter(Boolean);
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  throw new Error("Bun is required; install it or set BUN to its executable path");
}
const bun = findBun();

const manifest = JSON.parse(readFileSync(join(source, "extension", "manifest.json"), "utf8"));
const publicKey = Buffer.from(String(manifest.key), "base64");
const extensionId = createHash("sha256")
  .update(publicKey)
  .digest("hex")
  .slice(0, 32)
  .replace(/[0-9a-f]/g, (digit) => String.fromCharCode(97 + Number.parseInt(digit, 16)));
if (extensionId !== "kbfjckdecckcdjaokfiphfipdpenodoj") {
  throw new Error(`manifest key produces ${extensionId}, expected the fixed Juno extension id`);
}

function run(args) {
  const result = spawnSync(bun, args, { cwd: desktop, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Bun build failed with status ${String(result.status)}`);
}

function cleanBunTempFiles() {
  for (const name of readdirSync(desktop)) {
    if (/^\.[0-9a-f]+-00000000\.bun-build$/.test(name)) unlinkSync(join(desktop, name));
  }
}

process.on("exit", cleanBunTempFiles);

const platform = process.platform === "darwin" ? "darwin" : process.platform === "linux" ? "linux" : undefined;
const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : undefined;
if (!platform || !arch) throw new Error(`Chrome bridge host build is unsupported on ${process.platform}/${process.arch}`);

rmSync(join(vendor, "chrome-bridge"), { recursive: true, force: true });
rmSync(extensionOutput, { recursive: true, force: true });
mkdirSync(dirname(hostOutput), { recursive: true });
mkdirSync(extensionOutput, { recursive: true });

run([
  "build",
  join(source, "native-host.ts"),
  "--compile",
  "--minify",
  `--target=bun-${platform}-${arch}`,
  `--outfile=${hostOutput}`,
]);

for (const [entry, output] of [
  ["service-worker.js", "service-worker.js"],
  ["popup.js", "popup.js"],
]) {
  run([
    "build",
    join(source, "extension", entry),
    "--target=browser",
    "--format=esm",
    "--minify",
    "--sourcemap=none",
    `--outfile=${join(extensionOutput, output)}`,
  ]);
}

for (const file of ["manifest.json", "popup.html", "popup.css"]) {
  cpSync(join(source, "extension", file), join(extensionOutput, file));
}
cpSync(join(source, "README.md"), join(extensionOutput, "README.md"));

// The copied manifest stays byte-for-byte valid JSON; the JS entries are already minified above.
writeFileSync(join(extensionOutput, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

process.stdout.write(`extension: ${extensionOutput}\nnative host: ${hostOutput}\nextension id: ${extensionId}\n`);
