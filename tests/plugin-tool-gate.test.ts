import { describe, expect, test } from "bun:test";

import { toolGateOpen } from "../src/plugin/index.js";

describe("tool gate epoch", () => {
  test("requires both enabled state and the captured epoch", () => {
    expect(toolGateOpen({ enabled: true, gateEpoch: 3 }, 3)).toBe(true);
    expect(toolGateOpen({ enabled: false, gateEpoch: 3 }, 3)).toBe(false);
    expect(toolGateOpen({ enabled: true, gateEpoch: 4 }, 3)).toBe(false);
  });
});
