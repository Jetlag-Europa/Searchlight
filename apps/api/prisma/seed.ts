import { PrismaClient } from "@prisma/client";
import { pathToFileURL } from "node:url";

const SERVERS = [
  { id: "1059625399979606166", name: "JetLag UK" },
  { id: "1190673594649415730", name: "JetLag EU" },
  { id: "1369664929975767120", name: "JetLag BNL" },
  { id: "1333139120507064350", name: "JetLag DE" },
  { id: "1458858559952523305", name: "JetLag CH" },
  { id: "1376560872029290708", name: "JetLag Nordics" },
  // Virtual server — no real Discord guild. Visible to everyone; per-game
  // access is governed by definition visibility gates (see VIRTUAL_SERVER_IDS).
  { id: "home-games", name: "Home Games" },
];

const ROLE_PERMISSIONS = [
  // JetLag UK — role 1383202208799129731 → server.admin
  { serverId: "1059625399979606166", discordRoleId: "1383202208799129731", permission: "server.admin" },
];

/**
 * Registers the Discord servers games belong to and their default role
 * mappings. A full seed also resets server names and restores every default
 * mapping. `missingOnly`, used on every container start, only creates servers
 * that don't exist yet (with their defaults), so names and mappings changed or
 * revoked since are left alone.
 */
export async function seedServers(
  prisma: PrismaClient,
  { missingOnly = false, servers = SERVERS, rolePermissions = ROLE_PERMISSIONS } = {},
): Promise<void> {
  for (const server of servers) {
    const defaults = rolePermissions.filter((rp) => rp.serverId === server.id);

    if (missingOnly) {
      const { count } = await prisma.server.createMany({ data: [server], skipDuplicates: true });
      if (count === 0) continue;
      await prisma.rolePermission.createMany({ data: defaults, skipDuplicates: true });
      console.log(`Created server: ${server.name} (${server.id}) with ${defaults.length} role permission(s)`);
      continue;
    }

    await prisma.server.upsert({
      where: { id: server.id },
      update: { name: server.name },
      create: { id: server.id, name: server.name },
    });
    console.log(`Upserted server: ${server.name} (${server.id})`);

    for (const rp of defaults) {
      await prisma.rolePermission.upsert({
        where: { serverId_discordRoleId_permission: rp },
        update: {},
        create: rp,
      });
      console.log(`Upserted role permission: ${rp.serverId} / ${rp.discordRoleId} → ${rp.permission}`);
    }
  }
}

async function main() {
  const prisma = new PrismaClient();
  try {
    await seedServers(prisma, { missingOnly: process.argv.includes("--missing-only") });
  } finally {
    await prisma.$disconnect();
  }
}

// Run when executed directly (tsx prisma/seed.ts, node dist-seed/seed.js), not when imported.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
