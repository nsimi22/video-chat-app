// Flat ESLint config for the Expo mobile app. `npm run lint` (expo lint)
// and CI both run this. Extends eslint-config-expo, which bundles the
// TypeScript / React / React-Native / import rules tuned for Expo.
// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ['dist/*', '.expo/*', 'node_modules/*', 'android/*', 'ios/*'],
  },
]);
