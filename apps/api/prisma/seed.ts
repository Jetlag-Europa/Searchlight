import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const SERVERS = [
  { id: "1059625399979606166", name: "JetLag UK" },
  { id: "1190673594649415730", name: "JetLag EU" },
  { id: "1369664929975767120", name: "JetLag BNL" },
  { id: "1333139120507064350", name: "JetLag DE" },
];

const ROLE_PERMISSIONS = [
  // JetLag UK — role 1383202208799129731 → server.admin
  { serverId: "1059625399979606166", discordRoleId: "1383202208799129731", permission: "server.admin" },
];

async function main() {
  for (const server of SERVERS) {
    await prisma.server.upsert({
      where: { id: server.id },
      update: { name: server.name },
      create: { id: server.id, name: server.name },
    });
    console.log(`Upserted server: ${server.name} (${server.id})`);
  }

  for (const rp of ROLE_PERMISSIONS) {
    await prisma.rolePermission.upsert({
      where: { serverId_discordRoleId_permission: rp },
      update: {},
      create: rp,
    });
    console.log(`Upserted role permission: ${rp.serverId} / ${rp.discordRoleId} → ${rp.permission}`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
