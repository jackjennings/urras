import type { Migration } from "../src/migrations/types.ts";

const migration: Migration = {
  run(ticket) {
    if (!ticket.prs || ticket.prs.length === 0) return Promise.resolve(ticket);

    const prs = ticket.prs.map((pr) => {
      if (pr.branch !== undefined) return pr;
      if (
        pr.worktreeKey !== undefined &&
        ticket.worktrees[pr.worktreeKey] !== undefined
      ) {
        return { ...pr, branch: ticket.worktrees[pr.worktreeKey].branch };
      }
      return pr;
    });

    return Promise.resolve({ ...ticket, prs });
  },
};

export default migration;
