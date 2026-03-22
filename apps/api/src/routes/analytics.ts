import { FastifyInstance } from 'fastify';
import { prisma } from '@orchestra-engine/prisma';

function getRangeStart(range: string): Date {
  const now = new Date();
  switch (range) {
    case '1H':  return new Date(now.getTime() - 1  * 60 * 60 * 1000);
    case '6H':  return new Date(now.getTime() - 6  * 60 * 60 * 1000);
    case '7D':  return new Date(now.getTime() - 7  * 24 * 60 * 60 * 1000);
    case '30D': return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    default:    return new Date(now.getTime() - 24 * 60 * 60 * 1000); // 24H
  }
}

function getBucketSeconds(range: string): number {
  switch (range) {
    case '1H':  return 5  * 60;           // 5-min buckets
    case '6H':  return 30 * 60;           // 30-min buckets
    case '7D':
    case '30D': return 24 * 60 * 60;      // daily buckets
    default:    return 60 * 60;           // hourly buckets (24H)
  }
}

export async function analyticsRoutes(server: FastifyInstance) {

  // GET /analytics/stats?from=<ISO>&to=<ISO>
  // Returns DB-accurate counts for KPIs — no row fetching, just COUNT queries.
  server.get<{ Querystring: { from?: string; to?: string } }>('/analytics/stats', async (request, reply) => {
    const from = request.query.from ? new Date(request.query.from) : undefined;
    const to   = request.query.to   ? new Date(request.query.to)   : undefined;

    const dateFilter = {
      ...(from || to ? {
        createdAt: {
          ...(from ? { gte: from } : {}),
          ...(to   ? { lte: to   } : {}),
        },
      } : {}),
    };

    const [
      jobTotal,
      jobCompleted,
      jobFailed,
      jobRunning,
      jobPending,
      jobRetrying,
      jobDead,
      wfTotal,
      wfCompleted,
      wfFailed,
      wfRunning,
      wfPending,
    ] = await Promise.all([
      prisma.job.count({ where: dateFilter }),
      prisma.job.count({ where: { ...dateFilter, status: 'COMPLETED' } }),
      prisma.job.count({ where: { ...dateFilter, status: 'FAILED' } }),
      prisma.job.count({ where: { ...dateFilter, status: 'RUNNING' } }),
      prisma.job.count({ where: { ...dateFilter, status: 'PENDING' } }),
      prisma.job.count({ where: { ...dateFilter, status: 'RETRYING' } }),
      prisma.job.count({ where: { ...dateFilter, status: 'DEAD' } }),
      prisma.workflow.count({ where: dateFilter }),
      prisma.workflow.count({ where: { ...dateFilter, status: 'COMPLETED' } }),
      prisma.workflow.count({ where: { ...dateFilter, status: 'FAILED' } }),
      prisma.workflow.count({ where: { ...dateFilter, status: 'RUNNING' } }),
      prisma.workflow.count({ where: { ...dateFilter, status: 'PENDING' } }),
    ]);

    return reply.send({
      jobs: {
        total:     jobTotal,
        completed: jobCompleted,
        failed:    jobFailed + jobDead,
        running:   jobRunning,
        pending:   jobPending,
        retrying:  jobRetrying,
      },
      workflows: {
        total:     wfTotal,
        completed: wfCompleted,
        failed:    wfFailed,
        running:   wfRunning,
        pending:   wfPending,
      },
    });
  });

  // GET /analytics/charts?range=<1H|6H|24H|7D|30D>
  // All chart aggregations done in Postgres — no row transfer to the browser.
  server.get<{ Querystring: { range?: string } }>('/analytics/charts', async (request, reply) => {
    const range = request.query.range ?? '24H';
    const from  = getRangeStart(range);
    const bucketSecs = getBucketSeconds(range);

    const dateFilter = { createdAt: { gte: from } };

    const [
      timeseries,
      durationByType,
      topFailing,
      retryDist,
      hourlyRaw,
      jobTypeVolume,
      recentFailures,
      perfMetrics,
      retriedCount,
      totalCount,
      uniqueTypesRaw,
    ] = await Promise.all([

      // Time-series buckets
      prisma.$queryRaw<Array<{ bucket: Date; created: bigint; completed: bigint; failed: bigint }>>`
        SELECT
          to_timestamp(floor(extract(epoch from "createdAt") / ${bucketSecs}) * ${bucketSecs}) AS bucket,
          COUNT(*)::bigint                                                        AS created,
          COUNT(*) FILTER (WHERE status = 'COMPLETED')::bigint                   AS completed,
          COUNT(*) FILTER (WHERE status IN ('FAILED','DEAD'))::bigint             AS failed
        FROM "jobs"
        WHERE "createdAt" >= ${from}
        GROUP BY bucket
        ORDER BY bucket
      `,

      // Avg duration per job type
      prisma.$queryRaw<Array<{ type: string; avgMs: number }>>`
        SELECT
          type,
          AVG(EXTRACT(EPOCH FROM ("completedAt" - "startedAt")) * 1000)::float AS "avgMs"
        FROM "jobs"
        WHERE "createdAt" >= ${from}
          AND "startedAt" IS NOT NULL
          AND "completedAt" IS NOT NULL
        GROUP BY type
        ORDER BY "avgMs" DESC
        LIMIT 8
      `,

      // Top failing job types
      prisma.job.groupBy({
        by: ['type'],
        where: { ...dateFilter, status: { in: ['FAILED', 'DEAD'] } },
        _count: { id: true },
        orderBy: { _count: { id: 'desc' } },
        take: 6,
      }),

      // Retry distribution
      prisma.job.groupBy({
        by: ['attempts'],
        where: dateFilter,
        _count: { id: true },
        orderBy: { attempts: 'asc' },
      }),

      // Hourly activity
      prisma.$queryRaw<Array<{ hour: number; count: bigint }>>`
        SELECT
          EXTRACT(HOUR FROM "createdAt")::int AS hour,
          COUNT(*)::bigint                    AS count
        FROM "jobs"
        WHERE "createdAt" >= ${from}
        GROUP BY hour
        ORDER BY hour
      `,

      // Job type volume
      prisma.job.groupBy({
        by: ['type'],
        where: dateFilter,
        _count: { id: true },
        orderBy: { _count: { id: 'desc' } },
        take: 8,
      }),

      // Recent failures (fetches rows but only 8, negligible)
      prisma.job.findMany({
        where: { ...dateFilter, status: { in: ['FAILED', 'DEAD'] } },
        orderBy: { createdAt: 'desc' },
        take: 8,
        select: { id: true, type: true, status: true, error: true, createdAt: true },
      }),

      // Percentile performance metrics
      prisma.$queryRaw<Array<{ p50: number; p95: number; p99: number; avg: number }>>`
        SELECT
          COALESCE(PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM ("completedAt" - "startedAt")) * 1000), 0)::float AS p50,
          COALESCE(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM ("completedAt" - "startedAt")) * 1000), 0)::float AS p95,
          COALESCE(PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM ("completedAt" - "startedAt")) * 1000), 0)::float AS p99,
          COALESCE(AVG(EXTRACT(EPOCH FROM ("completedAt" - "startedAt")) * 1000), 0)::float                                          AS avg
        FROM "jobs"
        WHERE "createdAt" >= ${from}
          AND "startedAt" IS NOT NULL
          AND "completedAt" IS NOT NULL
      `,

      // Jobs retried at least once
      prisma.job.count({ where: { ...dateFilter, attempts: { gt: 1 } } }),

      // Total jobs in range (for retry rate)
      prisma.job.count({ where: dateFilter }),

      // Distinct job types
      prisma.job.findMany({ where: dateFilter, select: { type: true }, distinct: ['type'] }),
    ]);

    const perf = perfMetrics[0] ?? { p50: 0, p95: 0, p99: 0, avg: 0 };

    // Build full 0–23 hourly array so the bar chart is never sparse
    const hourlyMap = new Map<number, number>();
    hourlyRaw.forEach((h: { hour: number; count: bigint }) =>
      hourlyMap.set(Number(h.hour), Number(h.count)));
    const hourlyActivity = Array.from({ length: 24 }, (_, i) => ({
      hour:  `${String(i).padStart(2, '0')}:00`,
      count: hourlyMap.get(i) ?? 0,
    }));

    return reply.send({
      timeseries: timeseries.map((b: { bucket: Date; created: bigint; completed: bigint; failed: bigint }) => ({
        bucket:    b.bucket.toISOString(),
        created:   Number(b.created),
        completed: Number(b.completed),
        failed:    Number(b.failed),
      })),
      durationByType:   durationByType.map((d: { type: string; avgMs: number }) => ({ type: d.type, avgMs: Math.round(d.avgMs) })),
      topFailingTypes:  topFailing.map((t: { type: string; _count: { id: number } }) => ({ type: t.type, failures: t._count.id })),
      retryDistribution: retryDist.map((r: { attempts: number; _count: { id: number } }) => ({ label: `${r.attempts}x`, count: r._count.id })),
      hourlyActivity,
      jobTypeVolume:    jobTypeVolume.map((t: { type: string; _count: { id: number } }) => ({ type: t.type, count: t._count.id })),
      recentFailures:   recentFailures.map((j: { id: string; type: string; status: string; error: string | null; createdAt: Date }) => ({
        id:        j.id,
        type:      j.type,
        status:    j.status.toLowerCase(),
        error:     j.error,
        createdAt: j.createdAt.toISOString(),
      })),
      performance:  { p50: perf.p50, p95: perf.p95, p99: perf.p99, avg: perf.avg },
      retryRate:    totalCount > 0 ? Math.round((retriedCount / totalCount) * 100) : 0,
      uniqueTypes:  uniqueTypesRaw.length,
    });
  });
}
