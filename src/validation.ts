import { AppError, type SearchInput } from "./domain.ts";

export const defaultResultLimit = 10;
export const maximumResultLimit = 50;

export function validateLocationQuery(value: unknown): string {
  return requiredText(value, "query");
}

export function validateSearchInput(input: {
  origin?: unknown;
  destination?: unknown;
  date?: unknown;
  adults?: unknown;
  children?: unknown;
}): SearchInput {
  const date = requiredText(input.date, "date");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) invalidDate();
  const parsedDate = new Date(`${date}T00:00:00Z`);
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  if (Number.isNaN(parsedDate.valueOf()) || parsedDate.toISOString().slice(0, 10) !== date || parsedDate <= today) invalidDate();

  return {
    origin: requiredText(input.origin, "origin"),
    destination: requiredText(input.destination, "destination"),
    date,
    adults: passengerCount(input.adults, "adults", 1, 1),
    children: passengerCount(input.children, "children", 0, 0),
  };
}

export function validateResultLimit(value: unknown): number {
  if (value === undefined) return defaultResultLimit;
  const limit = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > maximumResultLimit) {
    throw new AppError("INVALID_INPUT", `limit must be an integer from 1 to ${maximumResultLimit}`, 400);
  }
  return limit;
}

function requiredText(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new AppError("INVALID_INPUT", `${name} is required`, 400);
  }
  return value.trim();
}

function passengerCount(value: unknown, name: string, fallback: number, minimum: number): number {
  if (value === undefined) return fallback;
  const count = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(count) || count < minimum || count > 9) {
    throw new AppError("INVALID_INPUT", `${name} must be an integer from ${minimum} to 9`, 400);
  }
  return count;
}

function invalidDate(): never {
  throw new AppError("INVALID_INPUT", "date must be a real future date in YYYY-MM-DD format", 400);
}
