import { PassThrough } from 'node:stream';
import { TerminalConfirmationPrompt } from './terminal-confirmation';

describe('TerminalConfirmationPrompt', () => {
  it.each(['y', 'Y', 'yes', ' YES '])('accepts %p', async (answer) => {
    const input = interactiveInput();
    const output = new PassThrough();
    const confirmation = new TerminalConfirmationPrompt(input, output);
    input.end(`${answer}\n`);

    await expect(confirmation.confirm('Apply changes?')).resolves.toBe(true);
  });

  it.each(['', 'n', 'no', 'anything else'])('rejects %p', async (answer) => {
    const input = interactiveInput();
    const output = new PassThrough();
    const confirmation = new TerminalConfirmationPrompt(input, output);
    input.end(`${answer}\n`);

    await expect(confirmation.confirm('Apply changes?')).resolves.toBe(false);
  });

  it('requires --yes when stdin is explicitly non-interactive', async () => {
    const input = Object.assign(new PassThrough(), { isTTY: false });
    const confirmation = new TerminalConfirmationPrompt(
      input,
      new PassThrough(),
    );

    await expect(confirmation.confirm('Apply changes?')).rejects.toThrow(
      '--yes',
    );
  });

  it('rejects closed stdin when no terminal marker is present', async () => {
    const input = new PassThrough();
    input.end();
    const confirmation = new TerminalConfirmationPrompt(
      input,
      new PassThrough(),
    );

    await expect(confirmation.confirm('Apply changes?')).rejects.toThrow(
      '--yes',
    );
  });

  it('does not accept confirmation piped through non-terminal stdin', async () => {
    const input = new PassThrough();
    input.end('yes\n');
    const confirmation = new TerminalConfirmationPrompt(
      input,
      new PassThrough(),
    );

    await expect(confirmation.confirm('Apply changes?')).rejects.toThrow(
      '--yes',
    );
  });
});

function interactiveInput(): PassThrough & { isTTY: true } {
  return Object.assign(new PassThrough(), { isTTY: true as const });
}
