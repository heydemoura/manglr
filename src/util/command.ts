/** Show a shell command on one line: unwrap `zsh -lc "…"` wrappers and join lines. */
export function oneLineCommand(cmd: string): string {
  const wrapped = /^\S*?\/?(?:ba|z)?sh\s+-l?c\s+(["'])([\s\S]*)\1\s*$/.exec(cmd.trim());
  const inner = wrapped ? wrapped[2]! : cmd;
  return inner.trim().replace(/\s*\n\s*/g, " ⏎ ");
}
