/**
 * Retry utility with exponential backoff
 */

export interface RetryOptions {
  maxAttempts: number;
  delaysMs: number[];
}

export async function retry<T>(
  fn: () => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < options.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt < options.maxAttempts - 1) {
        const delay = options.delaysMs[attempt] || options.delaysMs[options.delaysMs.length - 1];
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError || new Error("Retry failed");
}
