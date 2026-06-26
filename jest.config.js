export default {
  projects: [],
  coverageReporters: ['text', 'lcov', 'html'],
  collectCoverageFrom: [
    'packages/*/src/**/*.ts',
    'nodes/*/src/**/*.ts',
    '!**/*.d.ts',
    '!**/index.ts',
  ],
};
