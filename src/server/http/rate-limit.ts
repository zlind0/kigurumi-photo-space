interface Bucket {
  hits: number[];
}

export class SlidingWindowLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  hit(key: string, now = Date.now()): { allowed: boolean; retryAfterMs: number } {
    const bucket = this.buckets.get(key) ?? { hits: [] };
    const cutoff = now - this.windowMs;
    bucket.hits = bucket.hits.filter((ts) => ts > cutoff);
    if (bucket.hits.length >= this.limit) {
      const oldest = bucket.hits[0] ?? now;
      this.buckets.set(key, bucket);
      return { allowed: false, retryAfterMs: Math.max(0, oldest + this.windowMs - now) };
    }
    bucket.hits.push(now);
    this.buckets.set(key, bucket);
    if (this.buckets.size > 10_000) this.prune(now);
    return { allowed: true, retryAfterMs: 0 };
  }

  private prune(now: number): void {
    const cutoff = now - this.windowMs;
    for (const [key, bucket] of this.buckets) {
      if (bucket.hits.every((ts) => ts <= cutoff)) this.buckets.delete(key);
    }
  }
}

export class ConcurrencyLimiter {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly max: number) {}

  async acquire(): Promise<() => void> {
    if (this.active < this.max) {
      this.active++;
      return () => this.release();
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.active++;
    return () => this.release();
  }

  private release(): void {
    this.active = Math.max(0, this.active - 1);
    const next = this.waiting.shift();
    if (next) next();
  }
}
