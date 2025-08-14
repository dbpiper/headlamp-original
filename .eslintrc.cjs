const baseRules = {
  'max-lines': ['warn', 1000],
  'no-magic-numbers': 'warn',
  '@typescript-eslint/no-explicit-any': 'warn',
  'id-length': [
    'error',
    {
      exceptions: ['i', 'j'],
      properties: 'never',
    },
  ],
  'node-import/prefer-node-protocol': 'error',
  '@typescript-eslint/consistent-type-definitions': ['error', 'type'],
  'import/extensions': [
    'error',
    'never',
    {
      ignorePackages: true,
    },
  ],
  'no-restricted-syntax': 'off',
  'consistent-return': 'off',
  'no-nested-ternary': 'off',
  'func-names': 'off',
  'no-lonely-if': 'off',
  'no-unused-expressions': 'off',
  '@typescript-eslint/no-unused-expressions': 'off',
  'import/prefer-default-export': 'off',
  'no-console': 'off',
  'arrow-body-style': ['error', 'as-needed'],
  'arrow-parens': ['error', 'always'],
  'comma-dangle': ['error', 'always-multiline'],
  eqeqeq: [
    'error',
    'always',
    {
      null: 'ignore',
    },
  ],
  'no-var': 'error',
  'object-curly-spacing': ['error', 'always'],
  'prefer-const': [
    'error',
    {
      destructuring: 'all',
    },
  ],
  quotes: [
    'error',
    'single',
    {
      avoidEscape: true,
      allowTemplateLiterals: false,
    },
  ],
  semi: ['error', 'always'],
  curly: ['error', 'all'],
  'dot-notation': 'error',
  'no-plusplus': 'off',
  'no-param-reassign': [
    'error',
    {
      props: true,
      ignorePropertyModificationsFor: ['acc', 'draft', 'ref', 'state'],
    },
  ],
  'prefer-arrow-callback': [
    'error',
    {
      allowNamedFunctions: false,
    },
  ],
  'prefer-rest-params': 'error',
  'prefer-spread': 'error',
  'prefer-template': 'error',
  radix: ['error', 'always'],
  yoda: [
    'error',
    'never',
    {
      onlyEquality: true,
    },
  ],
  'no-underscore-dangle': [
    'warn',
    {
      allowAfterThis: false,
    },
  ],
  'no-use-before-define': [
    'error',
    {
      functions: false,
      classes: true,
      variables: true,
    },
  ],
  'no-unneeded-ternary': 'error',
  'no-mixed-operators': 'off',
  'prefer-destructuring': [
    'error',
    {
      array: true,
      object: true,
    },
    {
      enforceForRenamedProperties: false,
    },
  ],
  'object-shorthand': ['error', 'always'],
  'array-callback-return': 'error',
  'new-cap': [
    'error',
    {
      newIsCap: true,
      capIsNew: false,
    },
  ],
  'no-duplicate-imports': 'error',
  'import/no-extraneous-dependencies': [
    'error',
    {
      devDependencies: [
        'esbuild.config.js',
        '**/*.test.js',
        '**/*.spec.js',
        '**/*.test.ts',
        '**/*.spec.ts',
        '**/tests/**',
      ],
    },
  ],
  'import/no-duplicates': 'error',
  'comma-spacing': [
    'error',
    {
      before: false,
      after: true,
    },
  ],
  'space-before-blocks': ['error', 'always'],
  'space-in-parens': 'off',
  'spaced-comment': [
    'error',
    'always',
    {
      markers: ['/'],
    },
  ],
  camelcase: [
    'error',
    {
      properties: 'never',
      ignoreDestructuring: false,
    },
  ],
  'class-methods-use-this': [
    'error',
    {
      exceptMethods: [],
    },
  ],
  'import/order': [
    'error',
    {
      groups: ['builtin', 'external', 'internal', ['parent', 'sibling', 'index']],
      'newlines-between': 'always',
    },
  ],
  'import/first': 'error',
  'import/newline-after-import': 'error',
  'default-param-last': 'error',
  'max-len': [
    'error',
    {
      code: 100,
      tabWidth: 2,
      ignoreUrls: true,
      ignoreStrings: true,
      ignoreTemplateLiterals: true,
      ignoreComments: false,
    },
  ],
  'object-curly-newline': [
    'error',
    {
      multiline: true,
      consistent: true,
    },
  ],
  'object-property-newline': [
    'error',
    {
      allowMultiplePropertiesPerLine: true,
    },
  ],
  'one-var': ['error', 'never'],
  'no-useless-constructor': 'error',
  'prefer-numeric-literals': 'error',
  'prefer-object-spread': 'error',
};

module.exports = {
  extends: [
    'airbnb-base',
    'plugin:import/recommended',
    'plugin:import/errors',
    'plugin:import/warnings',
    'plugin:promise/recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:prettier/recommended',
  ],
  parserOptions: {
    project: './tsconfig.json',
  },
  env: {
    node: true,
    jest: true,
    es2022: true,
  },
  settings: {
    'import/parsers': {
      '@typescript-eslint/parser': ['.ts', '.tsx'],
    },
    'import/resolver': {
      typescript: {
        alwaysTryTypes: true,
      },
      node: { extensions: ['.js', '.mjs', '.ts', '.tsx', '.d.ts'] },
    },
  },
  plugins: ['import', '@typescript-eslint', 'promise', 'node-import'],
  overrides: [
    {
      files: [
        '**/*.{test,spec}.{js,ts,tsx}',
        'tests/**/*.{js,ts,tsx}'
      ],
      parserOptions: {
        project: null,
      },
      extends: [
        'airbnb-base',
        'plugin:import/recommended',
        'plugin:promise/recommended',
        'plugin:@typescript-eslint/recommended',
        'plugin:prettier/recommended',
      ],
      plugins: ['import', 'promise', '@typescript-eslint'],
      rules: {
        ...baseRules,
        'import/no-extraneous-dependencies': 'off',
        '@typescript-eslint/no-unused-vars': [
          'error',
          {
            argsIgnorePattern: '^_',
          },
        ],
        'import/extensions': [
          'error',
          'never',
          {
            ignorePackages: true,
          },
        ],
      },
    },
    {
      files: ['src/**/*.{ts,tsx}'],
      parserOptions: {
        project: './tsconfig.json',
      },
      rules: {
        // keep base rules; ensure project-aware TS parsing for src
      },
    },
  ],
  rules: baseRules,
};
