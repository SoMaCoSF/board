import type { slack } from "vboard/adapter-slack";
import { CROSSPOST_ACTOR, linkText } from "./crosspost.ts";

type RenderInput = Parameters<NonNullable<Parameters<typeof slack>[0]["render"]>>[0];

/** A PR's state as the workspace's PR emoji. */
const STATE_EMOJI: Record<string, string> = {
  open: ":pr:",
  draft: ":pr-draft:",
  merged: ":pr-merged:",
  closed: ":pr-closed:",
};

/**
 * Slack's rendering: a PR root is one line, its state's emoji and a link titled with
 * the PR (`:pr-merged: [#67 Version Packages](…) · github-actions[bot]`), edited as its
 * state changes. A factory PR labeled with its `owner` shows them instead of the bot
 * (`· for <@U0456>`). The `crosspost` watcher's links go without a label. Everything else
 * keeps the board's default.
 */
export function renderForSlack({ message, author, mentionOf, label }: RenderInput): string {
  if (message.by.actor === CROSSPOST_ACTOR) return message.text;
  const pr = /^PR #(\d+): (.+)\n(https:\/\/\S+)$/.exec(message.text);
  const emoji = STATE_EMOJI[message.labels.state ?? ""];
  if (message.re !== null || !message.labels.pr || !pr || !emoji) {
    return `**${label}**: ${message.text}`;
  }
  const text = linkText(`#${pr[1]} ${pr[2]}`);
  const owner = message.labels.owner ? (mentionOf(message.labels.owner) ?? message.labels["owner.name"]) : undefined;
  return `${emoji} [${text}](${pr[3]}) · ${owner ? `for ${owner}` : (mentionOf(message.by.actor) ?? author?.name ?? label)}`;
}
