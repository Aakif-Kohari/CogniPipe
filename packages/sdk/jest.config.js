/** @type {import('ts-jest').JestConfigWithTsJest} */
export default {
  testEnvironment: 'node',
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        tsconfig: './tsconfig.test.json',
      },
    ],
  },
  // @cognipipe/core's built entrypoint (dist/index.js) is ESM-only and its
  // package.json exports map has no "require" condition, so a CommonJS
  // require() of the published package fails resolution. Map it to the
  // TypeScript source instead so ts-jest compiles it the same way it
  // compiles this package's own files — no build-tooling changes needed.
  moduleNameMapper: {
    '^@cognipipe/core$': '<rootDir>/../core/src/index.ts',
  },
  testMatch: ['**/__tests__/**/*.test.ts'],
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.d.ts', '!src/index.ts'],
  coverageThreshold: {
    global: {
      lines: 90,
    },
  },
};
