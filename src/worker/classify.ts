/**
 * Decide whether an HTTP status code is worth retrying.
 *
 * Engineering rule: retry only 5xx, timeouts and network errors — never
 * permanent 4xx. Two 4xx codes are the documented exceptions because they are
 * explicitly transient:
 *   - 429 Too Many Requests (back off and retry)
 *   - 408 Request Timeout
 *
 * Timeouts and network errors are handled in the processor's catch block and
 * are always treated as retryable; this function only classifies a received
 * HTTP response.
 */
export function isRetryableStatus(status: number): boolean {
  if (status >= 500) return true;
  if (status === 429 || status === 408) return true;
  return false;
}
