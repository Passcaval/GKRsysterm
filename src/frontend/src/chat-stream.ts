import { ApiError, BASE, resetSession, onSessionReset } from "./transport";
import { EventDecoder } from "./sse";
import type { ChatEvent } from "./types";
const FIRST_CHUNK_TIMEOUT_MS = 90_000;
const IDLE_TIMEOUT_MS = 120_000;
export async function* streamChat(
  message: string,
  conversationId: string | undefined,
  signal: AbortSignal,
): AsyncGenerator<ChatEvent> {
  const controller = new AbortController();
  const stop = () => controller.abort();
  signal.addEventListener("abort", stop, { once: true });
  if (signal.aborted) stop();
  const dispose = onSessionReset(stop);
  let timer = setTimeout(stop, FIRST_CHUNK_TIMEOUT_MS);
  try {
    const response = await fetch(BASE + "/chat/stream", {
      method: "POST",
      credentials: "include",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        "X-Requested-With": "NightVoyage",
      },
      body: JSON.stringify({ message, conversation_id: conversationId }),
    });
    if (!response.ok || !response.body) {
      const value = await response.json().catch(() => null);
      if (response.status === 401) resetSession();
      throw new ApiError(
        response.status,
        value?.error?.message || "普通问答暂不可用",
        value?.request_id,
        value?.error?.code || "CHAT_FAILED",
        value?.error?.details || {},
      );
    }
    if (!response.headers.get("content-type")?.includes("text/event-stream"))
      throw new ApiError(502, "问答流媒体类型错误");
    const reader = response.body.getReader(),
      parser = new EventDecoder(),
      decoder = new TextDecoder();
    let done = false;
    try {
      while (!signal.aborted) {
        clearTimeout(timer);
        timer = setTimeout(stop, IDLE_TIMEOUT_MS);
        const part = await reader.read();
        if (part.done) break;
        for (const e of parser.push(
          decoder.decode(part.value, { stream: true }),
        )) {
          if (e.type === "done") done = true;
          if (e.type === "error") throw new Error(e.text);
          yield e;
        }
      }
      for (const e of parser.push(decoder.decode())) {
        if (e.type === "done") done = true;
        yield e;
      }
      parser.finish();
      if (!done && !signal.aborted)
        throw new Error("普通问答连接已中断，请重试");
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  } catch (error) {
    if (controller.signal.aborted && !signal.aborted)
      throw new Error("等待模型回复超时，请重试");
    throw error;
  } finally {
    clearTimeout(timer);
    dispose();
    signal.removeEventListener("abort", stop);
  }
}
