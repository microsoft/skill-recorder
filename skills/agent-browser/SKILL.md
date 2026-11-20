---
name: agent-browser
description: 'Fast browser automation CLI for AI agents via CDP. Use when interacting with websites, navigating pages, filling forms, clicking buttons, taking accessibility snapshots, extracting data, testing web apps, or automating browser sessions without Playwright/Puppeteer.'
allowed-tools: Bash(agent-browser:*), Bash(npx agent-browser:*)
---

# agent-browser

Fast browser automation CLI for AI agents. Chrome/Chromium via CDP with
accessibility-tree snapshots and compact `@eN` element refs.

## Overview

`agent-browser` provides headless or headful browser control optimized for AI agents:
- Accessibility-tree snapshots with compact `@eN` element references (~200-400 tokens per snapshot).
- Native CLI execution (`agent-browser`) with zero Playwright/Puppeteer runtime dependencies.
- Session isolation, auth vault, cookies/storage persistence, and WebMCP auto-discovery.

## Prerequisites

Verify or install `agent-browser`:

```bash
npm i -g agent-browser && agent-browser install
agent-browser --version
```

## Core Interaction Loop

1. **Open the target URL:**
   ```bash
   agent-browser open https://example.com/portal
   ```

2. **Capture accessibility tree snapshot with interactive element refs:**
   ```bash
   agent-browser snapshot -i
   ```
   *Output returns element refs like `@e1 [link] "Dashboard"`, `@e2 [button] "Submit"`, `@e3 [textbox] "Search"`.*

3. **Interact using element references:**
   ```bash
   agent-browser fill @e3 "query term"
   agent-browser click @e2
   ```

4. **Observe mutations and re-snapshot:**
   ```bash
   agent-browser wait --selector "#results"
   agent-browser snapshot -i
   ```

5. **Extract content or save screenshots:**
   ```bash
   agent-browser screenshot output.png
   agent-browser close
   ```

## Specialized Modes

- **WebMCP Integration:** Automatically detect and invoke structured server actions where advertised.
- **Session Management:** Run isolated profiles via `--session <name>`.
- **Desktop Electron Automation:** Automate Electron desktop apps using `agent-browser skills get electron`.
