/**
 * Turning an unknown thrown value into something an operator can act on.
 *
 * Everything here catches `unknown`, because that is what a `catch` gives you
 * and upstream code rejects with whatever it likes — Errors with empty
 * messages, bare strings, `null`. `String(cause)` on an object yields
 * "[object Object]", which is not a degradation message, it is a bug report
 * nobody can read.
 */
export function messageOf(cause: unknown): string {
  if (cause instanceof Error && cause.message.length > 0) return cause.message;
  if (typeof cause === "string" && cause.length > 0) return cause;
  if (typeof cause === "number" || typeof cause === "boolean") return String(cause);
  return "沒有錯誤訊息";
}
