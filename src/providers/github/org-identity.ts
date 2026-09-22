import { dirname } from "@std/path";
import {
  mkdir,
  readTextFile,
  rename,
  writeTextFile,
} from "../../filesystem.ts";

export interface OrgIdentityEntry {
  orgId: number;
  currentLogin: string;
  aliases: string[];
}

export type OrgIdentityTable = Record<string, OrgIdentityEntry>;

export class CorruptOrgIdentitiesError extends Error {}

export function makeOrgTableIO(filePath: string): {
  readTable: () => Promise<OrgIdentityTable>;
  writeTable: (table: OrgIdentityTable) => Promise<void>;
} {
  return {
    async readTable(): Promise<OrgIdentityTable> {
      let raw: string;
      try {
        raw = await readTextFile(filePath);
      } catch (e) {
        if (e instanceof Deno.errors.NotFound) return {};
        throw e;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new CorruptOrgIdentitiesError(
          `${filePath} is not valid JSON; repair or remove it by hand`,
        );
      }
      if (
        parsed === null || typeof parsed !== "object" || Array.isArray(parsed)
      ) {
        throw new CorruptOrgIdentitiesError(
          `${filePath} does not hold an org identity table`,
        );
      }
      return parsed as OrgIdentityTable;
    },
    async writeTable(table: OrgIdentityTable): Promise<void> {
      await mkdir(dirname(filePath), { recursive: true });
      const tmp = `${filePath}.${crypto.randomUUID()}.tmp`;
      try {
        await writeTextFile(tmp, `${JSON.stringify(table, null, 2)}\n`);
        await rename(tmp, filePath);
      } catch (e) {
        try {
          await Deno.remove(tmp);
        } catch {
          // tmp may not exist
        }
        throw e;
      }
    },
  };
}

export function canonicalLoginFor(
  table: OrgIdentityTable,
  login: string,
): string {
  if (table[login]) return login;
  for (const [key, entry] of Object.entries(table)) {
    if (entry.aliases.includes(login)) return key;
  }
  return login;
}

export function currentLoginFor(
  table: OrgIdentityTable,
  login: string,
): string {
  const canonical = canonicalLoginFor(table, login);
  return table[canonical]?.currentLogin ?? login;
}
