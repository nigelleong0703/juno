# Juno Chrome Bridge

This extension operates the owner's existing Chrome profile so agents can use pages where
the owner is already signed in. It never launches or clones a browser profile.

## Build and install

1. From `frontend/`, run `node packages/desktop/scripts/build-chrome-bridge.mjs`.
   This creates `packages/desktop/vendor/chrome-bridge/juno-chrome-host` and the minified,
   source-map-free `packages/desktop/vendor/chrome-extension/`.
2. Start Juno desktop once. Its startup calls the bridge `setup()`, which installs
   `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/io.github.nigelleong0703.juno.chrome.json`
   and starts the owner-only Unix socket. If the packaged host is not present yet, setup can be
   called again after the build or app update.
3. Open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select
   `packages/desktop/vendor/chrome-extension/`.
4. Start or relaunch Juno. Open the extension popup, click **Allow this tab**, and grant each tab
   that an agent may operate. Chrome shows its normal debugging notice while a granted tab is
   controlled; closing it or cancelling releases that tab immediately.

The extension ID is fixed by the public `key` in `manifest.json`:
`kbfjckdecckcdjaokfiphfipdpenodoj`. The private key is not part of this repository or the built
extension.

The native host is `io.github.nigelleong0703.juno.chrome`. Desktop and Chrome exchange only piped native
messaging frames; no TCP or HTTP listener is opened. The desktop socket and its runtime token are
owner-only (`0600`), and Chrome receives a private launcher for the packaged host. Tab grants are
explicit and per tab. Disconnecting the native port detaches debugger sessions and invalidates
refs; a command interrupted after dispatch has an unknown outcome and is never replayed.

Uninstall the extension or choose **Stop all tab access** in its popup to revoke access. No user
Chrome profile files are copied or exported by this bridge.

## Desktop integration

Create the bridge with the packaged extension and host paths:

```ts
const bridge = createChromeBridge({
  userDataDir: app.getPath("userData"),
  extensionPath: join(process.resourcesPath, "chrome-extension"),
  nativeHostPath: join(process.resourcesPath, "chrome-bridge", "juno-chrome-host"),
});
```

Call `setup()` at app startup and retry it before a browser command if startup previously ran while
the host resource was unavailable. `connected()` is the Settings status. For an isolated QA run only,
pass a temporary `chromeHome` (the lead maps `AGENT_DESKTOP_CHROME_HOME`); production must omit it so
the native-host manifest is installed for the owner's current Chrome.

Verification against a temporary Chrome for Testing profile (no owner profile):

```sh
JUNO_CHROME_LIVE=1 pnpm --filter @agent-desktop/desktop exec vitest run src/main/chrome-bridge-live.test.ts
```
