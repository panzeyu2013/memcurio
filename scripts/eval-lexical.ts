import { readFileSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { searchMemory } from "../src/core/search.js";
import { ensureLayout } from "../src/core/paths.js";
import { writeWorkspaceText } from "../src/core/workspace.js";

interface FixtureDocument {
  rel: string;
  content: string;
}

interface FixtureCase {
  id: string;
  query: string;
  expectedRel: string;
  expectBlocked?: boolean;
  unsafeMarker?: string;
  /** Raw secret substrings that must never survive redaction in any hit. The
   *  fixture line containing them must still MATCH (proving the redaction
   *  path ran instead of the line being dropped). */
  expectRedacted?: string[];
}

interface Fixture {
  version: number;
  documents: FixtureDocument[];
  cases: FixtureCase[];
}

const fixturePath = join(import.meta.dir, "..", "evals", "fixtures", "retrieval.json");
const fixture = JSON.parse(readFileSync(fixturePath, "utf-8")) as Fixture;
if (fixture.version !== 1) {
  throw new Error(`unsupported eval fixture version: ${fixture.version}`);
}

const root = mkdtempSync(join(tmpdir(), "memcurio-eval-"));
try {
  ensureLayout(root);
  for (const document of fixture.documents) {
    writeWorkspaceText(root, document.rel, document.content);
  }

  const retrievalCases = fixture.cases.filter((item) => !item.expectBlocked);
  let retrieved = 0;
  let blockedPassed = 0;
  let leakagePassed = 0;
  const details: Array<Record<string, unknown>> = [];

  for (const item of fixture.cases) {
    const result = await searchMemory(root, item.query, 5);
    const matched = result.hits.some((hit) => hit.rel === item.expectedRel);
    const blockedOk = item.expectBlocked ? result.blocked > 0 && !result.hits.some((hit) => hit.content.includes(item.unsafeMarker ?? "")) : true;
    // Positive control: a matching line that contained a secret must come
    // back redacted ([REDACTED]) and never carry the raw value.
    const redactionTargets = item.expectRedacted ?? [];
    const redactedOk = redactionTargets.length
      ? matched
        && result.hits.some((hit) => hit.content.includes("[REDACTED]"))
        && !result.hits.some((hit) => redactionTargets.some((raw) => hit.content.includes(raw)))
      : true;
    const leakageOk = redactedOk && !result.hits.some((hit) => /(?:sk|api[_ -]?key|password|secret)\s*[:=]/i.test(hit.content));
    if (!item.expectBlocked && matched) {
      retrieved += 1;
    }
    if (item.expectBlocked && blockedOk) {
      blockedPassed += 1;
    }
    if (leakageOk) {
      leakagePassed += 1;
    }
    details.push({ id: item.id, matched, blocked: result.blocked, blockedOk, redactedOk, leakageOk });
  }

  const recallAt5 = retrievalCases.length ? retrieved / retrievalCases.length : 1;
  const report = {
    fixture: fixturePath,
    recallAt5,
    retrieval: `${retrieved}/${retrievalCases.length}`,
    injectionBlocking: `${blockedPassed}/${fixture.cases.filter((item) => item.expectBlocked).length}`,
    secretLeakageChecks: `${leakagePassed}/${fixture.cases.length}`,
    details,
  };
  console.log(JSON.stringify(report, null, 2));
  if (retrieved !== retrievalCases.length || blockedPassed !== fixture.cases.filter((item) => item.expectBlocked).length || leakagePassed !== fixture.cases.length) {
    process.exitCode = 1;
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
