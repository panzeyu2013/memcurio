import { createHash } from "node:crypto";

import { Index } from "./db.js";
import { addEntry, updateKind } from "./mdStore.js";
import type { Entry, Kind, Status } from "./mdStore.js";
import { nsDir, txnLog } from "./paths.js";
import { redactSecrets, scanInjection } from "./sanitize.js";
import { Transaction } from "./transaction.js";

export interface CurateProvider {
  readonly name: string;
  reevaluate(entry: Entry): Promise<number | null>;
  checkContradiction(a: Entry, b: Entry): Promise<{ contradictory: boolean; reason: string }>;
  suggestUmbrella(group: Entry[]): Promise<string | null>;
}

export class NoopProvider implements CurateProvider {
  readonly name = "noop";

  async reevaluate(): Promise<number | null> {
    return null;
  }

  async checkContradiction(): Promise<{ contradictory: boolean; reason: string }> {
    return { contradictory: false, reason: "" };
  }

  async suggestUmbrella(): Promise<string | null> {
    return null;
  }
}

export interface HttpProviderOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export function parseJsonFromText(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new Error(`no JSON object in LLM output: ${text.slice(0, 120)}`);
  }
  return JSON.parse(text.slice(start, end + 1));
}

export class HttpProvider implements CurateProvider {
  readonly name = "http";

  constructor(private readonly opts: HttpProviderOptions) {}

