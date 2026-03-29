"use client";

import { format } from "date-fns";

export function LocalTime({ date, fmt = "PPP 'at' p" }: { date: string | Date; fmt?: string }) {
  return <>{format(new Date(date), fmt)}</>;
}
