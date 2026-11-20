import { createId, parseId, type OpaqueId } from "../../../domain/src/index.js";
import { CursorSigner, type CursorPosition } from "./cursor-signing.js";

export interface Project {
  readonly archivedAt: string | null;
  readonly createdAt: string;
  readonly id: OpaqueId<"project">;
  readonly name: string;
  readonly organizationId: OpaqueId<"organization">;
  readonly policy: Readonly<Record<string, unknown>>;
  readonly repositoryUrl: string | null;
  readonly slug: string;
  readonly status: "active" | "archived";
  readonly updatedAt: string;
}

export interface ProjectRepository {
  list(organizationId: OpaqueId<"organization">): Promise<readonly Project[]>;
  get(
    organizationId: OpaqueId<"organization">,
    id: OpaqueId<"project">,
  ): Promise<Project | undefined>;
  insert(project: Project): Promise<void>;
  update(project: Project): Promise<void>;
}

export interface ProjectAudit {
  record(input: {
    readonly action: string;
    readonly organizationId: string;
    readonly targetId: string;
    readonly targetType: string;
  }): Promise<void>;
}

export interface ProjectPage {
  readonly items: readonly Project[];
  readonly nextCursor: string | null;
}

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

function slug(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z][a-z0-9-]{2,62}$/u.test(normalized)) throw new Error("Invalid project slug.");
  return normalized;
}

function name(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 200) throw new Error("Invalid project name.");
  return normalized;
}

function policy(
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const copy = structuredClone(value);
  if (JSON.stringify(copy).length > 32768) {
    throw new Error("Project policy is too large.");
  }
  return Object.freeze(copy);
}

function repositoryUrl(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const normalized = value.trim();
  if (!/^https:\/\//u.test(normalized)) {
    throw new Error("Repository URL must use HTTPS.");
  }
  return normalized;
}

export class ProjectService {
  private readonly audit: ProjectAudit | undefined;
  private readonly clock: () => Date;
  private readonly repository: ProjectRepository;
  private readonly cursorSigner: CursorSigner;

  constructor(options: {
    readonly audit?: ProjectAudit;
    readonly clock?: () => Date;
    readonly repository: ProjectRepository;
    readonly cursorSecret?: string | Buffer;
  }) {
    this.audit = options.audit;
    this.clock = options.clock ?? (() => new Date());
    this.repository = options.repository;
    this.cursorSigner = new CursorSigner(options.cursorSecret);
  }

  async list(
    organizationId: string,
    cursor?: string,
    limit?: number,
  ): Promise<ProjectPage> {
    // Validate limit
    const validLimit = limit ?? DEFAULT_LIMIT;
    if (!Number.isInteger(validLimit) || validLimit < 1 || validLimit > MAX_LIMIT) {
      throw new Error("Invalid page limit.");
    }

    const organization = parseId("organization", organizationId);
    let projects = await this.repository.list(organization);

    // Sort by (createdAt ASC, id ASC) for deterministic ordering
    projects = [...projects].sort((a, b) => {
      const timeOrder = a.createdAt.localeCompare(b.createdAt);
      return timeOrder !== 0
        ? timeOrder
        : a.id.localeCompare(b.id);
    });

    let startIndex = 0;
    if (cursor) {
      // Verify and decode cursor
      const position = this.cursorSigner.verify(cursor, organizationId);
      if (!position) throw new Error("Invalid or expired cursor.");

      // Use keyset pagination: find position where (createdAt, id) > cursor position
      startIndex = projects.findIndex(
        (p) =>
          p.createdAt > position.createdAt ||
          (p.createdAt === position.createdAt && p.id > position.projectId),
      );
      if (startIndex === -1) startIndex = projects.length;
    }

    const items = projects.slice(startIndex, startIndex + validLimit);

    // Determine next cursor
    let nextCursor: string | null = null;
    if (startIndex + validLimit < projects.length) {
      const lastItem = items[items.length - 1]!;
      nextCursor = this.cursorSigner.sign(
        {
          version: 1,
          createdAt: lastItem.createdAt,
          projectId: lastItem.id,
        },
        organizationId,
      );
    }

    return { items, nextCursor };
  }

