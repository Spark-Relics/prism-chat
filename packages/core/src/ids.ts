import { createHash, randomUUID } from "node:crypto";

/** ID helpers shared across core and adapters. */

export function newId(): string {
  return randomUUID();
}

/** Deterministic inbound id: same platform event never produces two hub ids. */
export function deterministicId(channel: string, ...parts: (string | number)[]): string {
  return createHash("sha256")
    .update([channel, ...parts].join(":"))
    .digest("hex")
    .slice(0, 32);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const isEmail = (s: string): boolean => EMAIL_RE.test(s);
