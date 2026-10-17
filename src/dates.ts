import * as z from 'zod/v4';

export const dateSchema = z.iso.date().refine((date) => date >= '2000-01-01' && date <= '9999-12-31', {
  message: 'Use a real calendar date in YYYY-MM-DD format, from year 2000 onward.',
});

export function todayInPrague(now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Prague', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const part = (name: string) => parts.find((entry) => entry.type === name)?.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}
