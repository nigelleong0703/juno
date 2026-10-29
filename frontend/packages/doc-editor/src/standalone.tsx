import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { parseIncoming, type EditorOutgoing } from "./bridge";
import { DocumentEditor, type DocumentEditorHandle } from "./DocumentEditor";
import "./editor.css";
import "./standalone.css";

declare global {
  interface Window {
    webkit?: { messageHandlers?: { junoEditor?: { postMessage(message: EditorOutgoing): void } } };
    junoEditor?: { receive(message: unknown): void };
  }
}

const CHANGE_DEBOUNCE_MS = 150;

function post(message: EditorOutgoing): void {
  window.webkit?.messageHandlers?.junoEditor?.postMessage(message);
}

/**
 * The page the iOS app bundles and shows in a `WKWebView` (no network). The native side owns the top bar and the
 * formatting buttons: it calls `junoEditor.receive({type, ...})` and gets `ready`, `mode`, `change` and `state` back.
 */
function Page() {
  const [loaded, setLoaded] = useState({ markdown: "", resetKey: 0 });
  const [editable, setEditable] = useState(true);
  const handle = useRef<DocumentEditorHandle>(null);
  const pending = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    window.junoEditor = {
      receive(raw) {
        const message = parseIncoming(typeof raw === "string" ? safeJson(raw) : raw);
        if (!message) return;
        if (message.type === "setMarkdown") setLoaded((old) => ({ markdown: message.markdown, resetKey: old.resetKey + 1 }));
        else if (message.type === "setEditable") setEditable(message.editable);
        else handle.current?.run(message.command, message.argument);
      },
    };
    post({ type: "ready" });
    return () => {
      delete window.junoEditor;
    };
  }, []);

  return (
    <DocumentEditor
      markdown={loaded.markdown}
      resetKey={loaded.resetKey}
      editable={editable}
      handleRef={handle}
      onModeChange={(mode) => post({ type: "mode", mode })}
      onStateChange={(state) => post({ type: "state", state })}
      onChange={(markdown) => {
        clearTimeout(pending.current);
        pending.current = setTimeout(() => post({ type: "change", markdown }), CHANGE_DEBOUNCE_MS);
      }}
    />
  );
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const rootElement = document.getElementById("root");
if (rootElement) createRoot(rootElement).render(<Page />);
