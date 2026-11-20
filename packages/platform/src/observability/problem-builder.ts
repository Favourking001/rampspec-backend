import { getRequestId } from "./request-context.js";

export interface Problem {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail?: string;
  readonly requestId: string;
}

export function buildProblem(options: {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail?: string;
}): Problem {
  return {
    ...options,
    requestId: getRequestId(),
  };
}
