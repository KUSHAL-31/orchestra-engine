import { JobContext } from '../context';

export async function notifyWarehouseHandler(ctx: JobContext): Promise<{ notified: boolean }> {
  const { orderId } = ctx.data as { orderId: string };
  await ctx.log(`Notifying warehouse for order ${orderId}`);
  await ctx.progress(50);
  await new Promise((res) => setTimeout(res, 200));
  await ctx.progress(100);
  return { notified: true };
}
