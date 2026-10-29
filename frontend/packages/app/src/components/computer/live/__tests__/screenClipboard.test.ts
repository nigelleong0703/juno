import { describe, expect, it } from "vitest";
import { MAX_UPLOAD_BYTES, type ScreenClipboardPaste } from "@agent-desktop/client";
import {
  base64Of,
  blobOfBase64,
  copyFromComputer,
  pasteImageToComputer,
  saveFilesToComputer,
  type DeviceClipboard,
  type ScreenClipboardBridge,
} from "../screenClipboard";

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const PNG_BASE64 = Buffer.from(PNG_BYTES).toString("base64");

/** A status-carrying error, the way the HTTP client throws a refused call. */
function httpError(status: number, code: string): Error & { status: number; code: string } {
  return Object.assign(new Error(`HTTP ${status}`), { status, code });
}

function fakeDevice(options: { image?: { mimeType: "image/png" | "image/jpeg"; blob: Blob } | null; refuseImage?: boolean; refuseText?: boolean; imageReadFails?: boolean } = {}) {
  const written: string[] = [];
  const images: Blob[] = [];
  const saved: Array<{ name: string; blob: Blob }> = [];
  const device: DeviceClipboard = {
    readText: async () => "text from the phone",
    readImage: async () => {
      if (options.imageReadFails) throw new Error("clipboard read denied");
      return options.image ?? null;
    },
    writeText: async (text) => {
      if (options.refuseText) throw new Error("blocked");
      written.push(text);
    },
    writeImage: async (blob) => {
      if (options.refuseImage) throw new Error("blocked");
      images.push(blob);
    },
    save: (blob, name) => {
      saved.push({ name, blob });
    },
  };
  return { device, written, images, saved };
}

function fakeBridge(overrides: Partial<ScreenClipboardBridge> = {}) {
  const pasted: ScreenClipboardPaste[] = [];
  const bridge: ScreenClipboardBridge & { pasted: ScreenClipboardPaste[] } = {
    copy: async () => ({ kind: "empty" }),
    paste: async (input) => {
      pasted.push(input);
      if (input.kind === "files") {
        return { kind: "files", saved: input.files.map((file) => ({ name: file.name, path: `Downloads/${file.name}` })) };
      }
      return { kind: "image", path: "Pictures/Pasted/a.png" };
    },
    ...overrides,
    pasted,
  };
  return bridge;
}

describe("copyFromComputer (Ctrl+C on the computer, then its clipboard comes here)", () => {
  it("says nothing was selected on the computer and writes nothing", async () => {
    const { device, written, images, saved } = fakeDevice();
    const note = await copyFromComputer(fakeBridge(), device);
    expect(note.message).toMatch(/Nothing selected on the computer/);
    expect(note.error).toBeUndefined();
    expect(written).toEqual([]);
    expect(images).toEqual([]);
    expect(saved).toEqual([]);
  });

  it("writes copied text to the device clipboard", async () => {
    const { device, written } = fakeDevice();
    const note = await copyFromComputer(fakeBridge({ copy: async () => ({ kind: "text", text: "from the computer" }) }), device);
    expect(written).toEqual(["from the computer"]);
    expect(note.message).toMatch(/Copied from the computer/);
  });

  it("reports a refused text write as an error", async () => {
    const { device } = fakeDevice({ refuseText: true });
    const note = await copyFromComputer(fakeBridge({ copy: async () => ({ kind: "text", text: "x" }) }), device);
    expect(note.error).toBe(true);
    expect(note.message).toMatch(/Clipboard access was blocked/);
  });

  it("puts a copied image on the device clipboard as PNG", async () => {
    const { device, images } = fakeDevice();
    const note = await copyFromComputer(fakeBridge({ copy: async () => ({ kind: "image", mimeType: "image/png", contentBase64: PNG_BASE64 }) }), device);
    expect(images).toHaveLength(1);
    expect(images[0]?.type).toBe("image/png");
    expect(Buffer.from(await images[0]!.arrayBuffer()).equals(Buffer.from(PNG_BYTES))).toBe(true);
    expect(note.message).toMatch(/Image copied from the computer/);
  });

  it("saves the image when the browser refuses it on the clipboard", async () => {
    const { device, saved } = fakeDevice({ refuseImage: true });
    const note = await copyFromComputer(fakeBridge({ copy: async () => ({ kind: "image", mimeType: "image/png", contentBase64: PNG_BASE64 }) }), device);
    expect(saved.map((item) => item.name)).toEqual(["computer-clipboard.png"]);
    expect(note.message).toMatch(/Saved to computer-clipboard\.png/);
  });

  it("saves a copied file under its own name", async () => {
    const { device, saved } = fakeDevice();
    const note = await copyFromComputer(fakeBridge({ copy: async () => ({ kind: "file", name: "report.pdf", sizeBytes: PNG_BYTES.byteLength, contentBase64: PNG_BASE64 }) }), device);
    expect(saved.map((item) => item.name)).toEqual(["report.pdf"]);
    expect(saved[0]?.blob.size).toBe(PNG_BYTES.byteLength);
    expect(note.message).toMatch(/Saved to report\.pdf/);
  });

  it("asks for a take-over when the user does not hold the screen, and never falls back to cut-text", async () => {
    const { device, written } = fakeDevice();
    const note = await copyFromComputer(fakeBridge({ copy: async () => Promise.reject(httpError(409, "NOT_IN_CONTROL")) }), device, () => "stale cut text");
    expect(written).toEqual([]);
    expect(note.error).toBe(true);
    expect(note.message).toMatch(/Take over the computer first/);
  });

  it("says the item is too large for a 413", async () => {
    const { device } = fakeDevice();
    const note = await copyFromComputer(fakeBridge({ copy: async () => Promise.reject(httpError(413, "too_large")) }), device);
    expect(note.error).toBe(true);
    expect(note.message).toMatch(/larger than the 10 MB limit/);
  });

  it("falls back to the remote's cut-text when the computer cannot answer the clipboard read", async () => {
    const { device, written } = fakeDevice();
    const note = await copyFromComputer(fakeBridge({ copy: async () => Promise.reject(httpError(500, "failed")) }), device, () => "text the remote sent");
    expect(written).toEqual(["text the remote sent"]);
    expect(note.message).toMatch(/Copied from the computer/);
  });

  it("reports a failed read when there is no cut-text either", async () => {
    const { device, written } = fakeDevice();
    const note = await copyFromComputer(fakeBridge({ copy: async () => Promise.reject(httpError(500, "failed")) }), device);
    expect(written).toEqual([]);
    expect(note.error).toBe(true);
    expect(note.message).toMatch(/could not be moved/);
  });
});

