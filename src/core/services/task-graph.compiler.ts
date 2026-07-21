import { CapsuleTask } from '../domain/capsule';

export type TaskGraphErrorCode =
  | 'duplicate-task'
  | 'missing-dependency'
  | 'self-dependency'
  | 'cyclic-dependency';

export class TaskGraphError extends Error {
  constructor(
    readonly code: TaskGraphErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'TaskGraphError';
  }
}

export interface CompiledTaskGraph {
  tasks: CapsuleTask[];
  waves: string[][];
}

export class TaskGraphCompiler {
  compile(tasks: CapsuleTask[]): CompiledTaskGraph {
    const byId = new Map<string, CapsuleTask>();
    for (const task of tasks) {
      if (byId.has(task.id)) {
        throw new TaskGraphError(
          'duplicate-task',
          `Duplicate task id: ${task.id}`,
        );
      }
      byId.set(task.id, task);
    }

    for (const task of tasks) {
      for (const dependency of task.dependsOn) {
        if (dependency === task.id) {
          throw new TaskGraphError(
            'self-dependency',
            `Task ${task.id} cannot depend on itself`,
          );
        }
        if (!byId.has(dependency)) {
          throw new TaskGraphError(
            'missing-dependency',
            `Task ${task.id} depends on missing task ${dependency}`,
          );
        }
      }
    }

    const remaining = new Set(tasks.map((task) => task.id));
    const completed = new Set<string>();
    const waves: string[][] = [];

    while (remaining.size > 0) {
      const wave = tasks
        .filter(
          (task) =>
            remaining.has(task.id) &&
            task.dependsOn.every((dependency) => completed.has(dependency)),
        )
        .map((task) => task.id);

      if (wave.length === 0) {
        throw new TaskGraphError(
          'cyclic-dependency',
          `Task graph contains a cycle involving: ${[...remaining].join(', ')}`,
        );
      }

      waves.push(wave);
      for (const id of wave) {
        remaining.delete(id);
        completed.add(id);
      }
    }

    return { tasks, waves };
  }
}
