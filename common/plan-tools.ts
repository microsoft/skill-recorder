const TOOL_LABELS: Record<string, string> = {
  view: "Read local file or folder",
  glob: "Find local paths",
  grep: "Search file contents",
  web_fetch: "Fetch web page",
  bash: "Run device command",
  workiq_get_my_profile: "Get my profile",
  workiq_search_chats: "Search Teams chats",
  workiq_list_chats: "List Teams chats",
  workiq_get_chat: "Read Teams chat",
  workiq_list_chat_messages: "Read Teams messages",
  workiq_send_chat_message: "Send Teams message",
};

/** Human-facing capability name; the exact runtime identifier remains available as a tooltip. */
export function planToolLabel(tool: string): string {
  const id = tool.trim();
  const known = TOOL_LABELS[id];
  if (known) return known;
  if (id.startsWith("workiq_")) return `${humanizeIdentifier(id.slice("workiq_".length))} · WorkIQ`;
  if (id.startsWith("browser_")) return `${humanizeIdentifier(id.slice("browser_".length))} · Browser`;
  return humanizeIdentifier(id);
}

function humanizeIdentifier(value: string): string {
  const words = value.replace(/[_-]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "Tool";
}
