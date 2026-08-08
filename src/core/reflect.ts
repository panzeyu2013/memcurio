import { redactSecrets } from "./sanitize.js";

export interface CompactionReflection {
  prompt: string;
  memory: string;
}

function fallback(summary: string | undefined): CompactionReflection {
  return {
    prompt: "Keep all decisions, constraints, and active file paths in the next compaction summary.",
    memory: summary
      ? `Compaction summary captured: ${summary.slice(0, 200)} — persist key decisions as long-term memories.`
      : "No summary captured; keep decision history in SESSION.md.",
  };
}

export function formatReflection(r: CompactionReflection, ts: string): string {
  return `${ts}\n- prompt: ${r.prompt.replaceAll("\n", " ")}\n- memory: ${r.memory.replaceAll("\n", " ")}`;
}

export function appendReflection(strategy: string, section: string): string {
  const marker = "## Reflection ";
  const idx = strategy.indexOf(marker);
  const head = idx >= 0 ? strategy.slice(0, idx).trimEnd() : strategy.trimEnd();
  const old = idx >= 0 ? strategy.slice(idx).split(marker).filter((s) => s.trim()) : [];
  const tail = [...old.slice(-2), section.trim()].join(`\n${marker}`);
  const body = `${marker}${tail}`;
  return head ? `${head}\n\n${body}` : body;
}

export async function reflectOnCompaction(opts: {
  summary?: string;
  strategy?: string;
}): Promise<CompactionReflection> {
  const apiKey = process.env.MEMCORE_LLM_API_KEY;
  if (!apiKey || !opts.summary) {
    return fallback(opts.summary);
  }
  try {
    const baseUrl = (process.env.MEMCORE_LLM_BASE_URL ?? "https://api.openai.com/v1").replace(/\/+$/, "");
    const model = process.env.MEMCORE_LLM_MODEL ?? "gpt-4o-mini";
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        messages: [
          {
            role: "system",
            content:
              "You are a context-compression supervisor. Analyze the session summary and the current compression strategy, then output JSON: {\"prompt\": \"reflection and improvement suggestions for the compression prompt\", \"memory\": \"reflection on which facts should be persisted as long-term memory\"}. Keep both concise, in English.",
          },
          {
            role: "user",
            content: `Session summary:\n${redactSecrets(opts.summary).text}\n\nCurrent strategy:\n${
              opts.strategy ? redactSecrets(opts.strategy).text : "(none)"
            }`,
          },
        ],
        signal: AbortSignal.timeout(30_000),
      }),
    });
    if (!res.ok) {
      return fallback(opts.summary);
    }
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const raw = data.choices?.[0]?.message?.content ?? "";
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start < 0 || end <= start) {
      return fallback(opts.summary);
    }
    const parsed = JSON.parse(raw.slice(start, end + 1)) as { prompt?: unknown; memory?: unknown };
    const fb = fallback(opts.summary);
    return {
      prompt:
        typeof parsed.prompt === "string" && parsed.prompt.trim()
          ? parsed.prompt.trim().slice(0, 500)
          : fb.prompt,
      memory:
        typeof parsed.memory === "string" && parsed.memory.trim()
          ? parsed.memory.trim().slice(0, 500)
          : fb.memory,
    };
  } catch {
    return fallback(opts.summary);
  }
}
