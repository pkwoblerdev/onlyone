'use strict';

const fs = require('node:fs');
const path = require('node:path');
let asar;
try {
  asar = require('@electron/asar');
} catch {
  const fallbackPaths = [
    ...(require.main ? require.main.paths : []),
    ...(module.parent ? module.parent.paths : []),
    'C:\\Users\\Katana\\AppData\\Local\\npm-cache\\_npx\\009083ec26dc578f\\node_modules'
  ];
  const found = fallbackPaths.find(p => fs.existsSync(path.join(p, '@electron', 'asar')));
  if (found) asar = require(path.join(found, '@electron', 'asar'));
  else asar = require('asar');
}

function normalizeArchivePath(value) {
  return value.replace(/\\/g, '/').replace(/^\/+/, '');
}

function packageManifestPath(name) {
  return `node_modules/${name}/package.json`;
}

function verifyArchive(archivePath) {
  const files = asar.listPackage(archivePath).map(normalizeArchivePath);
  const fileSet = new Set(files);
  const manifests = files.filter(file => /(?:^|\/)node_modules\/.+\/package\.json$/.test(file));
  for (const required of ['tools/plugin/install.cjs', 'tools/plugin/manifest.cjs', 'tools/plugin/trust.cjs']) {
    if (!fileSet.has(required)) throw new Error(`app.asar is missing runtime file: ${required}`);
  }
  const rootManifestPath = 'package.json';
  if (!fileSet.has(rootManifestPath)) throw new Error('app.asar is missing package.json');

  const readJson = archiveFile => {
    try {
      // @electron/asar normalizes package entry separators to the host OS;
      // on Windows its reader expects backslashes, not the slash form in our index.
      const nativeArchivePath = archiveFile.split('/').join(path.sep);
      return JSON.parse(asar.extractFile(archivePath, nativeArchivePath).toString('utf8'));
    } catch (error) {
      throw new Error(`Cannot read ${archiveFile} from app.asar: ${error.message}`);
    }
  };

  const root = readJson(rootManifestPath);
  const queue = Object.entries(root.dependencies || {}).map(([name, range]) => ({ name, range }));
  const visited = new Set();
  const missing = [];

  while (queue.length) {
    const { name, range } = queue.shift();
    if (visited.has(name)) continue;
    visited.add(name);

    let manifestPath = packageManifestPath(name);
    if (!fileSet.has(manifestPath)) {
      const suffix = `/node_modules/${name}/package.json`;
      manifestPath = manifests.find(file => file.endsWith(suffix));
    }
    if (!manifestPath) {
      missing.push(`${name} (${range})`);
      continue;
    }

    const manifest = readJson(manifestPath);
    for (const [dependency, dependencyRange] of Object.entries(manifest.dependencies || {})) {
      queue.push({ name: dependency, range: dependencyRange });
    }
  }

  if (missing.length) {
    throw new Error(`app.asar is missing production dependency package(s):\n - ${missing.join('\n - ')}`);
  }
  return { packageCount: visited.size, version: root.version };
}

async function afterPack(context) {
  const archivePath = path.join(context.appOutDir, 'resources', 'app.asar');
  if (!fs.existsSync(archivePath)) throw new Error(`Packaged app.asar not found: ${archivePath}`);
  const result = verifyArchive(archivePath);
  const cliDir = path.join(context.appOutDir, 'resources', 'cli');
  fs.mkdirSync(cliDir, { recursive: true });
  fs.writeFileSync(path.join(cliDir, 'version.json'), JSON.stringify({ version: result.version }));
  console.log(`[runtime-dependencies] verified ${result.packageCount} production packages in app.asar (v${result.version})`);
}

module.exports = afterPack;
module.exports.verifyArchive = verifyArchive;

if (require.main === module) {
  const archivePath = process.argv[2];
  if (!archivePath) {
    console.error('Usage: node scripts/verify-packaged-runtime-dependencies.cjs <path-to-app.asar>');
    process.exitCode = 2;
  } else {
    try {
      const result = verifyArchive(path.resolve(archivePath));
      console.log(`PASS: ${result.packageCount} production packages present in app.asar (v${result.version})`);
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}
