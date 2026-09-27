// ClearDock's web app has no library build, so this wraps its reusable UI
// components in a throwaway package (.ds-sync/pkg, gitignored) with .d.ts
// emitted by tsc from the real source. The converter bundles this entry;
// main.tsx (which mounts the whole app on import) is never included.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const COMPONENTS = {
  BrandMark: 'web/src/components/Layout.tsx',
  StatusBadge: 'web/src/components/StatusBadge.tsx',
  VerdictBadge: 'web/src/components/StatusBadge.tsx',
  PaymentPanel: 'web/src/payment/PaymentPanel.tsx',
};

const PKG = join('.ds-sync', 'pkg');
rmSync(PKG, { recursive: true, force: true });
mkdirSync(PKG, { recursive: true });

const byFile = {};
for (const [name, file] of Object.entries(COMPONENTS)) (byFile[file] ??= []).push(name);
writeFileSync(
  join(PKG, 'index.ts'),
  Object.entries(byFile)
    .map(([file, names]) => `export { ${names.join(', ')} } from "../../${file.replace(/\.tsx$/, '')}";`)
    .join('\n') + '\n',
);

writeFileSync(
  join(PKG, 'package.json'),
  JSON.stringify({ name: '@cleardock/web-ui', version: '0.1.0', private: true, types: 'types/index.d.ts' }, null, 2),
);

writeFileSync(
  join(PKG, 'tsconfig.json'),
  JSON.stringify(
    {
      compilerOptions: {
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'Bundler',
        jsx: 'react-jsx',
        lib: ['ES2022', 'DOM', 'DOM.Iterable'],
        strict: true,
        skipLibCheck: true,
        allowImportingTsExtensions: true,
        declaration: true,
        emitDeclarationOnly: true,
        rootDir: '../..',
        outDir: 'types',
      },
      files: ['index.ts'],
    },
    null,
    2,
  ),
);

execFileSync(process.execPath, [join('node_modules', 'typescript', 'bin', 'tsc'), '-p', join(PKG, 'tsconfig.json')], {
  stdio: 'inherit',
});
// The converter only reads a cssEntry inside the package: ship the app's stylesheet verbatim.
copyFileSync(join('web', 'src', 'styles.css'), join(PKG, 'styles.css'));
// Flat types entry so the converter's .d.ts glob sees every emitted file.
writeFileSync(join(PKG, 'types', 'index.d.ts'), 'export * from "./.ds-sync/pkg/index";\n');
console.log(`built ${PKG}: ${Object.keys(COMPONENTS).join(', ')}`);
