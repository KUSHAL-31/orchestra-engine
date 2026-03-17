import { JobContext } from '../context';

export async function validateOrderHandler(ctx: JobContext): Promise<{ valid: boolean; orderId: string }> {
  const { orderId } = ctx.data as { orderId: string };
  await ctx.log(`Validating order ${orderId}`);
  await ctx.progress(50);
  await new Promise((res) => setTimeout(res, 300));
  await ctx.progress(100);
  return { valid: true, orderId };
}
