import { afterAll, beforeEach, describe, expect, test } from "vitest";
import prisma from "../src/lib/prisma.js";
import { seedServers } from "./seed.js";

const SERVER_ID = "test-seed-server";
const fixtures = {
  servers: [{ id: SERVER_ID, name: "Seeded Name" }],
  rolePermissions: [
    { serverId: SERVER_ID, discordRoleId: "test-seed-role", permission: "server.admin" },
  ],
};

async function cleanup() {
  await prisma.rolePermission.deleteMany({ where: { serverId: SERVER_ID } });
  await prisma.server.deleteMany({ where: { id: SERVER_ID } });
}

async function seededState() {
  const server = await prisma.server.findUnique({ where: { id: SERVER_ID } });
  const mappings = await prisma.rolePermission.findMany({
    where: { serverId: SERVER_ID },
    select: { discordRoleId: true, permission: true },
  });
  return { name: server?.name, mappings };
}

describe("seedServers", () => {
  beforeEach(cleanup);
  afterAll(cleanup);

  test("on boot, creates a missing server with its default role mappings", async () => {
    await seedServers(prisma, { missingOnly: true, ...fixtures });
    expect(await seededState()).toEqual({
      name: "Seeded Name",
      mappings: [{ discordRoleId: "test-seed-role", permission: "server.admin" }],
    });
  });

  test("on boot, leaves an existing server's name and revoked mappings alone", async () => {
    await seedServers(prisma, { missingOnly: true, ...fixtures });
    await prisma.server.update({ where: { id: SERVER_ID }, data: { name: "Renamed" } });
    await prisma.rolePermission.deleteMany({ where: { serverId: SERVER_ID } });

    await seedServers(prisma, { missingOnly: true, ...fixtures });
    expect(await seededState()).toEqual({ name: "Renamed", mappings: [] });
  });

  test("a full seed restores the default name and mappings", async () => {
    await seedServers(prisma, { missingOnly: true, ...fixtures });
    await prisma.server.update({ where: { id: SERVER_ID }, data: { name: "Renamed" } });
    await prisma.rolePermission.deleteMany({ where: { serverId: SERVER_ID } });

    await seedServers(prisma, fixtures);
    expect(await seededState()).toEqual({
      name: "Seeded Name",
      mappings: [{ discordRoleId: "test-seed-role", permission: "server.admin" }],
    });
  });
});
