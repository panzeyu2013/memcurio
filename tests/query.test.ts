import { describe, expect, test } from "bun:test";

import { retrievalQuery } from "../src/core/query.js";

describe("retrievalQuery", () => {
  test("keeps the newest text first and drops stop words", () => {
    const query = retrievalQuery([
      "please help me with the SQLite FTS5 index",
      "an older message about the deployment",
    ]);
    expect(query).toContain("sqlite fts5 index");
    expect(query).toContain("deployment");
    expect(query).not.toContain("please");
    expect(query).not.toContain("the ");
    // The newest block leads: its terms come before the older block's.
    expect(query.indexOf("sqlite")).toBeLessThan(query.indexOf("deployment"));
  });

  test("strips code fences, URLs and filesystem paths", () => {
    const query = retrievalQuery([
      "fix \`\`\`ts\nconst x = 1;\n\`\`\` and see https://example.com/a/b for /root/projects/memcurio/src/app.ts details",
    ]);
    expect(query).not.toContain("https");
    expect(query).not.toContain("/root");
    expect(query).not.toContain("const");
    expect(query).toContain("details");
  });

  test("returns an empty query when nothing searchable is left", () => {
    expect(retrievalQuery(["the a of and"])).toBe("");
    expect(retrievalQuery([])).toBe("");
  });

  test("caps the term count", () => {
    const long = Array.from({ length: 80 }, (_, i) => "term" + i).join(" ");
    expect(retrievalQuery([long]).split(" ")).toHaveLength(32);
  });
});
