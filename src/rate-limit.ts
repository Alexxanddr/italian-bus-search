import { AppError } from "./domain.ts";

export function createRateLimiter(maximum = 60, windowMs = 60_000): (clientId: string) => void {
  const requests = new Map<string, { count: number; resetAt: number }>();
  let nextCleanup = 0;
  return (clientId) => {
    const now = Date.now();
    if (now >= nextCleanup) {
      for (const [id, value] of requests) if (value.resetAt <= now) requests.delete(id);
      nextCleanup = now + windowMs;
    }
    const current = requests.get(clientId);
    if (current === undefined || current.resetAt <= now) {
      requests.set(clientId, { count: 1, resetAt: now + windowMs });
      return;
    }
    current.count += 1;
    if (current.count > maximum) throw new AppError("RATE_LIMITED", "Rate limit exceeded", 429);
  };
}
