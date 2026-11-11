import { defineConfig } from 'vitest/config';

export default defineConfig({
  // The app-*.test.ts files load app code from ../src. Left alone, Vite compiles those files with the root
  // tsconfig.json, which extends expo/tsconfig.base, and Expo isn't installed in the API's CI job. This package's
  // tsconfig works for them too: the app marks every type-only import with `type`.
  tsconfig: './tsconfig.json',
  test: {
    // The database test files share one test database and TRUNCATE it between tests.
    // Running the files one after another stops them from wiping each other's rows.
    fileParallelism: false,
  },
});
