import { createHmac, randomBytes } from "node:crypto";

const CURSOR_VERSION = 1;
const CURSOR_ALGORITHM = "sha256";

export interface CursorPosition {
  readonly version: number;
  readonly createdAt: string;
  readonly projectId: string;
}

export class CursorSigner {
  private readonly secret: Buffer;

  constructor(secret?: string | Buffer) {
    this.secret =
      typeof secret === "string"
        ? Buffer.from(secret, "utf8")
        : secret ?? randomBytes(32);
  }

  sign(position: CursorPosition, organizationId: string): string {
    const payload = JSON.stringify({
      version: CURSOR_VERSION,
      organizationId, // bound to org
      createdAt: position.createdAt,
      projectId: position.projectId,
    });

    const signature = createHmac(CURSOR_ALGORITHM, this.secret)
      .update(payload, "utf8")
      .digest("base64url");

    const cursor = JSON.stringify({ ...position, signature });
    return Buffer.from(cursor, "utf8").toString("base64url");
  }

  verify(cursor: string, organizationId: string): CursorPosition | null {
    try {
      if (cursor.length > 512) return null; // bounded

      const payload = Buffer.from(cursor, "base64url").toString("utf8");
      const obj = JSON.parse(payload) as Record<string, unknown>;

      if (obj.version !== CURSOR_VERSION) return null;

      // Reconstruct to verify signature
      const toBind = JSON.stringify({
        version: obj.version,
        organizationId,
        createdAt: obj.createdAt,
        projectId: obj.projectId,
      });

      const expected = createHmac(CURSOR_ALGORITHM, this.secret)
        .update(toBind, "utf8")
        .digest("base64url");

      // Constant-time comparison
      if (!this.constantTimeEqual(expected as string, obj.signature as string)) {
        return null;
      }

      return {
        version: obj.version as number,
        createdAt: obj.createdAt as string,
        projectId: obj.projectId as string,
      };
    } catch {
      return null;
    }
  }

  private constantTimeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let result = 0;
    for (let i = 0; i < a.length; i++) {
      result |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return result === 0;
  }
}
