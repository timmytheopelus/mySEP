import { vi } from "vitest";
import { F, T } from "@/lib/airtable/schema";
import { hashPassword } from "@/lib/auth/password";
import { encryptSecret } from "@/lib/auth/totp";

type Row = { id: string; fields: Record<string, unknown> };
export const store: Record<string, Row[]> = {};

/** In-memory stand-in for the Airtable client (the real base is never touched). */
export function fakeClientModule() {
  return {
    listRecords: vi.fn(async (table: string) => structuredClone(store[table] ?? [])),
    createRecords: vi.fn(async (table: string, rows: Record<string, unknown>[]) => {
      const out = rows.map((fields, i) => ({ id: `recNEW${(store[table] ?? []).length + i}`.padEnd(17, "0"), fields: structuredClone(fields) }));
      (store[table] ??= []).push(...out);
      return structuredClone(out);
    }),
    updateRecords: vi.fn(async (table: string, rows: Row[]) => {
      for (const r of rows) {
        const row = (store[table] ?? []).find((x) => x.id === r.id);
        if (!row) throw new Error("no such record");
        for (const [k, v] of Object.entries(r.fields)) {
          if (v === null) delete row.fields[k];
          else row.fields[k] = v;
        }
      }
      return structuredClone(rows);
    }),
  };
}

export const PASSWORD = "correct horse battery staple";

export async function seedAccount(opts: {
  id: string;
  email: string;
  peran: string;
  mfaSecret?: string;
  active?: boolean;
  fields?: Record<string, unknown>;
}) {
  const A = F.akunKep;
  (store[T.akunKep] ??= []).push({
    id: opts.id,
    fields: {
      [A.email]: opts.email,
      [A.nama]: "Tester",
      [A.peran]: opts.peran,
      [A.hashPassword]: await hashPassword(PASSWORD),
      [A.statusAktif]: opts.active ?? true,
      ...(opts.mfaSecret ? { [A.rahasiaMfa]: encryptSecret(opts.mfaSecret) } : {}),
      ...opts.fields,
    },
  });
}

export function resetStore() {
  for (const k of Object.keys(store)) delete store[k];
}
