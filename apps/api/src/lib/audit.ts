import type { Prisma } from "@prisma/client";
import type { AuditAction } from "@searchlight/shared";

// Takes the change's transaction where it has one, so the entry commits with it.
export function audit(
  tx: Prisma.TransactionClient,
  entry: {
    serverId: string;
    actorId: string | null;
    action: AuditAction;
    targetId: string;
    targetName: string;
    details: Prisma.InputJsonObject;
  },
) {
  return tx.auditLog.create({ data: entry });
}
