import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { APP_ORIGIN, APP_URL, isAssetPathConfined, mimeForPath, resolveAssetPath } from "./asset-protocol";

const ROOT = resolve("/packaged/renderer");
const at = (path: string): string => resolve(ROOT, path);

describe("resolveAssetPath", () => {
  it("serves the document root and keeps query/fragment out of the mapping", () => {
    expect(resolveAssetPath(ROOT, APP_ORIGIN + "/")).toBe(at("index.html"));
    expect(resolveAssetPath(ROOT, APP_URL)).toBe(at("index.html"));
    expect(resolveAssetPath(ROOT, APP_ORIGIN + "/index.html?x=../..#/../y")).toBe(at("index.html"));
    expect(resolveAssetPath(ROOT, APP_ORIGIN + "/assets/index-abc123.js")).toBe(
      at("assets/index-abc123.js"),
    );
    expect(resolveAssetPath(ROOT, APP_ORIGIN + "/assets/")).toBe(at("assets/index.html"));
  });

  it("binds the host and scheme: subdomains, lookalikes and remote URLs are refused", () => {
    const refused = [
      APP_ORIGIN.replace("app", "evil") + "/index.html",
      "electron://app.evil.example/index.html",
      "electron://evilapp/index.html",
      "https://app/index.html",
      "file:///packaged/renderer/index.html",
      "https://evil.example/electron://app/index.html",
      "not a url",
      "",
    ];
    for (const requestUrl of refused) {
      expect(resolveAssetPath(ROOT, requestUrl)).toBeNull();
    }
  });

  it("refuses credentials and ports on the app URL", () => {
    expect(resolveAssetPath(ROOT, "electron://user@app/index.html")).toBeNull();
    expect(resolveAssetPath(ROOT, "electron://user:pw@app/index.html")).toBeNull();
  });

  it("rejects raw, encoded and doubly encoded traversal", () => {
    const attacks = [
      "/../secret.txt",
      "/assets/../../secret.txt",
      "/%2e%2e/secret.txt",
      "/%2E%2E/secret.txt",
      "/%2e%2e%2fsecret.txt",
      "/assets/%2e%2e/%2e%2e/secret.txt",
      "/%252e%252e/secret.txt",
      "/%25252e%25252e/secret.txt",
      "/assets/%252e%252e/%252e%252e/secret.txt",
    ];
    for (const path of attacks) {
      expect(resolveAssetPath(ROOT, APP_ORIGIN + path)).toBeNull();
    }
  });

  it("rejects backslash escapes and null bytes", () => {
    const attacks = ["/..%5csecret.txt", "/..%5Csecret.txt", "/%00", "/index.html%00"]; 
    for (const path of attacks) {
      expect(resolveAssetPath(ROOT, APP_ORIGIN + path)).toBeNull();
    }
    expect(resolveAssetPath(ROOT, APP_ORIGIN + "/%zz")).toBeNull();
  });

  it("never resolves outside the renderer root", () => {
    const outside = resolve(ROOT, "..", "secret.txt");
    expect(outside.startsWith(ROOT)).toBe(false);
  });
});

describe("mimeForPath", () => {
  it("labels document, script, style and font assets", () => {
    expect(mimeForPath("index.html")).toBe("text/html; charset=utf-8");
    expect(mimeForPath("app.JS")).toBe("text/javascript; charset=utf-8");
    expect(mimeForPath("app.css")).toBe("text/css; charset=utf-8");
    expect(mimeForPath("data.json")).toBe("application/json; charset=utf-8");
    expect(mimeForPath("icon.svg")).toBe("image/svg+xml");
    expect(mimeForPath("logo.png")).toBe("image/png");
    expect(mimeForPath("font.woff2")).toBe("font/woff2");
  });

  it("falls back to octet-stream for unknown or missing extensions", () => {
    expect(mimeForPath("blob.unknownext")).toBe("application/octet-stream");
    expect(mimeForPath("noextension")).toBe("application/octet-stream");
  });
});

describe("isAssetPathConfined", () => {
  it("accepts files under the renderer root after link resolution", () => {
    expect(isAssetPathConfined(ROOT, at("index.html"))).toBe(true);
    expect(isAssetPathConfined(ROOT, at("assets/index-abc123.js"))).toBe(true);
  });

  it("refuses the root itself and anything outside it", () => {
    expect(isAssetPathConfined(ROOT, ROOT)).toBe(false);
    expect(isAssetPathConfined(ROOT, resolve(ROOT, "..", "secret.txt"))).toBe(false);
    expect(isAssetPathConfined(ROOT, "/etc/passwd")).toBe(false);
  });
});
