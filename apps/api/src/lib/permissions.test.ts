import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

// Mock the Discord REST client so we can detect exactly when a live fetch happens.
vi.mock("./discord-client.js", () => ({
  discord: { getGuildMember: vi.fn() },
}));

import { CASUAL_SERVER_ID } from "@searchlight/shared";
import prisma from "./prisma.js";
import { env } from "./env.js";
import { discord } from "./discord-client.js";
import {
  assertServerMembership,
  getListingAccess,
  getUserPermissions,
  getUserRoleIds,
  isMemberOfSomeServer,
  userPassesDiscordRoleGate,
} from "./permissions.js";

const USER_ID = "test-perm-ttl-user";
const SERVER_ID = "test-perm-ttl-server";

const mockGetMember = discord.getGuildMember as unknown as ReturnType<typeof vi.fn>;

async function setCache(roles: string[], ageMs: number) {
  const cachedAt = new Date(Date.now() - ageMs);
  await prisma.serverMembershipCache.upsert({
    where: { userId_serverId: { userId: USER_ID, serverId: SERVER_ID } },
    update: { isMember: true, roles, cachedAt },
    create: { userId: USER_ID, serverId: SERVER_ID, isMember: true, roles, cachedAt },
  });
}

async function setNonMemberCache(ageMs: number) {
  const cachedAt = new Date(Date.now() - ageMs);
  await prisma.serverMembershipCache.upsert({
    where: { userId_serverId: { userId: USER_ID, serverId: SERVER_ID } },
    update: { isMember: false, roles: [], cachedAt },
    create: { userId: USER_ID, serverId: SERVER_ID, isMember: false, roles: [], cachedAt },
  });
}

