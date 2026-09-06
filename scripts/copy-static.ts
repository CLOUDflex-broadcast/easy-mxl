#!/usr/bin/env node
/** Copy non-TypeScript runtime assets into the compiled distribution. */
import { cpSync, copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const outputRoot = join(projectRoot, 'dist');

function copyPublicAssets(): void {
  const source = join(projectRoot, 'public');
  const destination = join(outputRoot, 'public');
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (entry.isFile() && extname(entry.name) !== '.ts') {
      copyFileSync(join(source, entry.name), join(destination, entry.name));
    }
  }
}

copyPublicAssets();
cpSync(join(projectRoot, 'catalog'), join(outputRoot, 'catalog'), { recursive: true });
const testFixtures = join(projectRoot, 'test', 'fixtures');
if (existsSync(testFixtures)) {
  cpSync(testFixtures, join(outputRoot, 'test', 'fixtures'), { recursive: true });
}
copyFileSync(join(projectRoot, 'package.json'), join(outputRoot, 'package.json'));
