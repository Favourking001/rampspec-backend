import { describe, expect, it } from "vitest";

import { InMemoryProjectRepository, ProjectService } from "./projects.js";

const organizationId = "organization_00000000-0000-4000-8000-000000000001";

describe("project service", () => {
  function service() {
    return new ProjectService({
      clock: () => new Date("2026-09-12T18:00:00.000Z"),
      repository: new InMemoryProjectRepository(),
    });
  }

  it("creates, reads, updates, archives, and paginates tenant projects", async () => {
    const projects = service();
    const project = await projects.create({
      organizationId,
      name: " Core ",
      slug: "core-app",
      repositoryUrl: "https://github.com/example/core",
    });
    expect((await projects.get(organizationId, project.id)).name).toBe("Core");
    expect((await projects.update(organizationId, project.id, { name: "Core API" })).name).toBe(
      "Core API",
    );
    expect((await projects.archive(organizationId, project.id)).status).toBe("archived");
    await expect(projects.archive(organizationId, project.id)).resolves.toMatchObject({
      status: "archived",
    });
    expect((await projects.list(organizationId, undefined, 1)).items).toHaveLength(1);
  });

  it("enforces tenant boundaries and storage constraints", async () => {
    const projects = service();
    await expect(projects.create({ organizationId, name: "App", slug: "ab" })).rejects.toThrow(
      "slug",
    );
    await expect(
      projects.create({
        organizationId,
        name: "App",
        slug: "valid-app",
        repositoryUrl: "http://github.com/example/app",
      }),
    ).rejects.toThrow("HTTPS");
    const project = await projects.create({ organizationId, name: "App", slug: "valid-app" });
    await expect(
      projects.get("organization_00000000-0000-4000-8000-000000000002", project.id),
    ).rejects.toThrow("not found");
    await expect(projects.list(organizationId, "bad-cursor")).rejects.toThrow("cursor");
  });

  it("rejects duplicate slugs and oversized policies", async () => {
    const projects = service();
    await projects.create({ organizationId, name: "App", slug: "valid-app" });
    await expect(
      projects.create({ organizationId, name: "Other", slug: "valid-app" }),
    ).rejects.toThrow("already exists");
    await expect(
      projects.create({
        organizationId,
        name: "Other",
        slug: "other-app",
        policy: { value: "x".repeat(33000) },
      }),
    ).rejects.toThrow("too large");
  });

  it("paginates projects with signed cursors", async () => {
    const projects = service();
    // Create 3 projects with staggered timestamps
    const p1 = await projects.create({ organizationId, name: "App1", slug: "app-1" });
    const p2 = await projects.create({ organizationId, name: "App2", slug: "app-2" });
    const p3 = await projects.create({ organizationId, name: "App3", slug: "app-3" });

    // First page (limit 1)
    const page1 = await projects.list(organizationId, undefined, 1);
    expect(page1.items).toHaveLength(1);
    expect(page1.nextCursor).toBeDefined();

    // Second page using cursor
    const page2 = await projects.list(organizationId, page1.nextCursor!, 1);
    expect(page2.items).toHaveLength(1);
    expect(page2.items[0]?.id).not.toBe(page1.items[0]?.id);

    // Last page
    const page3 = await projects.list(organizationId, page2.nextCursor!, 1);
    expect(page3.items).toHaveLength(1);
    expect(page3.nextCursor).toBeNull();
  });

  it("rejects tampered cursors and invalid limits", async () => {
    const projects = service();
    await projects.create({ organizationId, name: "App", slug: "app" });

    await expect(projects.list(organizationId, undefined, 0)).rejects.toThrow("limit");
    await expect(projects.list(organizationId, undefined, 101)).rejects.toThrow("limit");
    await expect(projects.list(organizationId, "tampered-cursor")).rejects.toThrow("cursor");
  });

  it("prevents cross-tenant cursor reuse", async () => {
    const projects = service();
    const otherOrg = "organization_00000000-0000-4000-8000-000000000002";

    await projects.create({ organizationId, name: "App", slug: "app" });
    await projects.create({ organizationId: otherOrg, name: "App", slug: "app-org2" });

    const page = await projects.list(organizationId, undefined, 10);
    if (!page.nextCursor) {
      // If no cursor, create more items
      await projects.create({ organizationId, name: "App2", slug: "app-2" });
      const newPage = await projects.list(organizationId, undefined, 1);
      if (!newPage.nextCursor) {
        throw new Error("Expected cursor for pagination");
      }

      // Cursor from org A used by org B should fail
      await expect(projects.list(otherOrg, newPage.nextCursor)).rejects.toThrow("cursor");
    } else {
      // Cursor from org A used by org B should fail
      await expect(projects.list(otherOrg, page.nextCursor)).rejects.toThrow("cursor");
    }
  });
});
