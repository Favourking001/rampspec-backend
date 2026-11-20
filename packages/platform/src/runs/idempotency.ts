import { createHash } from "node:crypto";

const FINGERPRINT_VERSION = "v1";
const MAX_PAYLOAD_SIZE = 1_000_000; // 1MB

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  return `{${Object.entries(obj)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
    .join(",")}}`;
}

export function fingerprintPayload(payload: Record<string, unknown>): string {
  const serialized = JSON.stringify(payload);
  if (serialized.length > MAX_PAYLOAD_SIZE) {
    throw new Error("Payload exceeds maximum size.");
  }

  const canonicalForm = canonical(payload);
  const hash = createHash("sha256").update(canonicalForm, "utf8").digest("hex");

  return `${FINGERPRINT_VERSION}:${hash}`;
}

export function verifyPayloadFingerprint(
  payload: Record<string, unknown>,
  storedFingerprint: string,
): boolean {
  try {
    const computed = fingerprintPayload(payload);
    return constantTimeEqual(computed, storedFingerprint);
  } catch {
    return false;
  }
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}
