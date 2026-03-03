import { prisma } from './index';
import { EntityType } from '@prisma/client';

export async function writeAuditLog(params: {
  entityType: EntityType;
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
