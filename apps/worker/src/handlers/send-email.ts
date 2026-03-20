import { JobContext } from '../context';

export async function sendEmailHandler(ctx: JobContext): Promise<{ sent: boolean }> {
  const { to, subject } = ctx.data as { to: string; subject: string; body: string };

  await ctx.log(`Sending email to ${to}`);
  await ctx.progress(10);

  // Simulate sending (replace with real email logic)
  await new Promise((res) => setTimeout(res, 500));
  await ctx.progress(50);

  await ctx.log(`Email sent: "${subject}" to ${to}`);
  await ctx.progress(100);

  return { sent: true };
}
