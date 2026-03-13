import { prisma } from './index';

export async function writeAuditLog(params: {
  entityType: string;
  entityId: string;
  fromStatus?: string;
  toStatus: string;
  metadata?: Record<string, unknown>;
}) {
  await prisma.auditLog.create({
    data: {
      entityType: params.entityType,
      entityId: params.entityId,
      fromStatus: params.fromStatus,
      toStatus: params.toStatus,
      metadata: params.metadata,
    },
  });
}
