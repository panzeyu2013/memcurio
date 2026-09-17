/**
 * Parser for the bun pm pack --dry-run listing used by the package
 * allowlist gate. Extracted so the regression test pins the fail-closed
 * behavior: a dry-run format change must fail the gate, never silently pass
 * an empty file list.
 */
const PACKED_LINE = /^packed\s+\S+\s+(.+)$/;

export function parsePackedPaths(output: string): string[] {
  const packed = output
    .split("\n")
    .map((line) => PACKED_LINE.exec(line)?.[1])
    .filter((path): path is string => path !== undefined && path.length > 0);
  if (packed.length === 0) {
    throw new Error(
      "pack-check: no 'packed <size> <path>' lines in the bun pm pack --dry-run output; " +
        "refusing to pass the package allowlist gate with an empty file list. Output was:\n" +
        output.slice(0, 2000),
    );
  }
  return packed;
}
