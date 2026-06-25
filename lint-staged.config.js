export default {
  '**/*.{ts,tsx}': ['eslint --fix', 'prettier --write'],
  '**/*.{js,json,md,yaml,yml}': ['prettier --write'],
};