  async create(input: {
    readonly name: string;
    readonly organizationId: string;
    readonly policy?: Readonly<Record<string, unknown>>;
    readonly repositoryUrl?: string | null;
    readonly slug: string;
  }): Promise<Project> {
    const organizationId = parseId("organization", input.organizationId);
    const now = this.clock().toISOString();
    const project: Project = Object.freeze({
      archivedAt: null,
      createdAt: now,
      id: createId("project"),
      name: name(input.name),
      organizationId,
      policy: policy(input.policy ?? {}),
      repositoryUrl: repositoryUrl(input.repositoryUrl),
      slug: slug(input.slug),
      status: "active",
      updatedAt: now,
    });
    await this.repository.insert(project);
    await this.audit?.record({
      action: "project.created",
      organizationId,
      targetId: project.id,
      targetType: "project",
    });
    return project;
  }

  async get(organizationId: string, id: string): Promise<Project> {
    const organization = parseId("organization", organizationId);
    const project = await this.repository.get(organization, parseId("project", id));
    if (!project) throw new Error("Project not found.");
    return project;
  }

  async update(
    organizationId: string,
    id: string,
    input: {
      readonly name?: string;
      readonly policy?: Readonly<Record<string, unknown>>;
      readonly repositoryUrl?: string | null;
      readonly slug?: string;
    },
  ): Promise<Project> {
    const project = await this.get(organizationId, id);
    if (project.status !== "active") throw new Error("Project is not active.");
    const updated: Project = Object.freeze({
      ...project,
      ...(input.name === undefined ? {} : { name: name(input.name) }),
      ...(input.policy === undefined ? {} : { policy: policy(input.policy) }),
      ...(input.repositoryUrl === undefined
        ? {}
        : { repositoryUrl: repositoryUrl(input.repositoryUrl) }),
      ...(input.slug === undefined ? {} : { slug: slug(input.slug) }),
      updatedAt: this.clock().toISOString(),
    });
    await this.repository.update(updated);
    await this.audit?.record({
      action: "project.updated",
      organizationId: project.organizationId,
      targetId: project.id,
      targetType: "project",
    });
    return updated;
  }

  async archive(organizationId: string, id: string): Promise<Project> {
    const project = await this.get(organizationId, id);
    if (project.status === "archived") return project;
    const archivedAt = this.clock().toISOString();
    const updated: Project = Object.freeze({
      ...project,
      archivedAt,
      status: "archived",
      updatedAt: archivedAt,
    });
    await this.repository.update(updated);
    await this.audit?.record({
      action: "project.archived",
      organizationId: project.organizationId,
      targetId: project.id,
      targetType: "project",
    });
    return updated;
  }
}

export class InMemoryProjectRepository implements ProjectRepository {
  private readonly projects = new Map<string, Project>();

  list(organizationId: OpaqueId<"organization">): Promise<readonly Project[]> {
    return Promise.resolve(
      [...this.projects.values()].filter(
        (project) => project.organizationId === organizationId,
      ),
    );
  }

  get(
    organizationId: OpaqueId<"organization">,
    id: OpaqueId<"project">,
  ): Promise<Project | undefined> {
    const project = this.projects.get(id);
    return Promise.resolve(project?.organizationId === organizationId ? project : undefined);
  }

  insert(project: Project): Promise<void> {
    if (
      [...this.projects.values()].some(
        (candidate) =>
          candidate.organizationId === project.organizationId &&
          candidate.slug === project.slug,
      )
    ) {
      return Promise.reject(new Error("Project slug already exists."));
    }
    this.projects.set(project.id, project);
    return Promise.resolve();
  }

  update(project: Project): Promise<void> {
    this.projects.set(project.id, project);
    return Promise.resolve();
  }
}
