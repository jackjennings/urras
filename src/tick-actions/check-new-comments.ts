import { join } from "@std/path";
import type { TickAction } from "./types.ts";
import type { Config, TicketState } from "../state/types.ts";

export interface RawComment {
  author: string;
  body: string;
  timestamp: string;
}

export interface CheckNewCommentsDeps {
  isProcessAlive: (ticketId: string) => boolean;
  writeTicket: (stateDir: string, t: TicketState) => Promise<void>;
  appendLog: (stateDir: string, id: string, entry: object) => Promise<void>;
  fetchGitHubComments: (
    ticketId: string,
    since?: string,
  ) => Promise<RawComment[]>;
  fetchJiraComments: (
    issueKey: string,
    since?: string,
  ) => Promise<RawComment[]>;
  fetchPrComments: (prUrl: string, since?: string) => Promise<RawComment[]>;
  isBot: (author: string) => boolean;
  judgeComment: (body: string) => Promise<boolean>;
  writeContextFile: (ticketDir: string, content: string) => Promise<void>;
  config: Config;
}

const MONITORED_PHASES = new Set(["spec", "plan", "implementation", "merge"]);

function isAfter(timestamp: string, since: string): boolean {
  try {
    return Temporal.Instant.compare(
      Temporal.Instant.from(timestamp),
      Temporal.Instant.from(since),
    ) > 0;
  } catch {
    return timestamp > since;
  }
}

export function checkNewCommentsAction(deps: CheckNewCommentsDeps): TickAction {
  return {
    label: "Checking comments",
    applies(ticket: TicketState): boolean {
      return (
        (ticket.provider === "github" || ticket.provider === "jira") &&
        MONITORED_PHASES.has(ticket.phase) &&
        ticket.status === "waiting" &&
        !deps.isProcessAlive(ticket.id) &&
        deps.config.tick.checkNewComments !== false
      );
    },

    async run(
      ticket: TicketState,
      stateDir: string,
    ): Promise<TicketState | null> {
      const ticketDir = join(stateDir, ticket.id);
      const since = ticket.lastSeenCommentTimestamp ?? ticket.created;
      const prSince = ticket.lastSeenPrCommentTimestamp ?? ticket.created;

      let fetched: RawComment[];
      try {
        if (ticket.provider === "github") {
          fetched = await deps.fetchGitHubComments(ticket.id, since);
        } else {
          const issueKey = ticket.id.split("/")[1];
          fetched = await deps.fetchJiraComments(issueKey, since);
        }
      } catch {
        return null;
      }

      const comments = fetched.filter((c) => isAfter(c.timestamp, since));

      const activePrs = (ticket.prs ?? []).filter(
        (pr) => !pr.merged && !pr.closed,
      );

      let prFetched = 0;
      let prKept = 0;
      let latestPrTimestamp = "";
      const keptPrComments: RawComment[] = [];

      for (const pr of activePrs) {
        let prComments: RawComment[];
        try {
          prComments = await deps.fetchPrComments(pr.url, prSince);
        } catch {
          continue;
        }
        prFetched += prComments.length;
        for (const comment of prComments) {
          if (
            latestPrTimestamp === "" ||
            isAfter(comment.timestamp, latestPrTimestamp)
          ) {
            latestPrTimestamp = comment.timestamp;
          }
          if (deps.isBot(comment.author)) continue;
          prKept++;
          keptPrComments.push(comment);
        }
      }

      if (comments.length === 0 && prFetched === 0) return null;

      const keptTrackingComments: RawComment[] = [];
      let latestTimestamp = "";

      for (const comment of comments) {
        if (
          latestTimestamp === "" ||
          isAfter(comment.timestamp, latestTimestamp)
        ) {
          latestTimestamp = comment.timestamp;
        }
        if (deps.isBot(comment.author)) continue;
        let keep: boolean;
        try {
          keep = await deps.judgeComment(comment.body);
        } catch {
          keep = true;
        }
        if (keep) keptTrackingComments.push(comment);
      }

      const keptComments = [...keptTrackingComments, ...keptPrComments];

      if (keptComments.length > 0) {
        const content = `## New comments on ${ticket.url}\n\n` +
          keptComments
            .map(
              (c) =>
                `**${c.author}** (${c.timestamp.slice(0, 10)})\n\n${c.body}`,
            )
            .join("\n\n---\n\n");
        await deps.writeContextFile(ticketDir, content);
      }

      await deps.appendLog(stateDir, ticket.id, {
        action: "check-new-comments",
        since,
        fetched: fetched.length,
        stale: fetched.length - comments.length,
        kept: keptTrackingComments.length,
        latestTimestamp,
        prFetched,
        prKept,
      });

      const now = Temporal.Now.instant().toString();
      const updated: TicketState = {
        ...ticket,
        ...(latestTimestamp
          ? { lastSeenCommentTimestamp: latestTimestamp }
          : {}),
        ...(latestPrTimestamp
          ? { lastSeenPrCommentTimestamp: latestPrTimestamp }
          : {}),
        status: keptComments.length > 0 ? "revising" : ticket.status,
        updated: now,
      };
      await deps.writeTicket(stateDir, updated);
      return updated;
    },
  };
}
