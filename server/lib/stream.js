import fs from "node:fs";
import { randomUUID } from "node:crypto";

/** Tail complete JSONL records without dropping partial UTF-8 characters/lines. */
export class JsonlTail {
  constructor(file, log = () => {}) {
    this.path = file;
    this.log = log;
    this.offset = 0;
  }

  read() {
    let fd;
    try {
      fd = fs.openSync(this.path, "r");
      const size = fs.fstatSync(fd).size;
      if (size < this.offset) this.offset = 0;
      if (size === this.offset) return [];
      const buf = Buffer.alloc(size - this.offset);
      const bytes = fs.readSync(fd, buf, 0, buf.length, this.offset);
      const end = buf.subarray(0, bytes).lastIndexOf(10);
      if (end < 0) return [];
      this.offset += end + 1;
      return buf.toString("utf8", 0, end + 1).split("\n").flatMap((line) => {
        if (!line.trim()) return [];
        try { return [JSON.parse(line)]; }
        catch { this.log("Skipped malformed Aside event record"); return []; }
      });
    } catch (error) {
      if (error.code !== "ENOENT") this.log(`event read failed: ${error.message}`);
      return [];
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }
}

/** Convert Aside's real message events to append-only ACP text/thought chunks. */
export class AsideTurnStream {
  constructor(emit, log = () => {}) {
    this.emit = emit;
    this.log = log;
    this.messages = new Map();
    this.current = null;
    this.finalText = "";
    this.error = "";
    this.textChunks = 0;
    this.events = 0;
  }

  messageState(message, start = false) {
    const key = message?.timestamp ?? message?.responseId;
    if (key !== undefined) {
      if (!this.messages.has(key)) this.messages.set(key, { blocks: new Map() });
      this.current = this.messages.get(key);
    } else if (start || !this.current) {
      this.current = { blocks: new Map() };
    }
    return this.current;
  }

  block(state, index, kind) {
    const key = `${index}:${kind}`;
    if (!state.blocks.has(key)) state.blocks.set(key, { id: randomUUID(), text: "" });
    return state.blocks.get(key);
  }

  append(block, text, kind) {
    if (!text) return;
    block.text += text;
    if (kind === "assistant") this.textChunks += 1;
    this.emit(text, kind, block.id);
  }

  snapshot(state, index, content) {
    const kind = content?.type === "text" ? "assistant" : content?.type === "thinking" ? "reasoning" : null;
    if (!kind) return;
    const text = kind === "assistant" ? content.text : content.thinking;
    if (typeof text !== "string") return;
    const block = this.block(state, index, kind);
    // message_start/end, reconnect snapshots and raw deltas can overlap.
    if (text.startsWith(block.text)) this.append(block, text.slice(block.text.length), kind);
    else if (!block.text.startsWith(text)) this.log("Aside replaced streamed text; retained the already delivered prefix");
  }

  complete(message) {
    if (message?.role !== "assistant") return;
    const state = this.messageState(message);
    const content = Array.isArray(message.content) ? message.content : [];
    content.forEach((part, index) => this.snapshot(state, index, part));
    if (["stop", "end_turn"].includes(message.stopReason)) {
      this.finalText = content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
    }
    if (message.stopReason === "error" && message.errorMessage) this.error = String(message.errorMessage);
  }

  accept(event) {
    if (!event || typeof event !== "object") return;
    this.events += 1;
    if (event.type === "agent_error" && event.errorMessage) this.error = String(event.errorMessage);
    const update = event.assistantMessageEvent;
    const message = event.message ?? update?.partial;
    if (message?.role !== "assistant") return;
    if (event.type === "message_end") return this.complete(message);
    const state = this.messageState(message, event.type === "message_start");
    if (event.type === "message_start") {
      if (Array.isArray(message.content)) message.content.forEach((part, index) => this.snapshot(state, index, part));
      return;
    }
    if (event.type !== "message_update" || !update) return;
    const index = update.contentIndex;
    if (!Number.isInteger(index)) return;
    const content = message.content?.[index];
    if (content?.type === "text" || content?.type === "thinking") {
      this.snapshot(state, index, content);
    } else if (["text_delta", "thinking_delta"].includes(update.type) && typeof update.delta === "string") {
      const kind = update.type === "text_delta" ? "assistant" : "reasoning";
      this.append(this.block(state, index, kind), update.delta, kind);
    }
  }
}
