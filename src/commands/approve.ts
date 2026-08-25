import {
  commitTicket,
  readTicket,
  readTicketWithPatch,
} from "../state/store.ts";
import { expandHome, loadConfig } from "../config.ts";
import type { Command } from "./types.ts";
import { join } from "@std/path";
import { exists, isRegularFile } from "../filesystem.ts";
import {
  ceremonyHash,
  ceremonyManifest,
  manifestLine,
  readApprovals,
  writeApprovals,
} from "../ceremonies/approvals.ts";
import type {
  ApprovalRecord,
  CeremonyManifestEntry,
} from "../ceremonies/approvals.ts";
import {
  BUILT_IN_CEREMONY_NAMES,
  isValidCeremonyName,
} from "../ceremonies/types.ts";

export async function performApprove(
  stateDir: string,
  id: string,
  {
    commitFn = commitTicket,
    readTicketFn = readTicketWithPatch,
  }: {
    commitFn?: typeof commitTicket;
    readTicketFn?: typeof readTicketWithPatch;
  } = {},
): Promise<void> {
  const { ticket, patchTicket } = await readTicketFn(stateDir, id);
  const now = Temporal.Now.instant().toString();
  await patchTicket({
    approvals: [
      ...ticket.approvals,
      { timestamp: now, actor: "human" as const, phase: ticket.phase },
    ],
    updated: now,
  });
  await commitFn(stateDir, id, `approve: ${id}`);
}

export async function performApproveCeremony(
  _stateDir: string,
  extensionsDir: string,
  name: string,
  deps: {
    readApprovalsFn?: () => Promise<ApprovalRecord>;
    writeApprovalsFn?: (record: ApprovalRecord) => Promise<void>;
    hashFn?: (ceremonyDir: string) => Promise<string>;
    manifestFn?: (ceremonyDir: string) => Promise<CeremonyManifestEntry[]>;
  } = {},
): Promise<{ hash: string; lines: string[] }> {
  if (name.trim() === "") {
    throw new Error("Ceremony name must not be empty");
  }
  if (!isValidCeremonyName(name)) {
    throw new Error(`Invalid ceremony name: ${name}`);
  }
  if (BUILT_IN_CEREMONY_NAMES.includes(name)) {
    throw new Error(`${name} is a built-in ceremony and needs no approval`);
  }
  const ceremonyDir = join(extensionsDir, "ceremonies", name);
  if (!await exists(ceremonyDir)) {
    throw new Error(`No ceremony named ${name}`);
  }
  if (
    !await isRegularFile(join(ceremonyDir, "index.ts")) &&
    !await isRegularFile(join(ceremonyDir, "prompt.md"))
  ) {
    throw new Error(
      `Ceremony ${name} has neither an index.ts nor a prompt.md and can never run`,
    );
  }
  const readApprovalsFn = deps.readApprovalsFn ?? readApprovals;
  const writeApprovalsFn = deps.writeApprovalsFn ?? writeApprovals;
  const hashFn = deps.hashFn ?? ceremonyHash;
  const manifestFn = deps.manifestFn ?? ceremonyManifest;
  const approvals = await readApprovalsFn();
  const manifest = await manifestFn(ceremonyDir);
  const unsupportedEntry = manifest.find((entry) =>
    entry.detail.includes("<unsupported>")
  );
  if (unsupportedEntry) {
    throw new Error(
      `Ceremony ${name} contains an out-of-root directory symlink and cannot be approved`,
    );
  }
  const hash = await hashFn(ceremonyDir);
  approvals[name] = {
    ...approvals[name],
    hash,
    approvedAt: Temporal.Now.instant().toString(),
    lastWarnedWindow: undefined,
  };
  await writeApprovalsFn(approvals);
  return { hash, lines: manifest.map(manifestLine) };
}

export const approve: Command = {
  name: "approve",
  description: "approve the current phase gate",
  usage: "ur approve <ticket-id|ceremony/<name>>",
  completesWith: "_ids",
  async run(args) {
    const id = args[0];
    if (!id) {
      console.error("Usage: ur approve <ticket-id|ceremony/<name>>");
      Deno.exit(1);
    }
    const config = await loadConfig();
    const stateDir = expandHome(config.state.dir);
    if (id.startsWith("ceremony/")) {
      const name = id.slice("ceremony/".length);
      const extensionsDir = config.extensions.dir;
      const { hash, lines } = await performApproveCeremony(
        stateDir,
        extensionsDir,
        name,
      );
      console.log(`Approved ceremony ${name}`);
      console.log(`  hash: ${hash}`);
      for (const line of lines) {
        console.log(`  ${line}`);
      }
      return;
    }
    const ticket = await readTicket(stateDir, id);
    await performApprove(stateDir, id);
    console.log(`Approved ${id} (phase: ${ticket.phase}/${ticket.status})`);
  },
};
