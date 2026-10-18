import type { ChatEvent } from "./types.ts";
// Incremental parser: a TCP/UTF-8 chunk can end anywhere, including within CRLF.
export class EventDecoder {
  private buffer = "";
  push(text: string): ChatEvent[] {
    this.buffer += text;
    const events: ChatEvent[] = [];
    let match: RegExpExecArray | null;
    while ((match = /\r?\n\r?\n/.exec(this.buffer))) {
      const block = this.buffer.slice(0, match.index);
      this.buffer = this.buffer.slice(match.index + match[0].length);
      const lines = block.split(/\r?\n/);
      const data = lines
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).replace(/^ /, ""))
        .join("\n");
      if (!data) continue;
      const value = Object.fromEntries(
        Object.entries(JSON.parse(data)).map(([k, v]) => [
          k.replace(/_([a-z])/g, (_, c) => c.toUpperCase()),
          v,
        ]),
      ) as unknown as ChatEvent;
      if (
        ![
          "tool_start",
          "tool_end",
          "delta",
          "evidence",
          "done",
          "error",
        ].includes(value.type)
      )
        throw new Error("未知的 SSE 事件类型");
      if (
        (["delta", "error"].includes(value.type) &&
          typeof value.text !== "string") ||
        (["tool_start", "tool_end"].includes(value.type) &&
          (typeof value.tool !== "string" || typeof value.text !== "string")) ||
        (value.type === "done" && typeof value.conversationId !== "string") ||
        (value.type === "evidence" &&
          (!Array.isArray(value.sourceIds) ||
            !value.sourceIds.every((x) => typeof x === "string")))
      )
        throw new Error("SSE 事件字段不符合契约");
      events.push(value);
    }
    return events;
  }
  finish() {
    if (this.buffer.trim()) throw new Error("流式响应在事件完成前断开");
  }
}
