import { artifactFilenameForId } from "./artifacts.js";
export interface PurgeResult {
    rolloutKey: string;
    artifactId: string;
    artifactFilename: string;
    extractionJobs: number;
    sessionRows: number;
    auditRows: number;
    exportRecords: number;
    skillsRemoved: number;
}
/** Scrub one explicitly named JSONL export. Unknown backups and remote copies
 * are intentionally outside the local store's authority and remain manual
 * retention work. */
export declare function scrubExportFile(path: string, rolloutKey: string): number;
/** Physically remove one rollout from the local source store, its generated
 * artifact, extraction queue/session rows, audit references, and the managed
 * Markdown projections. The generation protocol makes the file/SQLite change
 * recoverable if the process is killed between writes. */
export declare function purgeRollout(root: string, rolloutKey: string, exportPaths?: string[]): Promise<PurgeResult | null>;
/** Keep the artifact filename helper close to purge callers without exposing
 * the database implementation details. */
export { artifactFilenameForId };
