import { JobContext } from '../context';

export async function chargePaymentHandler(ctx: JobContext): Promise<{ charged: boolean; amount: number }> {
  const { orderId, amount } = ctx.data as { orderId: string; amount: number };
  await ctx.log(`Charging $${amount} for order ${orderId}`);
  await ctx.progress(50);
  await new Promise((res) => setTimeout(res, 400));
  await ctx.progress(100);
  return { charged: true, amount };
}
