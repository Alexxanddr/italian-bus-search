import { AppError } from "./domain.ts";

export function createRateLimiter(maximum = 60, windowMs = 60_000): (clientId: string) => void {
  const requests = new Map<string, { count: number; resetAt: number }>();
  return (clientId) => {
    const now = Date.now();
    const current = requests.get(clientId);
    if (current === undefined || current.resetAt <= now) {
      requests.set(clientId, { count: 1, resetAt: now + windowMs });
      return;
    }
    current.count += 1;
    if (current.count > maximum) throw new AppError("RATE_LIMITED", "Rate limit exceeded", 429);
  };
}
