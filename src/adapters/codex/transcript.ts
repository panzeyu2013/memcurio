import { closeSync, openSync, readSync, statSync } from "node:fs";
import type { EvidenceInput } from "../../core/extract.js";
import { redactSecrets } from "../../core/sanitize.js";

// Transcript formats are host-owned and may grow without bound. Read only a
// bounded tail; the evidence snapshot applies a second item/character cap.
export const MAX_TRANSCRIPT_BYTES = 2 * 1024 * 1024;
const MAX_TRANSCRIPT_LINES = 256;
const MAX_TEXT_CHARS = 8_000;

function readTail(path: string): string {
  const stat = statSync(path);
  if (!stat.isFile() || stat.size <= 0) {
    return "";
  }
  const length = Math.min(stat.size, MAX_TRANSCRIPT_BYTES);
  const start = Math.max(0, stat.size - length);
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    const bytes = readSync(fd, buffer, 0, length, start);
    return buffer.subarray(0, bytes).toString("utf-8");
  } finally {
    closeSync(fd);
  }
}

function kindFor(role: unknown): EvidenceInput["kind"] {
  return role === "user" ? "user" : role === "assistant" ? "assistant" : "event";
}

function collectText(value: unknown, role: unknown, out: EvidenceInput[], depth = 0): void {
  if (depth > 5 || out.length >= MAX_TRANSCRIPT_LINES) {
    return;
  }
  if (typeof value === "string") {
    const text = redactSecrets(value).text.trim();
    if (text) {
      out.push({ kind: kindFor(role), text: text.slice(0, MAX_TEXT_CHARS) });
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectText(item, role, out, depth + 1);
      if (out.length >= MAX_TRANSCRIPT_LINES) return;
    }
    return;
  }
  if (!value || typeof value !== "object") {
    return;
  }
  const record = value as Record<string, unknown>;
  const nextRole = typeof record.role === "string" ? record.role : role;
  for (const key of ["text", "content", "prompt", "message", "output", "summary"]) {
    if (key in record) {
      collectText(record[key], nextRole, out, depth + 1);
    }
    if (out.length >= MAX_TRANSCRIPT_LINES) return;
  }
}

/** Extract likely user/assistant/tool text from the tail of a Codex JSONL
 * transcript. Unknown lines are retained as event evidence, never executed. */
export function readCodexTranscriptEvidence(path: string): EvidenceInput[] {
  let raw: string;
  try {
    raw = readTail(path);
  } catch {
    return [];
  }
  if (!raw) {
    return [];
  }
  const lines = raw.split(/\r?\n/).filter(Boolean).slice(-MAX_TRANSCRIPT_LINES);
  const out: EvidenceInput[] = [];
  for (const line of lines) {
    try {
      collectText(JSON.parse(line), undefined, out);
    } catch {
      // A partial tail may begin mid-line; retaining it as quarantined event
      // evidence is more useful than silently dropping the only user prompt.
      // It still enters the durable spool before createEvidenceSnapshot gets a
      // second pass, so redact here as well as on parsed transcript fields.
      const text = redactSecrets(line).text.trim();
      if (text) {
        out.push({ kind: "event", text: text.slice(0, MAX_TEXT_CHARS) });
      }
    }
    if (out.length >= MAX_TRANSCRIPT_LINES) break;
  }
  return out.slice(-MAX_TRANSCRIPT_LINES);
}
