import { createHash, timingSafeEqual } from "node:crypto"

export function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

export function equalDigest(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex")
  const right = Buffer.from(b, "hex")
  return left.length === 32 && right.length === 32 && timingSafeEqual(left, right)
}
