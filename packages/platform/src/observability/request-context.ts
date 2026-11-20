import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

export interface RequestContext {
  readonly requestId: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

export function getRequestId(): string {
  return storage.getStore()?.requestId ?? "unknown";
}

export function withRequestContext<T>(
  context: RequestContext,
  fn: () => T | Promise<T>,
): T | Promise<T> {
  return storage.run(context, fn);
}

const VALID_REQUEST_ID = /^[A-Za-z0-9._-]{1,64}$/u;

export function validateAndGenerateRequestId(inbound?: string): string {
  if (!inbound) return generateRequestId();

  if (inbound.length > 64) return generateRequestId();
  if (!VALID_REQUEST_ID.test(inbound)) return generateRequestId();

  return inbound;
}

function generateRequestId(): string {
  return `req_${randomUUID().replaceAll("-", "").slice(0, 20)}`;
}
