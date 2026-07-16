import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";
import { router } from "./router";
import ThreadWindow from "./ThreadWindow";
import ComposerWindow from "./ComposerWindow";
import PreviewWindow from "./PreviewWindow";
import "./styles/globals.css";

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
