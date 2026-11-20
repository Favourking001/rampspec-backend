import { describe, expect, it } from "vitest";
import { ConflictError, InMemoryRunRepository, RunService } from "./service.js";

const organizationId = "organization_00000000-0000-4000-8000-000000000001";
const projectId = "project_00000000-0000-4000-8000-000000000002";
const targetId = "target_00000000-0000-4000-8000-000000000003";
const suiteId = "suite_00000000-0000-4000-8000-000000000004";

describe("run creation", () => {
  it("creates requested runs and returns the same record for retries", async () => {
    const service = new RunService({ repository: new InMemoryRunRepository() });
    const input = {
      organizationId,
      projectId,
      targetId,
      suiteId,
      suiteVersion: "1.0.0",
      idempotencyKey: "request-key-000001",
      effectiveConfig: { network: "testnet" },
    };
    const first = await service.create(input);
    expect(first.state).toBe("requested");
    expect(await service.create(input)).toEqual(first);
    expect(first.effectiveConfigHash).toHaveLength(64);
  });

  it("rejects malformed idempotency keys and identifiers", async () => {
    const service = new RunService({ repository: new InMemoryRunRepository() });
    await expect(
      service.create({
        organizationId,
        projectId,
        targetId,
        suiteId,
        suiteVersion: "1.0.0",
        idempotencyKey: "short",
        effectiveConfig: {},
      }),
    ).rejects.toThrow("idempotency");
  });

  it("returns same run on safe idempotent retry with identical payload", async () => {
    const service = new RunService({ repository: new InMemoryRunRepository() });

    const payload = {
      projectId,
      targetId,
      suiteId,
      suiteVersion: "1.0.0",
      effectiveConfig: { network: "testnet" },
    };

    const run1 = await service.create({
      organizationId,
      idempotencyKey: "key123",
      ...payload,
    });

    // Retry with identical payload
    const run2 = await service.create({
      organizationId,
      idempotencyKey: "key123",
      ...payload,
    });

    expect(run2.id).toBe(run1.id);
  });

  it("rejects conflicting payload with same idempotency key", async () => {
    const service = new RunService({ repository: new InMemoryRunRepository() });

    await service.create({
      organizationId,
      idempotencyKey: "key123",
      projectId,
      targetId,
      suiteId,
      suiteVersion: "1.0.0",
      effectiveConfig: {},
    });

    // Same key, different project
    await expect(
      service.create({
        organizationId,
        idempotencyKey: "key123",
        projectId: "project_different",
        targetId,
        suiteId,
        suiteVersion: "1.0.0",
        effectiveConfig: {},
      }),
    ).rejects.toThrow(ConflictError);
  });

  it("rejects conflict when only effective config differs", async () => {
    const service = new RunService({ repository: new InMemoryRunRepository() });

    await service.create({
      organizationId,
      idempotencyKey: "key123",
      projectId,
      targetId,
      suiteId,
      suiteVersion: "1.0.0",
      effectiveConfig: { network: "testnet" },
    });

    // Same key, different config
    await expect(
      service.create({
        organizationId,
        idempotencyKey: "key123",
        projectId,
        targetId,
        suiteId,
        suiteVersion: "1.0.0",
        effectiveConfig: { network: "pubnet" },
      }),
    ).rejects.toThrow(ConflictError);
  });

  it("allows same key in different organizations", async () => {
    const service = new RunService({ repository: new InMemoryRunRepository() });

    const org1 = "organization_00000000-0000-4000-8000-000000000001";
    const org2 = "organization_00000000-0000-4000-8000-000000000002";

    const payload = {
      projectId,
      targetId,
      suiteId,
      suiteVersion: "1.0.0",
      effectiveConfig: {},
    };

    const run1 = await service.create({
      organizationId: org1,
      idempotencyKey: "key123",
      ...payload,
    });

    // Same key, different org: allowed
    const run2 = await service.create({
      organizationId: org2,
      idempotencyKey: "key123",
      ...payload,
    });

    expect(run1.id).not.toBe(run2.id);
    expect(run1.organizationId).not.toBe(run2.organizationId);
  });

  it("handles payload with reordered JSON keys consistently", async () => {
    const service = new RunService({ repository: new InMemoryRunRepository() });

    const run1 = await service.create({
      organizationId,
      idempotencyKey: "key123",
      projectId,
      targetId,
      suiteId,
      suiteVersion: "1.0.0",
      effectiveConfig: { a: 1, b: 2 },
    });

    // Same payload with reordered keys (canonical form makes them equivalent)
    const run2 = await service.create({
      organizationId,
      idempotencyKey: "key123",
      projectId,
      targetId,
      suiteId,
      suiteVersion: "1.0.0",
      effectiveConfig: { b: 2, a: 1 },
    });

    expect(run2.id).toBe(run1.id);
  });
});
