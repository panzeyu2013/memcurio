/**
 * Shared fixtures for the consolidation suites.
 *
 * The scripted native channel is used by both the runConsolidation wiring
 * tests and the LLM loop tests, so it lives here instead of in either file.
 * Test-only module; never imported by shipped code.
 */
import type { AgentTurnMessage, LlmChannel } from "../../src/core/channel.js";

/** One scripted native tool-calling turn. */
export interface ScriptedTurn {
  text?: string;
  /** Thinking content the provider would return; the loop must replay it. */
  reasoning?: string;
  calls?: Array<{ name: string; args?: unknown; raw?: string }>;
}

/** A scripted native tool-calling channel: replays canned turns in order (the
 *  last turn repeats) and optionally records every system prompt + transcript.
 *
 *  A scripted entry may be a {@link ScriptedTurn} or the JSON-prose string the
 *  old text protocol used; the string form is decoded into the tool call it
 *  named so existing scripts still describe the same run through the native
 *  channel. The channel has no text transport: the loop must reach the model
 *  through a real tool-calling turn. */
export function scriptedChannel(
  script: Array<string | ScriptedTurn>,
  prompts?: Array<{ system: string; user: string }>,
): LlmChannel {
  const turns = script.map<ScriptedTurn>((entry) => {
    if (typeof entry !== "string") return entry;
    const parsed = JSON.parse(entry) as { tool?: string; args?: unknown };
    return parsed.tool ? { calls: [{ name: parsed.tool, args: parsed.args ?? {} }] } : {};
  });
  let i = 0;
  return {
    name: "scripted",
    async agent(system, messages) {
      prompts?.push({ system, user: messages.map(renderScriptedTurn).join("\n") });
      const turn = turns[Math.min(i, turns.length - 1)] ?? { calls: [{ name: "finish", args: { report: "fallback" } }] };
      i += 1;
      const calls = (turn.calls ?? []).map((call, index) => ({
        id: `call-${String(i)}-${String(index)}`,
        name: call.name,
        arguments: call.raw ?? JSON.stringify(call.args ?? {}),
      }));
      return {
        text: turn.text ?? "",
        toolCalls: calls,
        finish: calls.length > 0 ? "tool-calls" : "stop",
        ...(turn.reasoning === undefined ? {} : { reasoning: turn.reasoning }),
      };
    },
  };
}

function renderScriptedTurn(message: AgentTurnMessage): string {
  if (message.role === "user") return `USER: ${message.text}`;
  if (message.role === "assistant") {
    const calls = message.toolCalls.map((call) => `${call.name}(${call.arguments})`).join(" ");
    const reasoning = message.reasoning === undefined ? "" : `REASONING: ${message.reasoning} `;
    return `ASSISTANT: ${reasoning}${message.text ?? ""} ${calls}`.trim();
  }
  return `TOOL ${message.name}${message.isError === true ? " ERROR" : ""}: ${message.content}`;
}
