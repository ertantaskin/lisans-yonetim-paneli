import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import nextPlugin from '@next/eslint-plugin-next';

/**
 * Kök ESLint flat config (tüm workspace). Kökten çalışır: `pnpm lint`.
 * Tip-farkında lint Faz 0'da kapalı tutuldu (hız); kural seti Faz 1'de sıkılaşır.
 */
export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/.turbo/**',
      '**/coverage/**',
      'apps/api/drizzle/**',
      '**/next-env.d.ts',
      'docs/**',
      // Tarihî tema anlık görüntüsü — build'e/taramaya girmez (tsconfig `exclude` ve
      // check-use-server `SKIP_DIRS` ile aynı gerekçe); lint de kapsamamalı.
      'apps/admin/theme-backup/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-empty-function': 'off',
    },
  },
  /**
   * ADMIN (Next 15 + React) — `react-hooks` ve `@next/next` kuralları.
   *
   * NEDEN VAR (ölçüldü): kodda ZATEN `// eslint-disable-next-line react-hooks/exhaustive-deps`
   * ve `@next/next/no-img-element` bastırmaları vardı ama bu eklentiler kurulu DEĞİLDİ →
   * ESLint "Definition for rule … was not found" diye 4 HATA veriyordu. Yani yazar kuralın
   * koştuğunu VARSAYMIŞ, kural hiç koşmamıştı (aynı sınıf: shellcheck yönergeleri koşmayan
   * bir shellcheck için yazılmıştı). Kurallar `warn`: amaç CI'ı kırmak değil, bastırmaların
   * gerçek bir kurala oturması ve hook bağımlılık hatalarının görünmesi.
   */
  {
    files: ['apps/admin/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks, '@next/next': nextPlugin },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      '@next/next/no-img-element': 'warn',
    },
  },
  /**
   * KAPI BETİKLERİ (`scripts/*.js`) — CommonJS + Node genel değişkenleri.
   *
   * NEDEN VAR (ölçüldü): varsayılan yapılandırmada `require`/`__dirname`/`process`/`console`
   * TANIMSIZ sayılıyordu → yalnız bu dosyalardan **110 `no-undef` + 19 `no-require-imports`**
   * hatası çıkıyordu. Yani `pnpm lint` HER koşuda kırmızıydı; CI adımı `continue-on-error`
   * olduğu için kimse bakmıyordu ve GERÇEK bir bulgu bu gürültünün içinde kaybolurdu
   * (CLAUDE.md tuzak #19: aralıklı/sürekli kırmızıyı "gürültü" saymak).
   */
  {
    files: ['scripts/**/*.js'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: {
        require: 'readonly',
        module: 'writable',
        __dirname: 'readonly',
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
      },
    },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  /**
   * Yük testi klasörü: k6 çalışma-anı değişkenleri (`__ENV`/`__VU`/`__ITER`) + Node yardımcıları
   * (`load/hmac-req.js` düz CommonJS'tir, k6 içinde koşmaz — imza üretmek için yerelde çalışır).
   */
  {
    files: ['load/**/*.js'],
    languageOptions: {
      globals: {
        __ENV: 'readonly',
        __VU: 'readonly',
        __ITER: 'readonly',
        open: 'readonly',
        console: 'readonly',
        process: 'readonly',
        Buffer: 'readonly',
        require: 'readonly',
        module: 'writable',
        __dirname: 'readonly',
      },
    },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  prettier,
);
