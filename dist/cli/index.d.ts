#!/usr/bin/env node
/** Thrown by CLI-level validation so the top-level handler can classify the
 *  exit code without sniffing error-message strings. */
export declare class UsageError extends Error {
}
export declare function main(argv: string[]): Promise<number>;
