import { FastifyInstance } from 'fastify';
import { v4 as uuidv4 } from 'uuid';
import { prisma } from '@node-forge-engine/prisma';
import { produceMessage, Topics } from '@node-forge-engine/kafka';
import type { SubmitWorkflowRequest, WorkflowCreatedEvent } from '@node-forge-engine/types';

export async function workflowRoutes(server: FastifyInstance) {

  // GET /workflows — List all workflows (most recent first)
  server.get('/workflows', async (_req, reply) => {
    const workflows = await prisma.workflow.findMany({
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    return reply.send(
      workflows.map((w) => ({
        id: w.id,
        name: w.name,
        status: w.status.toLowerCase(),
        createdAt: w.createdAt.toISOString(),
        completedAt: w.completedAt?.toISOString() ?? null,
      }))
    );
  });

  // POST /workflows — Submit a workflow
  server.post<{ Body: SubmitWorkflowRequest }>('/workflows', async (request, reply) => {
    const { name, steps, onFailure } = request.body;

    if (!name || !steps?.length) {
      return reply.code(400).send({ error: 'name and steps are required' });
    }

    const workflowId = uuidv4();

    // Pre-generate IDs so dependsOn names can be resolved to IDs
    const nameToId = new Map<string, string>();
    steps.forEach((step) => nameToId.set(step.name, uuidv4()));

    const stepRecords = steps.map((step, index) => ({
      id: nameToId.get(step.name)!,
      name: step.name,
      jobType: step.type,
      status: 'PENDING' as const,
      dependsOn: (step.dependsOn ?? []).map((depName) => nameToId.get(depName) ?? depName),
      parallelGroup: step.parallelGroup ?? null,
      position: index,
    }));

    // RULE-5: Write Postgres first
    await prisma.workflow.create({
      data: {
        id: workflowId,
        name,
        status: 'PENDING',
        definition: { name, steps, onFailure } as object,
        steps: { create: stepRecords },
      },
    });

    const event: WorkflowCreatedEvent = {
      workflowId,
      definition: { name, steps, onFailure },
    };
    await produceMessage(Topics.WORKFLOW_CREATED, event, workflowId);

    return reply.code(202).send({ workflowId });
  });

  // GET /workflows/:id — Get workflow + all step statuses
  server.get<{ Params: { id: string } }>('/workflows/:id', async (request, reply) => {
    const workflow = await prisma.workflow.findUnique({
      where: { id: request.params.id },
      include: { steps: { orderBy: { position: 'asc' } } },
    });
    if (!workflow) return reply.code(404).send({ error: 'Workflow not found' });

    return reply.send({
      id: workflow.id,
      name: workflow.name,
      status: workflow.status.toLowerCase(),
      definition: workflow.definition,
      createdAt: workflow.createdAt.toISOString(),
      completedAt: workflow.completedAt?.toISOString() ?? null,
      steps: workflow.steps.map((s) => ({
        id: s.id,
        name: s.name,
        jobType: s.jobType,
        status: s.status.toLowerCase(),
        dependsOn: s.dependsOn,
        parallelGroup: s.parallelGroup,
        position: s.position,
        result: s.result,
        error: s.error,
        executedAt: s.executedAt?.toISOString() ?? null,
      })),
    });
  });

  // POST /workflows/:id/resume — Resume failed workflow
  server.post<{ Params: { id: string } }>('/workflows/:id/resume', async (request, reply) => {
    const workflow = await prisma.workflow.findUnique({
      where: { id: request.params.id },
      include: { steps: true },
    });
    if (!workflow) return reply.code(404).send({ error: 'Workflow not found' });
    if (workflow.status !== 'FAILED') {
      return reply.code(400).send({ error: 'Only failed workflows can be resumed' });
    }

    // Reset failed/pending steps; keep completed steps as-is
    const stepsToResume = workflow.steps.filter((s) =>
      s.status === 'FAILED' || s.status === 'PENDING' || s.status === 'SKIPPED'
    );
    await prisma.$transaction([
      prisma.workflow.update({ where: { id: workflow.id }, data: { status: 'RUNNING' } }),
      ...stepsToResume.map((s) =>
        prisma.workflowStep.update({ where: { id: s.id }, data: { status: 'PENDING' } })
      ),
    ]);

    // Re-emit workflow.created so Orchestrator re-initializes
    await produceMessage(
      Topics.WORKFLOW_CREATED,
      { workflowId: workflow.id, definition: workflow.definition as object },
      workflow.id
    );

    return reply.send({ message: 'Workflow resumed' });
  });
}
