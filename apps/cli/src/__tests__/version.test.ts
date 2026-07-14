import { program } from '../index.ts';
import { createRequire } from 'node:module';

const localRequire = createRequire(import.meta.url);
const { version } = localRequire('../../package.json') as { version: string };

it('program name is "cognipipe"', () => {
  expect(program.name()).toBe('cognipipe');
});

it('program version matches package.json version', () => {
  expect(program.version()).toBe(version);
});

it('package.json version is a valid semver string', () => {
  expect(version).toMatch(/^\d+\.\d+\.\d+$/);
});
