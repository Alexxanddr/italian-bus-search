import { AppError } from "../domain.ts";

export function offsetRomeDateTime(local: string) {
  const offsets = [120, 60].filter((offset) => formatter.format(new Date(Date.parse(`${local}Z`) - offset * 60_000)).replace(" ", "T") === local);
  if (offsets.length !== 1) throw new AppError("INCOMPATIBLE_RESPONSE", `Ambiguous or nonexistent Europe/Rome time: ${local}`, 502);
  return `${local}${offsets[0] === 120 ? "+02:00" : "+01:00"}`;
}
const formatter = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Rome", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
