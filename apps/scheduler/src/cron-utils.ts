import parser from 'cron-parser';

/**
 * Given a 5-part cron expression, compute the next run date after `from`.
 */
export function getNextCronDate(cronExpr: string, from: Date = new Date()): Date {
  const interval = parser.parseExpression(cronExpr, { currentDate: from, iterator: false });
  return interval.next().toDate();
}
