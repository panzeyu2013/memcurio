export const DEFAULT_LLM_BASE_URL = "https://api.openai.com/v1";
export const DEFAULT_LLM_MODEL = "gpt-4o-mini";

export interface LlmEnv {
  apiKey: string | undefined;
  baseUrl: string;
  model: string;
}

/** Environment-driven OpenAI-compatible chat settings, shared by every
 *  LLM-facing feature (curate + reflection) so defaults cannot drift. */
export function llmEnv(): LlmEnv {
  return {
    apiKey: process.env.MEMCURIO_LLM_API_KEY,
    baseUrl: (process.env.MEMCURIO_LLM_BASE_URL ?? DEFAULT_LLM_BASE_URL).replace(/\/+$/, ""),
    model: process.env.MEMCURIO_LLM_MODEL ?? DEFAULT_LLM_MODEL,
  };
}

export interface LlmChatOptions {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
}

/** One OpenAI-compatible chat/completions call. Transient failures (network
 *  drop, HTTP 429/5xx) are retried with capped exponential backoff; anything
 *  else (auth 401, parse errors) is thrown so callers decide how to degrade. */
export async function llmChat(
  system: string,
  user: string,
  opts: LlmChatOptions = {},
): Promise<string> {
  const env = llmEnv();
  const baseUrl = (opts.baseUrl ?? env.baseUrl).replace(/\/+$/, "");
  const request = (): Promise<Response> =>
    fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${opts.apiKey ?? env.apiKey ?? ""}`,
      },
      body: JSON.stringify({
        model: opts.model ?? env.model,
        temperature: 0,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
    });
  const MAX_RETRIES = 2;
  let res: Response;
  for (let attempt = 0; ; attempt++) {
    try {
      res = await request();
    } catch (err) {
      // TimeoutError = our own AbortSignal.timeout, TypeError = network
      // failure; both are plausibly transient, everything else (abort etc.)
      // propagates immediately.
      const name = (err as Error)?.name;
      if (attempt < MAX_RETRIES && (name === "TimeoutError" || name === "TypeError")) {
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
        continue;
      }
      throw err;
    }
    if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) {
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
      continue;
    }
    break;
  }
  if (!res.ok) {
    throw new Error(`llm ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  return data.choices?.[0]?.message?.content ?? "";
}

/** Slice the outermost JSON object out of an LLM reply and parse it. Throws
 *  when no JSON object is present. Prose containing extra "{" / "}" after the
 *  object is tolerated by trying each candidate end brace in turn; if the
 *  earliest "{" start fails every candidate end (e.g. prose before the object
 *  contains its own braces), later "{" starts are tried. */
export function extractJsonObject(text: string): unknown {
  const starts: number[] = [];
  for (let i = text.indexOf("{"); i >= 0 && starts.length < 5; i = text.indexOf("{", i + 1)) {
    starts.push(i);
  }
  if (starts.length === 0) {
    throw new Error(`no JSON object in LLM output: ${text.slice(0, 120)}`);
  }
  for (const start of starts) {
    let end = text.lastIndexOf("}");
    let attempts = 0;
    while (end > start && attempts < 20) {
      attempts += 1;
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {
        end = text.lastIndexOf("}", end - 1);
      }
    }
  }
  throw new Error(`no JSON object in LLM output: ${text.slice(0, 120)}`);
}
