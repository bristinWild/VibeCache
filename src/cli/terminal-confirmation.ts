import { createInterface } from 'node:readline/promises';

export interface ConfirmationPrompt {
  confirm(message: string): Promise<boolean>;
}

export class TerminalConfirmationPrompt implements ConfirmationPrompt {
  constructor(
    private readonly input: NodeJS.ReadableStream = process.stdin,
    private readonly output: NodeJS.WritableStream = process.stderr,
  ) {}

  async confirm(message: string): Promise<boolean> {
    if (!('isTTY' in this.input) || this.input.isTTY !== true) {
      throw new Error(
        'Execution requires confirmation from a terminal. Re-run with --yes only after reviewing the dry-run plan.',
      );
    }

    const terminal = createInterface({
      input: this.input,
      output: this.output,
    });
    try {
      const answer = await terminal.question(`${message} [y/N] `);
      return ['y', 'yes'].includes(answer.trim().toLowerCase());
    } finally {
      terminal.close();
    }
  }
}
