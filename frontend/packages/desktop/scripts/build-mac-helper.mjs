#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = join(desktopDir, "native", "JunoMacHelper");
const vendorDir = join(desktopDir, "vendor", "mac-helper");
const appBundle = join(vendorDir, "JunoMacHelper.app");
const contentsDir = join(appBundle, "Contents");
const executable = join(contentsDir, "MacOS", "juno-mac-helper");
const commandPath = join(vendorDir, "juno-mac-helper");
const swiftc = "/usr/bin/swiftc";

if (process.platform !== "darwin") {
  process.stdout.write("juno mac helper: skipped (macOS only)\n");
  process.exit(0);
}
if (!existsSync(swiftc)) {
  throw new Error(`Swift compiler not found at ${swiftc}`);
}

rmSync(vendorDir, { recursive: true, force: true });
mkdirSync(join(contentsDir, "MacOS"), { recursive: true });

try {
  execFileSync(swiftc, [
    "-swift-version", "5",
    "-O",
    "-parse-as-library",
    "-target", `${process.arch === "arm64" ? "arm64" : "x86_64"}-apple-macos13.0`,
    join(sourceDir, "JunoMacHelper.swift"),
    "-o", executable,
    "-framework", "AppKit",
    "-framework", "ApplicationServices",
    "-framework", "AVFoundation",
    "-framework", "CoreMedia",
    "-framework", "ScreenCaptureKit",
  ], { stdio: "inherit" });

  copyFileSync(join(sourceDir, "Info.plist"), join(contentsDir, "Info.plist"));
  chmodSync(executable, 0o755);

  // Ad-hoc signing is the local-development state. Distribution must sign this bundle with the
  // Juno app's Developer ID and notarize it with the parent app; no entitlement is needed for TCC.
  execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", appBundle], { stdio: "inherit" });
  execFileSync("/usr/bin/codesign", ["--verify", "--strict", appBundle], { stdio: "inherit" });

  symlinkSync(relative(vendorDir, executable), commandPath);
  execFileSync("/usr/bin/codesign", ["--verify", "--strict", commandPath], { stdio: "inherit" });
} catch (error) {
  rmSync(vendorDir, { recursive: true, force: true });
  throw error;
}

process.stdout.write(`${commandPath}\n`);
