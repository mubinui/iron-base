/**
 * The commands IronBase will not run, whatever the answer to the prompt.
 *
 * Every command already needs a click before it runs, so this list is not the
 * security boundary — you are. It exists because a permission prompt is a bad
 * place to catch a mistake: the model writes a confident one-liner, the damage
 * it would do is invisible in the text, and "Allow" is one keystroke. What is on
 * this list is the small set of commands whose damage nothing in the editor can
 * undo — emptying a home directory, overwriting a disk, force-pushing over
 * someone else's history, publishing a package.
 *
 * Be honest about what this is not. A model set on doing harm can express any of
 * these another way, and this is not a sandbox. It is a guard against accidents,
 * which is what the failure actually looks like in practice.
 *
 * Note what is deliberately *not* here: `rm -rf dist`, `rm -rf node_modules`,
 * `git checkout .`. Those are ordinary, and refusing them would train people to
 * stop reading the prompt — which costs more safety than it buys.
 *
 * Deliberately free of `vscode`, so the rules can be tested directly.
 */

export type CommandVerdict = { ok: true } | { ok: false; reason: string };

interface Rule {
  pattern: RegExp;
  reason: string;
}

/**
 * Matched against the whole command line.
 *
 * Where a rule must not reach across into the next command, it says so itself
 * with `[^|;&]*` rather than relying on the caller to have split correctly —
 * splitting on shell operators without honouring quotes is its own bug, and the
 * one rule that genuinely needs to see a pipe would have been cut in half by it.
 */
const RULES: Rule[] = [
  {
    pattern:
      /\brm\b[^|;&]*\s(\/|~\/?|\$HOME\/?|\/\*|\/(usr|etc|var|bin|sbin|lib|opt|System|Library|Users|home)\/?)(\s|$)/,
    reason: "a delete aimed at the filesystem root, a home directory, or a system directory",
  },
  {
    pattern: /:\s*\(\s*\)\s*\{.*\|.*&\s*\}\s*;\s*:/,
    reason: "a fork bomb",
  },
  {
    pattern: /\bmkfs(\.\w+)?\b|\bfdisk\b|\bdiskutil\s+(erase|partition|reformat)/,
    reason: "a disk format",
  },
  {
    pattern: /\bdd\b[^|;&]*\bof=\/dev\//,
    reason: "a raw write to a device",
  },
  {
    pattern: /\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba|z|k|d|fi)?sh\b/,
    reason:
      "downloading a script straight into a shell — fetch it to a file first, so what it does can be read",
  },
  {
    pattern: /\bgit\s+push\b[^|;&]*(--force(?!-with-lease)|\s-f(\s|$))/,
    reason: "a force push, which overwrites history on the remote — `--force-with-lease` is allowed",
  },
  {
    pattern: /\bgit\s+reset\s+(--hard|--merge)\b/,
    reason:
      "a hard reset, which throws away uncommitted work that IronBase has no copy of — commit or stash first",
  },
  {
    pattern: /\bgit\s+clean\b[^|;&]*\s-[a-z]*[dx]/,
    reason: "a working-tree clean, which deletes untracked files permanently",
  },
  {
    pattern: /\b(npm|pnpm|yarn|bun)\s+publish\b|\btwine\s+upload\b|\bcargo\s+publish\b/,
    reason: "publishing a package, which cannot be taken back once it is out",
  },
  {
    pattern: /(^|[|;&]\s*)(sudo|doas|su)\s/,
    reason: "running as another user — anything needing root is a decision to make outside this panel",
  },
  {
    pattern: /(^|[|;&]\s*)(shutdown|reboot|halt|poweroff)\b/,
    reason: "shutting the machine down",
  },
  {
    pattern: /\bchmod\b[^|;&]*\s(-[a-zA-Z]+\s+)*[0-7]{3,4}\s+\/(\s|$)|\bchown\b[^|;&]*\s\/(\s|$)/,
    reason: "changing ownership or permissions on the filesystem root",
  },
  {
    pattern: /\bhistory\s+-c\b|>\s*~?\/?\.(bash|zsh)_history\b/,
    reason: "erasing shell history",
  },
];

export function screenCommand(command: string): CommandVerdict {
  const trimmed = command.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: "The command is empty." };
  }

  for (const rule of RULES) {
    if (rule.pattern.test(trimmed)) {
      return {
        ok: false,
        reason:
          `IronBase will not run \`${trimmed.slice(0, 160)}\` — it is ${rule.reason}. ` +
          "If the task genuinely needs it, say so and let the developer run it themselves.",
      };
    }
  }
  return { ok: true };
}
