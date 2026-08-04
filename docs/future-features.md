# Future features

Capabilities that are wired up in the codebase but deliberately not surfaced in
the UI yet. Each entry is dormant, not dead: the backend path stays intact so the
feature can be revived without re-plumbing it.

## Manual markers ("Add marker") — revived

**Status:** live, via a global hotkey instead of the old blocking button.

A marker is a precise "this instant matters" signal captured mid-recording. It
was originally a HUD button that opened a blocking `window.prompt`; that version
was removed in favor of voice narration, since narration already captures the
same "stated intent" hands-free and continuously.

**Current implementation:** `CommandOrControl+Shift+M` fires a marker at any
point during a recording, from anywhere (not just while the app is focused),
mirroring how `CommandOrControl+Shift+R` toggles recording. It never blocks or
steals focus:

| Layer | Location |
| --- | --- |
| Global shortcut + dispatch | `electron/main.ts` (`addMarker`) |
| Recorder handler | `electron/recorder/controller.ts` (`marker()`) |
| Renderer bridge | `electron/preload.cjs` (`window.skillRecorder.marker`, `onMarkerAdded`) |
| Confirmation broadcast | `common/ipc.ts` (`IPC.markerAdded`, `MarkerAddedEvent`) |
| Toast UI | `src/RecordingControls.tsx` (`recording-marker-toast`), styled in `src/App.css` |
| Event type + payload | `common/events.ts` (`EventType.Marker`, `MarkerPayload`) |
| Correlation / bundling | `common/correlation.ts`, `common/bundle.ts` (`step.markers`) |
| Description surfacing | `common/describe.ts`, describer + skillbuilder `tools.ts` |

The confirmation is a small pill in the recording controls overlay that fades
out on its own after ~2 seconds — no dialog, no interruption.

**Not yet implemented:** an optional inline note. `marker(note)` already accepts
free text, but the hotkey currently always records an empty note; typing a note
into the toast without delaying the marker's timestamp (or introducing a second
IPC round trip) needs a bit more design and is left as a follow-up.
