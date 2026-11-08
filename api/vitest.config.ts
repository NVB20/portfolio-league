import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The database test files share one test database and TRUNCATE it between tests.
    // Running the files one after another stops them from wiping each other's rows.
    fileParallelism: false,
  },
});
