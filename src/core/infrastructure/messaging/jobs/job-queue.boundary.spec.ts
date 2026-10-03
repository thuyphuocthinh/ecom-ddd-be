import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative, sep } from 'path';

const SRC = join(process.cwd(), 'src');
const ALLOWED = [join('core', 'infrastructure', 'messaging')];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith('.ts') ? [path] : [];
  });
}

describe('job queue boundary (AC-11)', () => {
  it('keeps amqplib and RabbitMQService inside core/infrastructure/messaging, so business code only knows the IJobQueue port', () => {
    const offenders = sourceFiles(SRC)
      .filter((file) => {
        const path = relative(SRC, file);
        return !ALLOWED.some((allowed) => path.startsWith(allowed + sep));
      })
      // `core/index.ts` only re-exports the module
      .filter((file) => relative(SRC, file) !== join('core', 'index.ts'))
      .filter((file) =>
        /from ['"]amqplib['"]|RabbitMQService|RabbitMqJobQueue/.test(
          readFileSync(file, 'utf8'),
        ),
      )
      .map((file) => relative(SRC, file));

    expect(offenders).toEqual([]);
  });
});
