import type { LlmChannel } from "../../core/channel.js";
import type { AdapterLog } from "../contract.js";
export declare const WORKER_METADATA_KEY = "memcurio.internal";
/** Worker prompt timeout. Without it a hung host model would leave the job in
 *  `processing` forever (lease renews indefinitely, attempts never grow), so
 *  it would never retry or dead-letter and would squat one of the bounded
 *  extraction slots. The timeout must stay below the job lease so the job
 *  falls back to a normal retry path instead of being fenced. */
export declare const WORKER_CHAT_TIMEOUT_MS = 120000;
/** Hard cap on worker replies, mirroring the HTTP channel's response cap:
 *  an unbounded reply would accumulate in the plugin process and explode
 *  JSON parsing/transcript costs. */
export declare const WORKER_CHAT_MAX_BYTES: number;
export interface OpencodeSessionClient {
    session: {
        create(input: {
            body?: {
                title?: string;
                parentID?: string;
                metadata?: Record<string, unknown>;
                permission?: Array<{
                    permission: string;
                    pattern: string;
                    action: "allow" | "deny" | "ask";
                }>;
            };
        }): Promise<{
            data?: {
                id: string;
            };
        }>;
        prompt(input: {
            path: {
                id: string;
            };
            body: {
                system?: string;
                parts: Array<{
                    type: "text";
                    text: string;
                }>;
            };
        }): Promise<{
            data?: {
                parts?: Array<{
                    type?: string;
                    text?: string;
                }>;
            };
        }>;
        delete(input: {
            path: {
                id: string;
            };
        }): Promise<unknown>;
        list(input?: {
            query?: Record<string, unknown>;
        }): Promise<{
            data?: Array<{
                id: string;
                title?: string;
                metadata?: Record<string, unknown>;
            }>;
        }>;
    };
}
export interface OpencodeChannel extends LlmChannel {
    isWorkerSession(id: string): boolean;
    registerWorker(id: string): void;
}
export declare function createOpencodeChannel(client: OpencodeSessionClient, log?: AdapterLog): OpencodeChannel;
export declare function cleanupStaleWorkers(client: OpencodeSessionClient, log?: AdapterLog): Promise<number>;
