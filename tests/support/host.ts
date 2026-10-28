/**
 * Canonical test host composition.
 *
 * Production profiles compose the tool registry together with a tool executor
 * (`dsh-base` mounts `dsh-tool-executor-native` unconditionally). Since
 * 0.2.2-alpha.2 the registry owns no execution at all: `ctx.tools.execute`
 * delegates a whole batch to the selected executor, and prompt assembly asks
 * that executor for the model-facing tool schemas. A test host that omits the
 * executor therefore fails both `systemPrompt.assemble()` and
 * `ctx.tools.execute()` with `ToolExecutorUnavailableError`.
 *
 * Tests that assemble a prompt or execute a tool must compose the same pair as
 * production; tests that only exercise config, sessions or channels can keep a
 * narrower host. This module is test-only and never imported by shipped code.
 *
 * @module
 */
import { Context } from "@deepseek-ai/cordis";
import type { Fiber } from "@deepseek-ai/cordis";
import type { ToolCallId } from "@deepseek-ai/dsh-llm";
import LlmRuntime from "@deepseek-ai/dsh-llm";
import SessionStore from "@deepseek-ai/dsh-session";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import type { ToolExecutionResult } from "@deepseek-ai/dsh-tools";
import ToolRuntime from "@deepseek-ai/dsh-tools";
import * as NativeToolExecutor from "@deepseek-ai/dsh-tool-executor-native";

/** The data services every memcurio test composition needs. */
export interface TestHost {
  readonly ctx: Context;
  readonly fibers: Fiber[];
}

export interface TestHostOptions {
  /**
   * Mount the native tool executor. Required by any test that calls
   * `systemPrompt.assemble()` or `ctx.tools.execute()`.
   */
  executor?: boolean;
}

/** Compose the host services in the same order production uses. */
export async function createTestHost(options: TestHostOptions = {}): Promise<TestHost> {
  const ctx = new Context();
  const fibers: Fiber[] = [
    await ctx.plugin(SystemPrompt),
    await ctx.plugin(ToolRuntime),
    await ctx.plugin(LlmRuntime),
    await ctx.plugin(SessionStore),
  ];
  if (options.executor === true) {
    fibers.push(await ctx.plugin(NativeToolExecutor));
  }
  return { ctx, fibers };
}

/** Dispose a host in reverse mount order, exactly like the plugin fibers. */
export async function disposeTestHost(fibers: Fiber[]): Promise<void> {
  for (const fiber of fibers.reverse()) await fiber.dispose();
}

export interface ExecuteOneInput {
  /** Provider-issued call id; tests choose stable ids for assertions. */
  callId: ToolCallId;
  name: string;
  /** Structured arguments; the batch wire form carries them as raw JSON. */
  arguments: unknown;
  signal?: AbortSignal;
  /** Owning agent, needed for scoped tools such as `memory_cite`. */
  agent?: unknown;
}

/**
 * Execute one tool call through the batch API and unwrap its result.
 *
 * `ctx.tools.execute` now takes `{ calls, signal, agent? }` and returns
 * `{ results: [{ callId, result }] }`; tests that predate the batch API pass a
 * single call and read the outcome directly. Keeping that shape in one helper
 * makes the migration one line per assertion instead of five hand-built
 * batches, and any future batch change stays local to this function.
 */
export async function executeOne(ctx: Context, input: ExecuteOneInput): Promise<ToolExecutionResult> {
  const batch = await ctx.tools.execute({
    calls: [
      {
        type: "tool-call",
        id: input.callId,
        name: input.name,
        arguments: JSON.stringify(input.arguments),
      },
    ],
    signal: input.signal ?? new AbortController().signal,
    ...(input.agent === undefined ? {} : { agent: input.agent as never }),
  });
  const first = batch.results[0];
  if (first === undefined) {
    throw new Error(`tool executor returned no result for ${input.name}`);
  }
  return first.result;
}
