// Allowlist: "111, 222" → {111, 222}. Порожній, відсутній чи зі сміттям → null (відхиляти всіх, fail-closed; 0.6.b–c).
export function parseAllowlist(raw: string | undefined): Set<number> | null {
  if (raw === undefined) return null;
  const parts = raw.split(",").map((p) => p.trim());
  if (parts.length === 0 || parts.every((p) => p === "")) return null;
  const ids = new Set<number>();
  for (const p of parts) {
    if (!/^\d{1,15}$/.test(p)) return null;
    ids.add(Number(p));
  }
  return ids;
}

// Порівняння секрету в сталий час: хеші однакової довжини, XOR по всіх байтах.
export async function secretsEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const va = new Uint8Array(ha);
  const vb = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < va.length; i++) diff |= (va[i] ?? 0) ^ (vb[i] ?? 0);
  return diff === 0;
}
