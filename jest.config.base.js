module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.test.ts', '**/*.spec.ts'],
  collectCoverageFrom: ['src/**/*.ts', '!src/index.ts'],
  coverageThreshold: {
    global: { branches: 70, functions: 80, lines: 80, statements: 80 },
  },
  moduleNameMapper: {
    '@orchestra-engine/types': '<rootDir>/../../packages/types/src/index.ts',
    '@orchestra-engine/kafka': '<rootDir>/../../packages/kafka/src/index.ts',
    '@orchestra-engine/redis': '<rootDir>/../../packages/redis/src/index.ts',
    '@orchestra-engine/prisma': '<rootDir>/../../packages/prisma/src/index.ts',
  },
};
