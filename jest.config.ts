import type { Config } from 'jest';

const config: Config = {
  projects: [
    '<rootDir>/packages/*/jest.config.ts',
    '<rootDir>/nodes/*/jest.config.ts',
    '<rootDir>/apps/cli/jest.config.ts',
  ],
  coverageReporters: ['text', 'lcov', 'html'],
  collectCoverageFrom: [
    'packages/*/src/**/*.ts',
    'nodes/*/src/**/*.ts',
    '!**/*.d.ts',
    '!**/index.ts',
  ],
};

export default config;