  private async chat(system: string, user: string): Promise<string> {
    const res = await fetch(`${this.opts.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.opts.apiKey}`,
      },
      body: JSON.stringify({
        model: this.opts.model,
        temperature: 0,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      throw new Error(`llm ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return data.choices?.[0]?.message?.content ?? "";
  }

  async reevaluate(entry: Entry): Promise<number | null> {
    try {
      const out = await this.chat(
        "你是长期记忆价值评估器。根据条目的可复用性/重要性给 0-2 分（0=可删，1=一般，2=高价值）。只输出一个数字，不要其他文字。",
        `条目内容:\n${redactSecrets(entry.content).text}\n使用次数: ${entry.useCount}\n创建时间: ${entry.createdAt}`,
      );
      const score = Number.parseFloat(out.trim());
      if (!Number.isFinite(score)) {
        return null;
      }
      return Math.min(2, Math.max(0, score));
    } catch {
      return null;
    }
  }

  async checkContradiction(a: Entry, b: Entry): Promise<{ contradictory: boolean; reason: string }> {
    try {
      const out = await this.chat(
        "判断两条长期记忆是否互相矛盾。输出 JSON: {\"contradictory\": true/false, \"reason\": \"...\"}",
        `条目 A:\n${redactSecrets(a.content).text}\n\n条目 B:\n${redactSecrets(b.content).text}`,
      );
      const parsed = parseJsonFromText(out) as { contradictory?: boolean; reason?: string };
      return { contradictory: parsed.contradictory === true, reason: parsed.reason ?? "" };
    } catch {
      return { contradictory: false, reason: "__unparsable__" };
    }
  }

  async suggestUmbrella(group: Entry[]): Promise<string | null> {
    try {
      const out = await this.chat(
        "以下多条记忆高度相似，请合并为一条伞条目（保留所有信息，简洁）。若不应合并输出 NO_MERGE。",
        group.map((e, i) => `条目${i + 1}:\n${redactSecrets(e.content).text}`).join("\n\n"),
      );
      const trimmed = out.trim();
      return trimmed === "" || /^no_merge$/i.test(trimmed) ? null : trimmed;
    } catch {
      return null;
    }
  }
}

export interface CuratePlan {
  reevaluations: Array<{ entry: Entry; score: number }>;
  contradictions: Array<{ a: Entry; b: Entry; reason: string }>;
  umbrellas: Array<{ group: Entry[]; content: string }>;
  unparsable: number;
}

export interface CurateOptions {
  ns?: string;
  minUseForReeval?: number;
  minOverlap?: number;
}

export function bigramOverlap(a: string, b: string): number {
  const grams = (s: string): Set<string> => {
    const out = new Set<string>();
    for (let i = 0; i < s.length - 1; i++) {
      out.add(s.slice(i, i + 2));
    }
    return out;
  };
  const ga = grams(a);
  const gb = grams(b);
  if (ga.size === 0 || gb.size === 0) {
    return 0;
  }
  let inter = 0;
  for (const g of ga) {
    if (gb.has(g)) {
      inter += 1;
    }
  }
  return inter / Math.min(ga.size, gb.size);
}

export async function buildCuratePlan(
  idx: Index,
  provider: CurateProvider,
  opts: CurateOptions = {},
): Promise<CuratePlan> {
  const entries = idx.list({ ns: opts.ns }).filter((e) => e.status === "active");
  const plan: CuratePlan = { reevaluations: [], contradictions: [], umbrellas: [], unparsable: 0 };
  const minUse = opts.minUseForReeval ?? 5;
  const minOverlap = opts.minOverlap ?? 0.5;

  for (const e of entries) {
    if (e.useCount >= minUse) {
      const score = await provider.reevaluate(e);
      if (score !== null && Math.abs(score - e.valueScore) > 0.05) {
        plan.reevaluations.push({ entry: e, score });
      }
    }
  }

  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const a = entries[i];
      const b = entries[j];
      if (a.ns !== b.ns || a.kind !== b.kind) {
        continue;
      }
      const overlap = bigramOverlap(a.content, b.content);
      if (overlap >= 0.85) {
        const content = await provider.suggestUmbrella([a, b]);
        if (content) {
          plan.umbrellas.push({ group: [a, b], content });
        }
      } else if (overlap >= minOverlap) {
        const verdict = await provider.checkContradiction(a, b);
        if (verdict.reason === "__unparsable__") {
          plan.unparsable += 1;
        } else if (verdict.contradictory) {
          plan.contradictions.push({ a, b, reason: verdict.reason });
        }
      }
    }
  }
  return plan;
}

export async function applyCuratePlan(idx: Index, root: string, plan: CuratePlan): Promise<void> {
  const txn = new Transaction(txnLog(root));
  txn.run(
    "curate",
    "-",
    `${plan.reevaluations.length} reeval, ${plan.contradictions.length} contradictions, ${plan.umbrellas.length} umbrellas`,
    () => {
      for (const r of plan.reevaluations) {
        r.entry.valueScore = r.score;
        idx.add(r.entry);
      }
      for (const c of plan.contradictions) {
        idx.recordContradiction(c.a.entryId, c.b.entryId, c.reason);
      }
      for (const u of plan.umbrellas) {
        const ts = new Date().toISOString();
        const entryId = createHash("sha1").update(`${ts}|${u.content}`).digest("hex").slice(0, 8);
        const redacted = redactSecrets(u.content);
        const injectionFlags = scanInjection(redacted.text);
        const entry: Entry = {
          entryId,
          ns: u.group[0].ns,
          kind: u.group[0].kind as Kind,
          content: redacted.text,
          createdAt: ts,
          status: "active",
          pinned: false,
          lastUsedAt: null,
          useCount: 0,
          valueScore: u.group.reduce((s, e) => s + e.valueScore, 0) / u.group.length,
        };
        addEntry(nsDir(root, entry.ns), entry);
        idx.add(entry);
        if (redacted.redacted) {
          idx.audit("warn.redacted", entry.ns, `secret redacted in ${entryId}`);
        }
        if (injectionFlags.length) {
          idx.audit("warn.promptware", entry.ns, `injection pattern in umbrella ${entryId}: ${injectionFlags[0]}`);
        }
        for (const e of u.group) {
          const updated: Entry = { ...e, status: "stale" };
          idx.add(updated);
          updateKind(nsDir(root, e.ns), e.kind, (entries) =>
            entries.map((x) => (x.entryId === e.entryId ? { ...x, status: "stale" as Status } : x)),
          );
        }
      }
      idx.audit(
        "curate",
        "-",
        `+${plan.reevaluations.length} scores, +${plan.contradictions.length} contradictions, +${plan.umbrellas.length} umbrellas`,
      );
    },
  );
}

export function formatCuratePlan(plan: CuratePlan): string[] {
  const lines: string[] = [];
  for (const r of plan.reevaluations) {
    lines.push(`revalue  ${r.entry.entryId} score ${r.entry.valueScore.toFixed(2)} -> ${r.score.toFixed(2)} (use=${r.entry.useCount})`);
  }
  for (const c of plan.contradictions) {
    lines.push(`contradiction ${c.a.entryId} vs ${c.b.entryId}  ${c.reason}`);
  }
  for (const u of plan.umbrellas) {
    lines.push(`umbrella ${u.group.map((e) => e.entryId).join("+")} -> ${u.content.slice(0, 60)}`);
  }
  if (plan.unparsable > 0) {
    lines.push(`unparsable ${plan.unparsable} pairs (LLM 输出无法解析，需人工复核)`);
  }
  return lines;
}
