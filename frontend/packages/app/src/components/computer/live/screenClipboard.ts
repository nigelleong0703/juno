/**
 * The computer clipboard on the web (M-CLIP). Text keeps the VNC path (`clipboardPasteFrom` plus Ctrl+V, and the remote's
 * cut-text). An image or a file goes through computerd, because VNC cut-text carries text only:
 *  - Copy: Ctrl+C on the computer, then what its clipboard holds: text is written here, an image goes to the device
 *    clipboard (or is saved when the browser refuses it), a file is saved.
 *  - Paste: an image on the device clipboard is sent to the computer, which puts it on its own clipboard; the caller then
 *    sends Ctrl+V. Files dropped into the paste event are saved to the computer's Downloads.
 *
 * The device clipboard and the screen are arguments, so these rules are testable without a browser clipboard or a network.
 */
import {
  MAX_UPLOAD_BYTES,
  SCREEN_CLIPBOARD_MAX_FILES,
  type ScreenClipboard,
  type ScreenClipboardPaste,
  type ScreenClipboardPasteResult,
} from "@agent-desktop/client";
import { tc } from "../i18n";

/** The computer's side of the channel, bound to one screen (see `useScreenClipboard`). */
export interface ScreenClipboardBridge {
  copy(): Promise<ScreenClipboard>;
  paste(input: ScreenClipboardPaste): Promise<ScreenClipboardPasteResult>;
}

/** The device's clipboard and downloads, as the browser offers them. */
export interface DeviceClipboard {
  readText(): Promise<string>;
  /** The first image on the device clipboard, or `null` when it holds none. */
  readImage(): Promise<{ mimeType: "image/png" | "image/jpeg"; blob: Blob } | null>;
  writeText(text: string): Promise<void>;
  /** Rejects when the browser refuses an image on the clipboard. */
  writeImage(blob: Blob): Promise<void>;
  /** Hands a file to the user (a download). */
  save(blob: Blob, name: string): void;
}

/** One line for the user; `error` picks the tone. */
export interface ClipboardNote {
  message: string;
  error?: boolean;
}

export type PasteOutcome = { kind: "none" } | { kind: "image" } | { kind: "error"; note: ClipboardNote };

/**
 * Ctrl+C has been sent to the computer and has had a moment to take effect. The computer's clipboard is then read; when that
 * read fails (an older computer image without the side channel) the cut-text that arrived meanwhile is used, if any.
 */
export async function copyFromComputer(
  bridge: ScreenClipboardBridge,
  device: DeviceClipboard,
  fallbackText: () => string | null = () => null,
): Promise<ClipboardNote> {
  let copied: ScreenClipboard;
  try {
    copied = await bridge.copy();
  } catch (error) {
    // 409 (the user does not hold the screen) and 413 are answers, not a missing side channel: no fallback for them.
    const status = statusOf(error);
    const text = status === 409 || status === 413 ? null : fallbackText();
    if (text) return writeTextNote(device, text);
    return failureNote(error);
  }
  switch (copied.kind) {
    case "empty":
      return { message: tc("computer.clipboard.nothingOnComputer") };
    case "text":
      return writeTextNote(device, copied.text);
    case "image": {
      const blob = blobOfBase64(copied.contentBase64, "image/png");
      try {
        await device.writeImage(blob);
        return { message: tc("computer.clipboard.copiedImage") };
      } catch {
        return saveNote(device, blob, "computer-clipboard.png");
      }
    }
    case "file":
      return saveNote(device, blobOfBase64(copied.contentBase64, "application/octet-stream"), copied.name);
  }
}

/** Sends the device's image (if it holds one) to the computer's clipboard. `none` means the caller pastes text as before. */
export async function pasteImageToComputer(bridge: ScreenClipboardBridge, device: DeviceClipboard): Promise<PasteOutcome> {
  let image: Awaited<ReturnType<DeviceClipboard["readImage"]>>;
  try {
    image = await device.readImage();
  } catch {
    return { kind: "none" };
  }
  if (image === null) return { kind: "none" };
  if (image.blob.size > MAX_UPLOAD_BYTES) return { kind: "error", note: tooLargeNote() };
  try {
    await bridge.paste({ kind: "image", mimeType: image.mimeType, contentBase64: await base64Of(image.blob) });
    return { kind: "image" };
  } catch (error) {
    return { kind: "error", note: failureNote(error) };
  }
}

/** Files pasted or dropped on the page go to the computer's Downloads; the answer names where they went. */
export async function saveFilesToComputer(bridge: ScreenClipboardBridge, files: File[]): Promise<ClipboardNote> {
  if (files.length > SCREEN_CLIPBOARD_MAX_FILES) {
    return { message: tc("computer.clipboard.tooManyFiles", { max: SCREEN_CLIPBOARD_MAX_FILES }), error: true };
  }
  if (files.reduce((sum, file) => sum + file.size, 0) > MAX_UPLOAD_BYTES) return tooLargeNote();
  try {
    const result = await bridge.paste({
      kind: "files",
      files: await Promise.all(files.map(async (file) => ({ name: file.name, contentBase64: await base64Of(file) }))),
    });
    if (result.kind !== "files") return failureNote(new Error("unexpected clipboard answer"));
    return { message: tc("computer.clipboard.savedFile", { path: result.saved.map((item) => item.path).join(", ") }) };
  } catch (error) {
    return failureNote(error);
  }
}

/** The browser's own clipboard and downloads. */
export const browserClipboard: DeviceClipboard = {
  readText: () => navigator.clipboard.readText(),
  async readImage() {
    const items = await navigator.clipboard.read();
    for (const item of items) {
      for (const mimeType of ["image/png", "image/jpeg"] as const) {
        if (item.types.includes(mimeType)) return { mimeType, blob: await item.getType(mimeType) };
      }
    }
    return null;
  },
  writeText: (text) => navigator.clipboard.writeText(text),
  writeImage: (blob) => navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]),
  save(blob, name) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  },
};

export async function base64Of(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let at = 0; at < bytes.length; at += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  }
  return btoa(binary);
}

export function blobOfBase64(base64: string, type: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type });
}

async function writeTextNote(device: DeviceClipboard, text: string): Promise<ClipboardNote> {
  try {
    await device.writeText(text);
    return { message: tc("computer.clipboard.copied") };
  } catch {
    return { message: tc("computer.clipboard.denied"), error: true };
  }
}

function saveNote(device: DeviceClipboard, blob: Blob, name: string): ClipboardNote {
  device.save(blob, name);
  return { message: tc("computer.clipboard.savedFile", { path: name }) };
}

function tooLargeNote(): ClipboardNote {
  return { message: tc("computer.clipboard.tooLarge"), error: true };
}

function failureNote(error: unknown): ClipboardNote {
  const status = statusOf(error);
  if (status === 409) return { message: tc("computer.clipboard.needControl"), error: true };
  if (status === 413) return tooLargeNote();
  return { message: tc("computer.clipboard.failed"), error: true };
}

function statusOf(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("status" in error)) return undefined;
  const status = (error as { status: unknown }).status;
  return typeof status === "number" ? status : undefined;
}
