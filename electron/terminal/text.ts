/** Offsets refer to the normalized transcript, before filtering or excerpting. */
export type TerminalOutputRedactor = (text: string, offset: number) => string;

/** Strip terminal controls without treating PTY chunk boundaries as boundaries
 * of CSI/OSC sequences. Only parser state is retained, never control payloads. */
export class TerminalTextDecoder {
  private state: "text" | "escape" | "intermediate" | "csi" | "string" | "string-escape" = "text";

  push(chunk: string): string {
    let text = "";
    for (const char of chunk) {
      if (this.state === "string" || this.state === "string-escape") {
        if (char === "\u0007" || char === "\u009c" ||
            (this.state === "string-escape" && char === "\\")) {
          this.state = "text";
        } else {
          this.state = char === "\u001b" ? "string-escape" : "string";
        }
        continue;
      }
      if (char === "\u001b") {
        this.state = "escape";
        continue;
      }
      if (char === "\u009b") {
        this.state = "csi";
        continue;
      }
      if (char === "\u009d") {
        this.state = "string";
        continue;
      }
      if (this.state === "escape") {
        if (char === "[") this.state = "csi";
        else if (char === "]" || char === "P" || char === "^" || char === "_") this.state = "string";
        else if (char >= " " && char <= "/") this.state = "intermediate";
        else this.state = "text";
        continue;
      }
      if (this.state === "csi") {
        if (char >= "@" && char <= "~") this.state = "text";
        continue;
      }
      if (this.state === "intermediate") {
        if (char >= "0" && char <= "~") this.state = "text";
        continue;
      }
      if (char !== "\u0000") text += char;
    }
    return text;
  }
}
