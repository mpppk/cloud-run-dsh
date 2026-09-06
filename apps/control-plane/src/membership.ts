// Workspace membership (仕様書 section 21, 26 item 7, 実装手順書 section 25)
//
// Authorization = authenticated identity + workspace membership.
// Every workspace-scoped route MUST verify membership before acting.
//
// The Cloud SQL schema (実装手順書 section 3) has no dedicated members table in
// this milestone, so the store is an injected seam: production can back it with
// a table or IAM-derived source; tests use the in-memory implementation.

import { forbidden } from "./errors.js";

export interface MembershipStore {
  /** Returns true when `userId` is a member of `workspaceId`. */
  isMember(workspaceId: string, userId: string): Promise<boolean>;
  /** Registers a member (used when creating workspaces; owner is added automatically). */
  addMember(workspaceId: string, userId: string): Promise<void>;
  /** Removes a member. */
  removeMember(workspaceId: string, userId: string): Promise<void>;
  /** Lists member user ids. */
  listMembers(workspaceId: string): Promise<string[]>;
  /**
   * Lists workspace ids visible to `userId` (issue #137).
   *
   * A single filtered lookup — never a full workspace scan. Each backend
   * derives it from its own source of truth, the same set `isMember` answers
   * from: the owner column in production (`OwnerMembershipStore`, where the
   * owner is the only member — shared non-owner members cannot exist in this
   * milestone because `addMember` rejects them), the member map in memory
   * (`InMemoryMembershipStore`, where shared members ARE included).
   */
  listWorkspaceIdsForUser(userId: string): Promise<string[]>;
}

export class InMemoryMembershipStore implements MembershipStore {
  private readonly members = new Map<string, Set<string>>();

  async isMember(workspaceId: string, userId: string): Promise<boolean> {
    return this.members.get(workspaceId)?.has(userId) ?? false;
  }

  async addMember(workspaceId: string, userId: string): Promise<void> {
    let set = this.members.get(workspaceId);
    if (!set) {
      set = new Set();
      this.members.set(workspaceId, set);
    }
    set.add(userId);
  }

  async removeMember(workspaceId: string, userId: string): Promise<void> {
    this.members.get(workspaceId)?.delete(userId);
  }

  async listMembers(workspaceId: string): Promise<string[]> {
    return Array.from(this.members.get(workspaceId) ?? []);
  }

  async listWorkspaceIdsForUser(userId: string): Promise<string[]> {
    const ids: string[] = [];
    for (const [workspaceId, members] of this.members) {
      if (members.has(userId)) ids.push(workspaceId);
    }
    return ids;
  }
}

export interface MembershipDeps {
  readonly membership: MembershipStore;
}

/** Throws 403 unless the user is a member of the workspace. */
export async function assertMember(
  deps: MembershipDeps,
  workspaceId: string,
  userId: string,
): Promise<void> {
  if (!(await deps.membership.isMember(workspaceId, userId))) {
    throw forbidden("not a member of this workspace");
  }
}
