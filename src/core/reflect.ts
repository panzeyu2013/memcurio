import { redactSecrets } from "./sanitize.js";

export interface CompactionReflection {
  prompt: string;
  memory: string;
}

export interface ReflectChat {
  (opts: { summary?: string; strategy?: string }): Promise<CompactionReflection | null>;
}

function fallback(summary: string | undefined): CompactionReflection {
  return {
    prompt: "Keep all decisions, constraints, and active file paths in the next compaction summary.",
    memory: summary
      ? `Compaction summary captured: ${summary.slice(0, 200)} — persist key decisions as long-term memories.`
      : "No summary captured; keep decision history in SESSION.md.",
  };
}

export function reflectionUserPrompt(summary: string, strategy?: string): string {
  return [
    "System: You are a context-compression supervisor. Analyze the session summary and the current compression strategy, then output JSON: {\"prompt\": \"reflection and improvement suggestions for the compression prompt\", \"memory\": \"reflection on which facts should be persisted as long-term memory\"}. Keep both concise, in English.",
    "",
    `Session summary:\n${redactSecrets(summary).text}`,
    "",
    `Current strategy:\n${strategy ? redactSecrets(strategy).text : "(none)"}`,
  ].join("\n");
}

export function parseReflectionResponse(raw: string): CompactionReflection | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return null;
  }
  const parsed = JSON.parse(raw.slice(start, end + 1)) as { prompt?: unknown; memory?: unknown };
  const prompt = typeof parsed.prompt === "string" ? parsed.prompt.trim().slice(0, 500) : "";
  const memory = typeof parsed.memory === "string" ? parsed.memory.trim().slice(0, 500) : "";
  if (!prompt && !memory) {
    return null;
  }
  return {
    prompt: prompt || fallback(undefined).prompt,
    memory: memory || fallback(undefined).memory,
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

async function httpReflect(opts: { summary?: string; strategy?: string }): Promise<CompactionReflection | null> {
  const apiKey = process.env.MEMCORE_LLM_API_KEY;
  if (!apiKey || !opts.summary) {
    return null;
  }
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
        { role: "user", content: reflectionUserPrompt(opts.summary, opts.strategy) },
      ],
      signal: AbortSignal.timeout(30_000),
    }),
  });
  if (!res.ok) {
    return null;
  }
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const raw = data.choices?.[0]?.message?.content ?? "";
  if (!raw) {
    return null;
  }
  try {
    return parseReflectionResponse(raw);
  } catch {
    return null;
  }
}

export async function reflectOnCompaction(opts: {
  summary?: string;
  strategy?: string;
  chat?: ReflectChat;
}): Promise<CompactionReflection> {
  if (opts.chat) {
    try {
      const r = await opts.chat(opts);
      if (r) {
        return r;
      }
    } catch {
      void 0;
    }
  }
  try {
    const r = await httpReflect(opts);
    if (r) {
      return r;
    }
  } catch {
    void 0;
  }
  return fallback(opts.summary);
}
