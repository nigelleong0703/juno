/**
 * Minimal ambient types for `@novnc/novnc` (MPL-2.0, used unmodified). The package ships no
 * bundled `.d.ts` and `@types/novnc__novnc` targets the old `lib/rfb` path, so we declare the
 * surface we use ourselves. Kept import-free so it stays a global ambient declaration.
 */
declare module "@novnc/novnc" {
  interface RfbCredentials {
    username?: string;
    password?: string;
    target?: string;
  }

  interface RfbOptions {
    shared?: boolean;
    credentials?: RfbCredentials;
    repeaterID?: string;
    wsProtocols?: string[];
  }

  export default class RFB {
    constructor(target: HTMLElement, url: string, options?: RfbOptions);
    viewOnly: boolean;
    scaleViewport: boolean;
    resizeSession: boolean;
    clipViewport: boolean;
    background: string;
    credentials?: RfbCredentials;
    disconnect(): void;
    sendKey(keysym: number, code: string | null, down?: boolean): void;
    clipboardPasteFrom(text: string): void;
    addEventListener(type: string, listener: (event: Event) => void): void;
    removeEventListener(type: string, listener: (event: Event) => void): void;
  }
}
