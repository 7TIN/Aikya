export interface ParsedArgs {
  flags: Record<string, string | boolean>;
  positional: string[];
}

export function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg) continue;

    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }

    const equals = arg.indexOf("=");
    if (equals > 2) {
      flags[arg.slice(2, equals)] = arg.slice(equals + 1);
      continue;
    }

    const key = arg.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      flags[key] = next;
      index += 1;
    } else {
      flags[key] = true;
    }
  }

  return { flags, positional };
}

export function flagString(
  flags: ParsedArgs["flags"],
  name: string,
): string | undefined {
  const value = flags[name];
  return typeof value === "string" ? value : undefined;
}

export function flagBool(flags: ParsedArgs["flags"], name: string): boolean {
  return flags[name] === true || flags[name] === "true";
}
