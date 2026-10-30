export type ProgramState =
  | "idle"
  | "working"
  | "blocked"
  | "done"
  | "error"
  | "clear";

export type BlockedKind = "permission" | "question" | "auth";

export interface ProgramStatus {
  state: ProgramState;
  id?: string;
  kind?: BlockedKind;
  progress?: number;
  app?: string;
  title?: string;
  message?: string;
}

const MAX_SEQUENCE_BYTES = 4096;
const MAX_MESSAGE_BYTES = 2048;
const MAX_TITLE_BYTES = 192;
const CONTROL_CHARACTERS = /\p{Cc}/gu;
const encoder = new TextEncoder();

function truncateToBytes(text: string, maxBytes: number): string {
  let result = "";
  let bytes = 0;
  for (const character of text) {
    const size = encoder.encode(character).length;
    if (bytes + size > maxBytes) break;
    result += character;
    bytes += size;
  }
  return result;
}

function encodeText(text: string, maxBytes: number): string {
  const clean = text.replace(CONTROL_CHARACTERS, " ");
  const bytes = encoder.encode(truncateToBytes(clean, maxBytes));
  return btoa(String.fromCharCode(...bytes));
}

function sanitizeToken(value: string): string {
  return value.replace(/[^A-Za-z0-9._/-]/g, "-");
}

export function formatProgramStatus(status: ProgramStatus): string {
  const fields = [`state=${status.state}`];
  if (status.id !== undefined) fields.push(`id=${sanitizeToken(status.id)}`);
  if (status.kind !== undefined) fields.push(`kind=${status.kind}`);
  if (status.progress !== undefined) {
    const clamped = Math.min(100, Math.max(0, Math.round(status.progress)));
    fields.push(`progress=${clamped}`);
  }
  if (status.app !== undefined) fields.push(`app=${sanitizeToken(status.app)}`);
  if (status.title !== undefined) {
    fields.push(`title=${encodeText(status.title, MAX_TITLE_BYTES)}`);
  }
  if (status.message !== undefined) {
    fields.push(`msg=${encodeText(status.message, MAX_MESSAGE_BYTES)}`);
  }
  const sequence = `\x1b]7501;${fields.join(":")}\x1b\\`;
  if (encoder.encode(sequence).length > MAX_SEQUENCE_BYTES) {
    return `\x1b]7501;state=${status.state}\x1b\\`;
  }
  return sequence;
}

export function createProgramStatusReporter(
  { write, app }: { write: (data: string) => void; app: string },
): (status: Omit<ProgramStatus, "app">) => void {
  let last = "";
  return (status) => {
    const sequence = formatProgramStatus({ ...status, app });
    if (sequence === last) return;
    last = sequence;
    write(sequence);
  };
}
