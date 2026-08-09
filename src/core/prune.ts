import type { Entry, Status } from "./mdStore.js";

export interface PruneConfig {
  staleDays: number;
  archivedDays: number;
  graceDays: number;
}

export interface Transition {
  entryId: string;
  ns: string;
  kind: string;
  from: Status;
  to: Status;
  reason: string;
}

function daysBetween(now: Date, d: Date): number {
  const t = d.getTime();
  if (Number.isNaN(t)) {
    return Infinity;
  }
  return (now.getTime() - t) / 86_400_000;
}

export function computeTransitions(entries: Entry[], now: Date, cfg: PruneConfig): Transition[] {
  const out: Transition[] = [];
  for (const e of entries) {
    if (e.pinned || e.kind === "COMPACT" || e.status === "deleted" || e.status === "archived") {
      continue;
    }
    const lastUsed = e.lastUsedAt ? new Date(e.lastUsedAt) : new Date(e.createdAt);
    const ageDays = daysBetween(now, new Date(e.createdAt));
    const idleDays = daysBetween(now, lastUsed);
    if (e.status === "active") {
      if (ageDays >= cfg.graceDays && idleDays >= cfg.staleDays) {
        out.push({
          entryId: e.entryId,
          ns: e.ns,
          kind: e.kind,
          from: "active",
          to: "stale",
          reason: `idle ${Math.round(idleDays)}d >= stale ${cfg.staleDays}d, age ${Math.round(ageDays)}d >= grace ${cfg.graceDays}d`,
        });
      }
    } else if (e.status === "stale" && idleDays >= cfg.archivedDays) {
      out.push({
        entryId: e.entryId,
        ns: e.ns,
        kind: e.kind,
        from: "stale",
        to: "archived",
        reason: `idle ${Math.round(idleDays)}d >= archived ${cfg.archivedDays}d`,
      });
    }
  }
  return out;
}

export function formatTransition(t: Transition): string {
  return `${t.from.padEnd(7)} -> ${t.to.padEnd(8)} ${t.entryId} ${t.ns}/${t.kind}  ${t.reason}`;
}
