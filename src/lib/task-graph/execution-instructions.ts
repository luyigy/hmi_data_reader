/** Checks are part of the approved delivery, including their exact entry point names. */
export function executionCheckInstructions(checks: { name: string; argv: string[] }[]) {
  return '\n批准的自动检查（必须提供以下入口，并在提交前运行；不得用其他命令替代）：\n' +
    checks.map((check) => `${check.name}: argv=${JSON.stringify(check.argv)}`).join('\n');
}
