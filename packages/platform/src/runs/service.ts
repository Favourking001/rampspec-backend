import { createHash } from "node:crypto";
import { createId, parseId, type OpaqueId } from "../../../domain/src/index.js";
import { fingerprintPayload, verifyPayloadFingerprint } from "./idempotency.js";

export type RunState =
  | "blocked"
  | "cancelled"
  | "completed"
  | "expired"
  | "failed"
  | "policy_check"
  | "provisioning"
  | "queued"
  | "requested"
  | "running"
  | "waiting_external"
  | "finalizing";

export interface Run {
  readonly createdAt: string;
  readonly effectiveConfig: Readonly<Record<string, unknown>>;
  readonly effectiveConfigHash: string;
  readonly id: OpaqueId<"run">;
  readonly idempotencyKey: string;
  readonly organizationId: OpaqueId<"organization">;
  readonly projectId: OpaqueId<"project">;
  readonly state: RunState;
  readonly suiteId: OpaqueId<"suite">;
  readonly suiteVersion: string;
  readonly targetId: OpaqueId<"target">;
}

export interface IdempotencyRecord {
  readonly key: string;
  readonly fingerprint: string | null;
  readonly runId: string;
}

export interface RunRepository {
  insert(run: Run): Promise<void>;
  findByIdempotency(
    organizationId: OpaqueId<"organization">,
    key: string,
  ): Promise<Run | undefined>;
  findIdempotencyRecord(
    organizationId: OpaqueId<"organization">,
    key: string,
  ): Promise<IdempotencyRecord | undefined>;
  storeIdempotencyRecord(
    organizationId: OpaqueId<"organization">,
    record: IdempotencyRecord,
  ): Promise<void>;
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

export class ConflictError extends Error {
  readonly status = 409;
  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
  }
}

export class RunService {
  private readonly clock: () => Date;
  private readonly repository: RunRepository;

  constructor(options: {
    readonly repository: RunRepository;
    readonly clock?: () => Date;
  }) {
    this.repository = options.repository;
    this.clock = options.clock ?? (() => new Date());
  }

  async create(input: {
    readonly organizationId: string;
    readonly projectId: string;
    readonly targetId: string;
    readonly suiteId: string;
    readonly suiteVersion: string;
    readonly idempotencyKey: string;
    readonly effectiveConfig: Readonly<Record<string, unknown>>;
  }): Promise<Run> {
    if (input.idempotencyKey.length < 16 || input.idempotencyKey.length > 128) {
      throw new Error("Invalid idempotency key.");
    }

    const organizationId = parseId("organization", input.organizationId);

    // Compute fingerprint of request payload
    const fingerprint = fingerprintPayload({
      projectId: input.projectId,
      targetId: input.targetId,
      suiteId: input.suiteId,
      suiteVersion: input.suiteVersion,
      effectiveConfig: input.effectiveConfig,
    });

    // Check for existing idempotency record
    const existing = await this.repository.findIdempotencyRecord(
      organizationId,
      input.idempotencyKey,
    );

    if (existing) {
      // Existing key found
      if (existing.fingerprint === null) {
        // Legacy row without fingerprint: return original run (safe)
        const run = await this.repository.findByIdempotency(organizationId, input.idempotencyKey);
        if (run) return run;
      }

      if (existing.fingerprint === fingerprint) {
        // Same key, same payload: safe retry
        const run = await this.repository.findByIdempotency(organizationId, input.idempotencyKey);
        if (run) return run;
      }

      // Different payload: CONFLICT
      throw new ConflictError("Idempotency key payload conflict.");
    }

    // New key: create run and store fingerprint
    const run: Run = Object.freeze({
      createdAt: this.clock().toISOString(),
      effectiveConfig: Object.freeze(structuredClone(input.effectiveConfig)),
      effectiveConfigHash: hash(input.effectiveConfig),
      id: createId("run"),
      idempotencyKey: input.idempotencyKey,
      organizationId,
      projectId: parseId("project", input.projectId),
      state: "requested",
      suiteId: parseId("suite", input.suiteId),
      suiteVersion: input.suiteVersion,
      targetId: parseId("target", input.targetId),
    });

    await this.repository.insert(run);
    await this.repository.storeIdempotencyRecord(organizationId, {
      key: input.idempotencyKey,
      fingerprint,
      runId: run.id,
    });

    return run;
  }
}

export class InMemoryRunRepository implements RunRepository {
  private readonly runs = new Map<string, Run>();
  private readonly idempotencyRecords = new Map<string, IdempotencyRecord>();

  insert(run: Run): Promise<void> {
    this.runs.set(`${run.organizationId}:${run.idempotencyKey}`, run);
    return Promise.resolve();
  }

  findByIdempotency(
    organizationId: OpaqueId<"organization">,
    key: string,
  ): Promise<Run | undefined> {
    return Promise.resolve(this.runs.get(`${organizationId}:${key}`));
  }

  findIdempotencyRecord(
    organizationId: OpaqueId<"organization">,
    key: string,
  ): Promise<IdempotencyRecord | undefined> {
    return Promise.resolve(this.idempotencyRecords.get(`${organizationId}:${key}`));
  }

  storeIdempotencyRecord(
    organizationId: OpaqueId<"organization">,
    record: IdempotencyRecord,
  ): Promise<void> {
    this.idempotencyRecords.set(`${organizationId}:${record.key}`, record);
    return Promise.resolve();
  }
}
