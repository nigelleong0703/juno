// Vendors cua-driver (MIT, Cua AI, Inc.) into vendor/cua-driver for the app bundle (electron-builder extraResources).
// Not in git: downloaded at build time from the pinned release, checked (sha256, Cua's signature), reduced to the arm64
// slice (dist:mac builds arm64 only), and copied with the license and third-party notices the release ships.
// The binaries are re-signed with Juno's identity by electron-builder when it signs the app (see electron-builder.yml).
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = "0.37.0";
const ARCHIVE = `cua-driver-rs-${VERSION}-darwin-arm64.tar.gz`;
const URL = `https://github.com/trycua/cua/releases/download/cua-driver-rs-v${VERSION}/${ARCHIVE}`;
const SHA256 = "1e9b8c58cc830e080ada881ec76286529f5f1264fe9ecc371b0ae95cff98928b";
const TEAM = "YCK386LBJ7";
const BINARIES = ["cua-driver", "cua-cursor-theme"];
const NOTICES = ["LICENSE", "THIRD_PARTY_NOTICES.md"];

const desktop = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(desktop, "vendor", "cua-driver");
const cache = join(desktop, "vendor", ".cache");
const stamp = join(out, "VERSION");

if (process.platform !== "darwin") {
  console.log("cua-driver: macOS only, skipped");
  process.exit(0);
}
if (existsSync(stamp) && readFileSync(stamp, "utf8").trim() === VERSION && existsSync(join(out, "cua-driver"))) {
  console.log(`cua-driver ${VERSION}: already vendored`);
  process.exit(0);
}

const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

mkdirSync(cache, { recursive: true });
const archive = join(cache, ARCHIVE);
if (!existsSync(archive) || sha256(archive) !== SHA256) {
  const response = await fetch(URL);
  if (!response.ok) throw new Error(`${URL}: HTTP ${response.status}`);
  writeFileSync(archive, Buffer.from(await response.arrayBuffer()));
  if (sha256(archive) !== SHA256) throw new Error(`${URL}: sha256 mismatch`);
}

const expanded = join(cache, `cua-driver-${VERSION}`);
rmSync(expanded, { recursive: true, force: true });
mkdirSync(expanded, { recursive: true });
execFileSync("tar", ["-xzf", archive, "-C", expanded, "--strip-components=1"], { stdio: "inherit" });

for (const name of BINARIES) {
  execFileSync("codesign", ["--verify", "--strict", join(expanded, name)], { stdio: "inherit" });
  // codesign prints its details on stderr.
  const details = spawnSync("codesign", ["-dv", join(expanded, name)], { encoding: "utf8" }).stderr;
  if (!details.includes(`TeamIdentifier=${TEAM}`)) throw new Error(`${name} is not signed by Cua's team ${TEAM}`);
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const name of BINARIES) {
  // arm64 only: the signature is gone after this, which is fine because the app's signing step signs it again.
  const target = join(out, name);
  execFileSync("lipo", [join(expanded, name), "-thin", "arm64", "-output", target], { stdio: "inherit" });
  chmodSync(target, 0o755);
}
for (const name of NOTICES) copyFileSync(join(expanded, name), join(out, name));
rmSync(expanded, { recursive: true, force: true });
writeFileSync(stamp, `${VERSION}\n`);
console.log(`cua-driver ${VERSION}: vendored into ${out}`);
