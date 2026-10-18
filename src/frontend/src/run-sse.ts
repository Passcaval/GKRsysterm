import type { RunEvent } from "./types.ts";
/** A cursor is scoped to one run; duplicates and older delivery are ignored. */
export class RunEventDecoder {
  private buffer = "";
  private runId: string;
  public lastEventId: number;
  constructor(runId: string, lastEventId = 0) {
    this.runId = runId;
    this.lastEventId = lastEventId;
  }
  push(text: string): RunEvent[] {
    this.buffer += text;
    if (this.buffer.length > 1024 * 1024)
      throw new Error("任务事件超过大小限制");
    const events: RunEvent[] = [];
    let separator: RegExpExecArray | null;
    while ((separator = /\r?\n\r?\n/.exec(this.buffer))) {
      const block = this.buffer.slice(0, separator.index);
      this.buffer = this.buffer.slice(separator.index + separator[0].length);
      const lines = block.split(/\r?\n/);
      const data = lines
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).replace(/^ /, ""))
        .join("\n");
      if (!data) continue;
      const raw = JSON.parse(data);
      const idLine = lines.find((l) => l.startsWith("id:"));
      const event: RunEvent = {
        eventId: raw.event_id,
        eventType: raw.event_type,
        runId: raw.run_id,
        timestamp: raw.timestamp,
        payload: raw.payload,
      };
      if (
        !Number.isSafeInteger(event.eventId) ||
        event.eventId < 1 ||
        event.runId !== this.runId ||
        !["status", "question", "result", "error", "done"].includes(
          event.eventType,
        ) ||
        typeof event.timestamp !== "string" ||
        !Number.isFinite(Date.parse(event.timestamp)) ||
        !event.payload ||
        typeof event.payload !== "object" ||
        Array.isArray(event.payload)
      )
        throw new Error("任务SSE事件字段无效");
      if (idLine && idLine.slice(3).trim() !== String(event.eventId))
        throw new Error("SSE编号与事件编号不一致");
      if (event.eventId <= this.lastEventId) continue;
      if (event.eventType === "result" && event.payload.validated !== true)
        throw new Error("任务结果尚未通过校验");
      this.lastEventId = event.eventId;
      events.push(event);
    }
    return events;
  }
  finish() {
    if (this.buffer.trim()) throw new Error("任务事件在完成前断开");
  }
}
