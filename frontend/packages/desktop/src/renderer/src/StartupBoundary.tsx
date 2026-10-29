import { Component, useEffect, type ErrorInfo, type ReactNode } from "react";

/** Reports React commit separately from Chromium document load; never sends exception text. */
export function RendererReady() {
  useEffect(() => { window.startup?.report("renderer-ready"); }, []);
  return null;
}

export class StartupBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  override componentDidCatch(_error: Error, _info: ErrorInfo) {
    window.startup?.report("renderer-error");
  }
  override render() {
    if (!this.state.failed) return this.props.children;
    return (
      <main role="alert" style={{ padding: 32, color: "#e6e9ef", background: "#0b0f14", minHeight: "100vh" }}>
        <h1>Juno could not load</h1>
        <p>Please reopen the app. Your settings have been preserved.</p>
        <button onClick={() => window.location.reload()}>Reload</button>
      </main>
    );
  }
}
