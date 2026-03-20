import { JobContext } from '../context';

export async function updateInventoryHandler(ctx: JobContext): Promise<{ updated: boolean }> {
  const { orderId } = ctx.data as { orderId: string };
  await ctx.log(`Updating inventory for order ${orderId}`);
  await ctx.progress(50);
  await new Promise((res) => setTimeout(res, 300));
  await ctx.progress(100);
  return { updated: true };
}
