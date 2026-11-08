import { copyFile, mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const outputDirectory = path.join(root, 'dist');
const importedPathPattern = /(?:\bfrom\s*|\bimport\s*)['"](\.[^'"]+)['"]/g;

function resolveProjectPath(relativePath) {
  const normalizedPath = path.posix.normalize(relativePath.replaceAll('\\', '/'));
  if (path.posix.isAbsolute(normalizedPath) || normalizedPath === '..' || normalizedPath.startsWith('../')) {
    throw new Error(`Build asset escapes the project directory: ${relativePath}`);
  }
  return {
    relativePath: normalizedPath,
    absolutePath: path.resolve(root, ...normalizedPath.split('/'))
  };
}

async function collectModule(relativePath, files) {
  const asset = resolveProjectPath(relativePath);
  if (files.has(asset.relativePath)) return;
  const source = await readFile(asset.absolutePath, 'utf8');
  files.add(asset.relativePath);
  const dependencies = [...source.matchAll(importedPathPattern)].map((match) =>
    path.posix.join(path.posix.dirname(asset.relativePath), match[1]));
  await Promise.all(dependencies.map((dependency) => collectModule(dependency, files)));
}

export async function buildSite() {
  const files = new Set(['index.html']);
  const html = await readFile(path.join(root, 'index.html'), 'utf8');
  const htmlAssets = [...html.matchAll(/(?:href|src)="\.\/([^"]+)"/g)].map((match) => match[1]);
  for (const assetPath of htmlAssets) {
    const asset = resolveProjectPath(assetPath);
    files.add(asset.relativePath);
    if (asset.relativePath.endsWith('.js')) await collectModule(asset.relativePath, files);
    if (asset.relativePath.endsWith('.css')) {
      const css = await readFile(asset.absolutePath, 'utf8');
      const cssAssets = [...css.matchAll(/url\(["']?\.\/([^"')]+)["']?\)/g)].map((match) => match[1]);
      for (const cssAsset of cssAssets) files.add(path.posix.join(path.posix.dirname(asset.relativePath), cssAsset));
    }
  }

  await rm(outputDirectory, { recursive: true, force: true });
  for (const relativePath of files) {
    const source = resolveProjectPath(relativePath);
    const destination = path.join(outputDirectory, ...relativePath.split('/'));
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(source.absolutePath, destination);
  }

  return [...files].sort();
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  const files = await buildSite();
  console.log(`Static site built in dist/ (${files.length} files).`);
}
