export * from "./signaling.js";
export * from "./transfer.js";
export * from "./validate.js";

/**
 * Wire protocol version. Carried in every frame header and in the manifest.
 * v2 (2026-11): receiver flow-control credits, AES-GCM associated data,
 * strict validation. v1 and v2 peers refuse each other with "version-mismatch".
 */
export const PROTOCOL_VERSION = 2 as const;
export const DROPBEAM_MAGIC = 0xdb;
