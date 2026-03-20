import { JobContext } from '../context';

export async function generateReportHandler(ctx: JobContext): Promise<{ reportUrl: string }> {
  const { period, userId } = ctx.data as { period: string; userId: string };

  await ctx.log(`Generating report for user ${userId}, period: ${period}`);
  await ctx.progress(0);

  // Simulate report generation
  for (let i = 10; i <= 100; i += 10) {
    await new Promise((res) => setTimeout(res, 200));
    await ctx.progress(i);
    await ctx.log(`Processing step ${i / 10} of 10`);
  }

  const reportUrl = `https://reports.example.com/${userId}/${period}.pdf`;
  return { reportUrl };
}
