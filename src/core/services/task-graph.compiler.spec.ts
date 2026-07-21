import { CapsuleTask } from '../domain/capsule';
import { TaskGraphCompiler, TaskGraphError } from './task-graph.compiler';

function task(id: string, dependsOn: string[] = []): CapsuleTask {
  return {
    id,
    title: id,
    instructions: [`Implement ${id}`],
    dependsOn,
    targets: [],
    creates: [],
    verification: [],
  };
}

describe('TaskGraphCompiler', () => {
  const compiler = new TaskGraphCompiler();

  it('produces stable parallel execution waves', () => {
    expect(
      compiler.compile([
        task('schema'),
        task('checkout', ['schema']),
        task('webhook', ['schema']),
        task('verify', ['checkout', 'webhook']),
      ]).waves,
    ).toEqual([['schema'], ['checkout', 'webhook'], ['verify']]);
  });

  it.each([
    ['missing-dependency', [task('checkout', ['schema'])]],
    ['self-dependency', [task('schema', ['schema'])]],
    [
      'cyclic-dependency',
      [task('schema', ['webhook']), task('webhook', ['schema'])],
    ],
  ] as const)('rejects %s graphs', (code, tasks) => {
    try {
      compiler.compile([...tasks]);
      throw new Error('Expected task graph compilation to fail.');
    } catch (error) {
      expect(error).toBeInstanceOf(TaskGraphError);
      expect(error).toMatchObject<Partial<TaskGraphError>>({ code });
    }
  });
});
