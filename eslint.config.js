// Lint for the Expo app. `npx expo lint` runs it; CI runs it on every PR (errors fail, warnings don't).
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

module.exports = defineConfig([
  expoConfig,
  {
    // The React Compiler rules are advice only while the compiler is off (app.json has no
    // experiments.reactCompiler). Some flag idiomatic React Native, like useRef(new Animated.Value(0)).current.
    rules: {
      'react-hooks/refs': 'warn',
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/purity': 'warn',
      'react-hooks/preserve-manual-memoization': 'warn',
    },
  },
  {
    // api/ has its own lint config; scraper/ and db/ are local-only tools.
    ignores: ['dist/*', 'web-build/*', 'api/**', 'scraper/**', 'db/**'],
  },
]);
