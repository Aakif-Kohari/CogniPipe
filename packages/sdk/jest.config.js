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
  testMatch: ['**/__tests__/**/*.test.ts'],
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.d.ts', '!src/index.ts'],
  coverageThreshold: {
    global: {
      lines: 90,
    },
  },
  // No test files exist yet (BaseNode/@CogniNode land in #29/#30).
  // Safe no-op once real __tests__ files are added.
  passWithNoTests: true,
};
