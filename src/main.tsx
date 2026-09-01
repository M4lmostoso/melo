import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";
import { router } from "./router";
import ThreadWindow from "./ThreadWindow";
import ComposerWindow from "./ComposerWindow";
import PreviewWindow from "./PreviewWindow";
import { installFileLogForwarding } from "./utils/fileLog";
import "./styles/globals.css";

// Before anything else: every window mirrors its console.warn/error into the
// app log file. A frontend-only failure (a send that never persisted its Sent
// copy, say) is otherwise invisible once devtools is closed.
installFileLogForwarding();

const params = new URLSearchParams(window.location.search);
const isThreadWindow = params.has("thread") && params.has("account");
const isComposerWindow = params.has("compose");
const isPreviewWindow = params.has("preview");

function Root() {
  if (isThreadWindow) return <ThreadWindow />;
  if (isComposerWindow) return <ComposerWindow />;
  if (isPreviewWindow) return <PreviewWindow />;
  return <RouterProvider router={router} />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
