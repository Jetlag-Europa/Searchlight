-- CreateTable
CREATE TABLE "Server" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "iconUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Server_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServerMembershipCache" (
    "userId" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "roles" TEXT[],
    "cachedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ServerMembershipCache_pkey" PRIMARY KEY ("userId","serverId")
);

-- CreateTable
CREATE TABLE "RolePermission" (
    "id" SERIAL NOT NULL,
    "serverId" TEXT NOT NULL,
    "discordRoleId" TEXT NOT NULL,
    "permission" TEXT NOT NULL,

    CONSTRAINT "RolePermission_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RolePermission_serverId_idx" ON "RolePermission"("serverId");

-- CreateIndex
CREATE UNIQUE INDEX "RolePermission_serverId_discordRoleId_permission_key" ON "RolePermission"("serverId", "discordRoleId", "permission");

-- AddForeignKey
ALTER TABLE "ServerMembershipCache" ADD CONSTRAINT "ServerMembershipCache_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("discordId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServerMembershipCache" ADD CONSTRAINT "ServerMembershipCache_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "Server"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RolePermission" ADD CONSTRAINT "RolePermission_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "Server"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
