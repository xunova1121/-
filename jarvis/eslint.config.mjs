// 代码检查（npm run lint）：只查会让程序跑不起来或跑错的问题——用了没定义的变量、改了常量、重复定义等。
// 拆分 main.js 时靠它保证“搬过去的代码没有漏掉依赖”。格式交给 Prettier，不在这里管。
import globals from 'globals';

export default [
  { ignores: ['dist/**', 'dist-mobile/**', 'dist-standalone/**', 'node_modules/**', 'android/**', 'public/vendor/**'] },
  {
    files: ['src/main.js', 'src/app/**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.browser }
    },
    rules: {
      'no-undef': 'error',
      'no-const-assign': 'error',
      'no-redeclare': 'error',
      'no-dupe-keys': 'error',
      'no-import-assign': 'error',
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none', varsIgnorePattern: '^_' }],
      // 浏览器自带的同名全局变量（history、prompt、status……）：漏改名字时不会报“没定义”，而是悄悄用到浏览器的，必须禁掉。
      // 真要用浏览器的，写 globalThis.prompt / location.xxx。
      'no-restricted-globals': ['error', 'history', 'prompt', 'status', 'name', 'event', 'close', 'open', 'stop', 'parent', 'top', 'self', 'length', 'origin', 'screen', 'confirm', 'alert', 'print', 'find', 'blur', 'focus', 'closed', 'frames', 'opener', 'external', 'menubar', 'toolbar', 'scroll'],
      'no-use-before-define': ['error', { functions: false, classes: false, variables: false }]
    }
  }
];
