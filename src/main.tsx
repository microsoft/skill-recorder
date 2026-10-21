import React from "react";
import { createRoot } from "react-dom/client";

import { Library } from "./Library";
import { Recorder } from "./Recorder";
import { RecordingControls } from "./RecordingControls";
import { Terminal } from "./Terminal";
import "./App.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root");

const route = window.location.hash.replace("#", "");
const isLibrary = route === "library";
const isRecordingControls = route === "recording-controls";
const isTerminal = route === "terminal";
document.body.dataset.route = isLibrary
  ? "library"
  : isRecordingControls
    ? "recording-controls"
    : isTerminal
      ? "terminal"
    : "recorder";

createRoot(root).render(
  <React.StrictMode>
    {isLibrary ? (
      <Library />
    ) : isRecordingControls ? (
      <RecordingControls />
    ) : isTerminal ? (
      <Terminal />
    ) : (
      <Recorder />
    )}
  </React.StrictMode>,
);
