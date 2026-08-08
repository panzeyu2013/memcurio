import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { configPath } from "./paths.js";

export interface Config {
  namespace: { default: string };
  budget: { maxInjectTokens: number; topKStatic: number };
  prune: { staleDays: number; archivedDays: number; graceDays: number };
}

export const DEFAULT_CONFIG: Config = {
  namespace: { default: "default" },
  budget: { maxInjectTokens: 1500, topKStatic: 10 },
  prune: { staleDays: 30, archivedDays: 90, graceDays: 3 },
};

export function loadConfig(root: string): Config {
  const path = configPath(root);
  if (!existsSync(path)) {
    writeFileSync(path, JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n", { mode: 0o600 });
    return { ...DEFAULT_CONFIG };
  }
  const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<Config>;
  return {
    namespace: { ...DEFAULT_CONFIG.namespace, ...parsed.namespace },
    budget: { ...DEFAULT_CONFIG.budget, ...parsed.budget },
    prune: { ...DEFAULT_CONFIG.prune, ...parsed.prune },
  };
}
