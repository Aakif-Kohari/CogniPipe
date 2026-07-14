#!/usr/bin/env node
/**
 * @module index
 *
 * Entry point for the cognipipe CLI.
 * Defines the root Commander.js program and registers all subcommands.
 * Subcommands live in src/commands/ — added by future issues.
 */
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { realpathSync } from 'node:fs';

const localRequire = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));

// Load version from the CLI's own package.json at runtime so it stays
// in sync automatically when changesets bump the version — never hardcode it.
const { version } = localRequire(`${__dirname}/../package.json`) as { version: string };

export const program = new Command();

program
  .name('cognipipe')
  .description('Code-first workflow automation engine')
  .version(version, '-v, --version', 'Output the current version and exit');

// Only call parse() when executed directly — not when imported in tests.
// import.meta.url !== process.argv[1] guards against double-parse in jest.
if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  program.parse(process.argv);
}