describe("pasteImageToComputer (an image on this device goes onto the computer's clipboard)", () => {
  it("does nothing when the device holds no image, so the text path runs", async () => {
    const bridge = fakeBridge();
    const outcome = await pasteImageToComputer(bridge, fakeDevice().device);
    expect(outcome).toEqual({ kind: "none" });
    expect(bridge.pasted).toEqual([]);
  });

  it("does nothing when the image cannot be read, so the text path still runs", async () => {
    const bridge = fakeBridge();
    const outcome = await pasteImageToComputer(bridge, fakeDevice({ imageReadFails: true }).device);
    expect(outcome).toEqual({ kind: "none" });
  });

  it("sends the image as base64 with its type, and reports it as pasted", async () => {
    const bridge = fakeBridge();
    const image = { mimeType: "image/png" as const, blob: new Blob([PNG_BYTES], { type: "image/png" }) };
    const outcome = await pasteImageToComputer(bridge, fakeDevice({ image }).device);
    expect(outcome).toEqual({ kind: "image" });
    expect(bridge.pasted).toEqual([{ kind: "image", mimeType: "image/png", contentBase64: PNG_BASE64 }]);
  });

  it("refuses an image over the upload limit before sending anything", async () => {
    const bridge = fakeBridge();
    const big = new Blob([new Uint8Array(MAX_UPLOAD_BYTES + 1)], { type: "image/png" });
    const outcome = await pasteImageToComputer(bridge, fakeDevice({ image: { mimeType: "image/png", blob: big } }).device);
    expect(outcome.kind).toBe("error");
    expect(bridge.pasted).toEqual([]);
  });

  it("names the take-over rule when the computer refuses the paste", async () => {
    const bridge = fakeBridge({ paste: async () => Promise.reject(httpError(409, "NOT_IN_CONTROL")) });
    const image = { mimeType: "image/jpeg" as const, blob: new Blob([PNG_BYTES], { type: "image/jpeg" }) };
    const outcome = await pasteImageToComputer(bridge, fakeDevice({ image }).device);
    expect(outcome.kind === "error" && outcome.note.message).toMatch(/Take over the computer first/);
  });
});

describe("saveFilesToComputer (files pasted on the page go to the computer's Downloads)", () => {
  it("sends each file with its name and says where it was saved", async () => {
    const bridge = fakeBridge();
    const note = await saveFilesToComputer(bridge, [new File(["hello"], "a.txt", { type: "text/plain" })]);
    expect(bridge.pasted).toEqual([{ kind: "files", files: [{ name: "a.txt", contentBase64: Buffer.from("hello").toString("base64") }] }]);
    expect(note.message).toMatch(/Saved to Downloads\/a\.txt/);
  });

  it("refuses more files than one paste carries", async () => {
    const bridge = fakeBridge();
    const files = Array.from({ length: 11 }, (_, index) => new File(["x"], `f${index}.txt`));
    const note = await saveFilesToComputer(bridge, files);
    expect(note.error).toBe(true);
    expect(note.message).toMatch(/at most 10 files/);
    expect(bridge.pasted).toEqual([]);
  });

  it("refuses files that together pass the upload limit", async () => {
    const bridge = fakeBridge();
    const big = new File([new Uint8Array(MAX_UPLOAD_BYTES)], "big.bin");
    const note = await saveFilesToComputer(bridge, [big, new File(["x"], "more.txt")]);
    expect(note.error).toBe(true);
    expect(bridge.pasted).toEqual([]);
  });
});

describe("base64 helpers", () => {
  it("round-trips bytes through a blob", async () => {
    const blob = blobOfBase64(PNG_BASE64, "image/png");
    expect(blob.type).toBe("image/png");
    expect(await base64Of(blob)).toBe(PNG_BASE64);
  });
});