describe("getUserRoleIds — cache TTL (1 hour default, 1 minute when privileged)", () => {
  beforeAll(async () => {
    await prisma.serverMembershipCache.deleteMany({ where: { userId: USER_ID } });
    await prisma.authSession.deleteMany({ where: { userId: USER_ID } });
    await prisma.user.deleteMany({ where: { discordId: USER_ID } });
    await prisma.server.deleteMany({ where: { id: SERVER_ID } });

    await prisma.user.create({
      data: {
        discordId: USER_ID,
        username: "perm-ttl",
        displayName: "Perm TTL",
        avatarUrl: "https://example.com/a.png",
        discordAccessToken: "tok",
        discordRefreshToken: "ref",
        discordTokenExpiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    await prisma.server.create({ data: { id: SERVER_ID, name: "Perm TTL Server" } });
  });

  afterAll(async () => {
    await prisma.serverMembershipCache.deleteMany({ where: { userId: USER_ID } });
    await prisma.user.deleteMany({ where: { discordId: USER_ID } });
    await prisma.server.deleteMany({ where: { id: SERVER_ID } });
  });

  beforeEach(() => {
    mockGetMember.mockReset();
    mockGetMember.mockResolvedValue({ roles: ["fresh-role"], nick: null });
  });

  test("default read serves a 30-minute-old cache without calling Discord", async () => {
    await setCache(["cached-role"], 30 * 60 * 1000);
    const roles = await getUserRoleIds(USER_ID, SERVER_ID, false);
    expect(roles).toEqual(["cached-role"]);
    expect(mockGetMember).not.toHaveBeenCalled();
  });

  test("privileged read refetches a 30-minute-old cache (older than 1 min)", async () => {
    await setCache(["cached-role"], 30 * 60 * 1000);
    const roles = await getUserRoleIds(USER_ID, SERVER_ID, true);
    expect(mockGetMember).toHaveBeenCalledOnce();
    expect(roles).toEqual(["fresh-role"]);
  });

  test("privileged read still serves a 10-second-old cache (within 1 min)", async () => {
    await setCache(["cached-role"], 10 * 1000);
    const roles = await getUserRoleIds(USER_ID, SERVER_ID, true);
    expect(roles).toEqual(["cached-role"]);
    expect(mockGetMember).not.toHaveBeenCalled();
  });
  test("denies a gated game when Discord role verification fails", async () => {
    await setCache(["stale-role"], 2 * 60 * 1000);
    mockGetMember.mockRejectedValue(new Error("Discord unavailable"));
    expect(await userPassesDiscordRoleGate(USER_ID, SERVER_ID, "stale-role")).toBe(false);
  });
});

describe("assertServerMembership — cached membership", () => {
  beforeAll(async () => {
    await prisma.serverMembershipCache.deleteMany({ where: { userId: USER_ID } });
    await prisma.user.deleteMany({ where: { discordId: USER_ID } });
    await prisma.server.deleteMany({ where: { id: SERVER_ID } });

    await prisma.user.create({
      data: {
        discordId: USER_ID,
        username: "perm-ttl",
        displayName: "Perm TTL",
        avatarUrl: "https://example.com/a.png",
        discordAccessToken: "tok",
        discordRefreshToken: "ref",
        discordTokenExpiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    await prisma.server.create({ data: { id: SERVER_ID, name: "Perm TTL Server" } });
  });

  afterAll(async () => {
    await prisma.serverMembershipCache.deleteMany({ where: { userId: USER_ID } });
    await prisma.user.deleteMany({ where: { discordId: USER_ID } });
    await prisma.server.deleteMany({ where: { id: SERVER_ID } });
  });

  beforeEach(async () => {
    await prisma.serverMembershipCache.deleteMany({ where: { userId: USER_ID } });
    mockGetMember.mockReset();
  });

  test("rejects a non-member whose role lookup was cached", async () => {
    // GET /servers resolves permissions for every server, caching non-members too.
    mockGetMember.mockResolvedValue(null);
    expect([...(await getUserPermissions(USER_ID, SERVER_ID))]).toEqual([]);

    await expect(assertServerMembership(USER_ID, SERVER_ID)).rejects.toMatchObject({
      statusCode: 403,
    });
  });

  test("accepts a cached member without calling Discord", async () => {
    await setCache([], 30 * 60 * 1000);
    await assertServerMembership(USER_ID, SERVER_ID);
    expect(mockGetMember).not.toHaveBeenCalled();
  });

  test("re-checks a membership cached longer than an hour ago", async () => {
    await setCache([], 2 * 60 * 60 * 1000);
    mockGetMember.mockResolvedValue(null);
    await expect(assertServerMembership(USER_ID, SERVER_ID)).rejects.toMatchObject({
      statusCode: 403,
    });
    expect(mockGetMember).toHaveBeenCalledOnce();
  });

  test("re-checks a cached non-member after a minute, so joining takes effect", async () => {
    mockGetMember.mockResolvedValue(null);
    await expect(assertServerMembership(USER_ID, SERVER_ID)).rejects.toMatchObject({
      statusCode: 403,
    });
    await prisma.serverMembershipCache.update({
      where: { userId_serverId: { userId: USER_ID, serverId: SERVER_ID } },
      data: { cachedAt: new Date(Date.now() - 2 * 60 * 1000) },
    });

    mockGetMember.mockResolvedValue({ roles: [], nick: null });
    await assertServerMembership(USER_ID, SERVER_ID);
    expect(mockGetMember).toHaveBeenCalledTimes(2);
  });
});

describe("isMemberOfSomeServer", () => {
  const OTHER_SERVER_ID = "test-perm-ttl-server-2";
  const HOUR = 60 * 60 * 1000;

  async function cache(serverId: string, isMember: boolean, ageMs: number) {
    const row = { isMember, roles: [], cachedAt: new Date(Date.now() - ageMs) };
    await prisma.serverMembershipCache.upsert({
      where: { userId_serverId: { userId: USER_ID, serverId } },
      update: row,
      create: { userId: USER_ID, serverId, ...row },
    });
  }

  beforeAll(async () => {
    await prisma.serverMembershipCache.deleteMany({ where: { userId: USER_ID } });
    await prisma.user.deleteMany({ where: { discordId: USER_ID } });
    await prisma.server.deleteMany({ where: { id: { in: [SERVER_ID, OTHER_SERVER_ID] } } });

    await prisma.user.create({
      data: {
        discordId: USER_ID,
        username: "perm-ttl",
        displayName: "Perm TTL",
        avatarUrl: "https://example.com/a.png",
        discordAccessToken: "tok",
        discordRefreshToken: "ref",
        discordTokenExpiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    await prisma.server.createMany({
      data: [
        { id: SERVER_ID, name: "Perm TTL Server" },
        { id: OTHER_SERVER_ID, name: "Perm TTL Server 2" },
      ],
    });
    // It asks about every registered server: only this file's are its to ask about.
    const findServers = prisma.server.findMany.bind(prisma.server);
    vi.spyOn(prisma.server, "findMany").mockImplementation(((args: { where?: object }) =>
      findServers({
        ...args,
        where: { AND: [args?.where ?? {}, { id: { in: [SERVER_ID, OTHER_SERVER_ID] } }] },
      })) as never);
  });

  afterAll(async () => {
    vi.mocked(prisma.server.findMany).mockRestore();
    await prisma.serverMembershipCache.deleteMany({ where: { userId: USER_ID } });
    await prisma.user.deleteMany({ where: { discordId: USER_ID } });
    await prisma.server.deleteMany({ where: { id: { in: [SERVER_ID, OTHER_SERVER_ID] } } });
  });

  beforeEach(async () => {
    await prisma.serverMembershipCache.deleteMany({ where: { userId: USER_ID } });
    mockGetMember.mockReset();
    mockGetMember.mockResolvedValue(null);
  });

  test("asks a server the cache says they're in first, without calling Discord", async () => {
    await cache(OTHER_SERVER_ID, true, 30 * 60 * 1000);
    expect(await isMemberOfSomeServer(USER_ID)).toBe(true);
    expect(mockGetMember).not.toHaveBeenCalled();
  });

  test("re-checks a membership cached over an hour ago: someone who left is no member", async () => {
    await cache(SERVER_ID, true, 2 * HOUR);
    await cache(OTHER_SERVER_ID, false, 10 * 1000);
    expect(await isMemberOfSomeServer(USER_ID)).toBe(false);
    expect(mockGetMember).toHaveBeenCalledOnce();
  });

  test("asks Discord about servers never checked", async () => {
    mockGetMember.mockImplementation(async (serverId: string) =>
      serverId === OTHER_SERVER_ID ? { roles: [], nick: null } : null,
    );
    expect(await isMemberOfSomeServer(USER_ID)).toBe(true);
  });

  test("a failed lookup doesn't matter once another server says yes", async () => {
    mockGetMember.mockImplementation(async (serverId: string) => {
      if (serverId === SERVER_ID) throw new Error("Discord unavailable");
      return { roles: [], nick: null };
    });
    expect(await isMemberOfSomeServer(USER_ID)).toBe(true);
  });

  test("throws when a lookup failed and no server said yes", async () => {
    await cache(OTHER_SERVER_ID, false, 10 * 1000);
    mockGetMember.mockRejectedValue(new Error("Discord unavailable"));
    await expect(isMemberOfSomeServer(USER_ID)).rejects.toThrow("Discord unavailable");
  });

  test("global admins count as members without a lookup", async () => {
    const previousAdmins = env.ADMIN_DISCORD_IDS;
    env.ADMIN_DISCORD_IDS = USER_ID;
    try {
      expect(await isMemberOfSomeServer(USER_ID)).toBe(true);
    } finally {
      env.ADMIN_DISCORD_IDS = previousAdmins;
    }
    expect(mockGetMember).not.toHaveBeenCalled();
  });

  test("gives games.create on Casual Games to members of some server only", async () => {
    await cache(SERVER_ID, true, 10 * 1000);
    expect([...(await getUserPermissions(USER_ID, CASUAL_SERVER_ID, true))]).toEqual([
      "games.create",
    ]);
    await cache(SERVER_ID, false, 10 * 1000);
    await cache(OTHER_SERVER_ID, false, 10 * 1000);
    expect(await getUserPermissions(USER_ID, CASUAL_SERVER_ID, true)).toEqual(new Set());
  });

  test("the listing gives games.create on Casual Games when told they're in a server", async () => {
    expect(await getListingAccess(USER_ID, CASUAL_SERVER_ID, false, undefined, true)).toEqual({
      isMember: true,
      permissions: new Set(["games.create"]),
    });
    expect(await getListingAccess(USER_ID, CASUAL_SERVER_ID, false)).toEqual({
      isMember: true,
      permissions: new Set(),
    });
    expect(mockGetMember).not.toHaveBeenCalled();
  });
});

describe("getListingAccess — answers from the cache, refreshes in the background", () => {
  const ROLE_ID = "test-perm-ttl-listing-role";
  const HOUR = 60 * 60 * 1000;

  async function cachedRoles() {
    const row = await prisma.serverMembershipCache.findUnique({
      where: { userId_serverId: { userId: USER_ID, serverId: SERVER_ID } },
    });
    return row?.roles;
  }

  beforeAll(async () => {
    await prisma.serverMembershipCache.deleteMany({ where: { userId: USER_ID } });
    await prisma.rolePermission.deleteMany({ where: { serverId: SERVER_ID } });
    await prisma.user.deleteMany({ where: { discordId: USER_ID } });
    await prisma.server.deleteMany({ where: { id: SERVER_ID } });

    await prisma.user.create({
      data: {
        discordId: USER_ID,
        username: "perm-ttl",
        displayName: "Perm TTL",
        avatarUrl: "https://example.com/a.png",
        discordAccessToken: "tok",
        discordRefreshToken: "ref",
        discordTokenExpiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    await prisma.server.create({ data: { id: SERVER_ID, name: "Perm TTL Server" } });
    await prisma.rolePermission.create({
      data: { serverId: SERVER_ID, discordRoleId: ROLE_ID, permission: "games.create" },
    });
  });

  afterAll(async () => {
    await prisma.serverMembershipCache.deleteMany({ where: { userId: USER_ID } });
    await prisma.rolePermission.deleteMany({ where: { serverId: SERVER_ID } });
    await prisma.user.deleteMany({ where: { discordId: USER_ID } });
    await prisma.server.deleteMany({ where: { id: SERVER_ID } });
  });

  beforeEach(async () => {
    await prisma.serverMembershipCache.deleteMany({ where: { userId: USER_ID } });
    mockGetMember.mockReset();
    mockGetMember.mockResolvedValue({ roles: [], nick: null });
  });

  test("asks Discord about a server it has never checked", async () => {
    mockGetMember.mockResolvedValue({ roles: [ROLE_ID], nick: null });
    const access = await getListingAccess(USER_ID, SERVER_ID, false);
    expect(access.isMember).toBe(true);
    expect([...access.permissions]).toEqual(["games.create"]);
    expect(mockGetMember).toHaveBeenCalledOnce();
  });

  test("serves a membership cached over an hour ago, then refreshes it", async () => {
    await setCache([ROLE_ID], 2 * HOUR);
    const access = await getListingAccess(USER_ID, SERVER_ID, false);
    expect(access.isMember).toBe(true);
    expect([...access.permissions]).toEqual(["games.create"]);
    await vi.waitFor(async () => expect(await cachedRoles()).toEqual([]));
    expect(mockGetMember).toHaveBeenCalledOnce();
  });

  test("serves a non-member cached hours ago without calling Discord", async () => {
    await setNonMemberCache(6 * HOUR);
    const access = await getListingAccess(USER_ID, SERVER_ID, false);
    expect(access).toMatchObject({ isMember: false });
    expect(mockGetMember).not.toHaveBeenCalled();
  });

  test("refreshes a non-member cached over 12 hours ago in the background", async () => {
    await setNonMemberCache(13 * HOUR);
    expect(await getListingAccess(USER_ID, SERVER_ID, false)).toMatchObject({ isMember: false });
    await vi.waitFor(async () => {
      const row = await prisma.serverMembershipCache.findUnique({
        where: { userId_serverId: { userId: USER_ID, serverId: SERVER_ID } },
      });
      expect(row?.isMember).toBe(true);
    });
    expect(mockGetMember).toHaveBeenCalledOnce();
  });

  test("recheck waits for a fresh answer about a non-member cached over a minute ago", async () => {
    await setNonMemberCache(2 * 60 * 1000);
    expect(await getListingAccess(USER_ID, SERVER_ID, true)).toMatchObject({ isMember: true });
    expect(mockGetMember).toHaveBeenCalledOnce();
  });

  test("recheck doesn't ask again about a non-member checked within the minute", async () => {
    await setNonMemberCache(10 * 1000);
    expect(await getListingAccess(USER_ID, SERVER_ID, true)).toMatchObject({ isMember: false });
    expect(mockGetMember).not.toHaveBeenCalled();
  });

  test("overlapping lookups of the same membership share one Discord call", async () => {
    let answer!: (member: { roles: string[]; nick: null }) => void;
    mockGetMember.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    const lookups = Promise.all([
      assertServerMembership(USER_ID, SERVER_ID),
      getListingAccess(USER_ID, SERVER_ID, false),
      getUserRoleIds(USER_ID, SERVER_ID, true),
    ]);
    // Give the other two time to read the cache and join the lookup.
    await vi.waitFor(() => expect(mockGetMember).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 200));
    answer({ roles: [ROLE_ID], nick: null });
    const [, access, roles] = await lookups;
    expect(access.isMember).toBe(true);
    expect(roles).toEqual([ROLE_ID]);
    expect(mockGetMember).toHaveBeenCalledOnce();
  });
});
