import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { crc32 } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { relative, join } from 'node:path';

// Public documentation only; local meeting diagnostics and captures are private.
export const PUBLIC_DOCS = ['HOSTING.md','ROADMAP.md','RELEASE-1.6.md','AUDIT-2026-10-23.md','ACCEPTANCE.md','REFERENCE.md'];

// Store-only ZIP, using Node's native CRC32. No build tool or zip binary required.
function zip(root,files,output) {
  const chunks = [], directory = [];
  let offset = 0;
  for (const file of files.sort()) {
    const name = Buffer.from(file), data = readFileSync(`${root}/${file}`);
    const crc = crc32(data), header = Buffer.alloc(30), central = Buffer.alloc(46);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(data.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(name.length, 26);
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42);
    chunks.push(header, name, data); directory.push(central, name); offset += header.length + name.length + data.length;
  }
  const index = Buffer.concat(directory), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(directory.length / 2, 8); end.writeUInt16LE(directory.length / 2, 10);
  end.writeUInt32LE(index.length, 12); end.writeUInt32LE(offset, 16);
  writeFileSync(`${root}/${output}`, Buffer.concat([...chunks, index, end]));
}

export function packageExtension(root=fileURLToPath(new URL('../',import.meta.url))) {
  zip(root,readdirSync(`${root}/extension`).map(f=>`extension/${f}`),'public/extension.zip');
  // Explicit distribution allowlist: never include credentials, recordings, user data or build output.
  const files=['package.json','package-lock.json','.env.example','.gitignore','.dockerignore','Dockerfile','compose.yaml','README.md','QUICKSTART.md','LICENSE','playwright.config.js','DESIGN.md',...PUBLIC_DOCS.map(name=>`docs/${name}`)];
  for(const dir of ['server','public','scripts','extension','test','deploy','.github']) {
    for(const item of readdirSync(`${root}/${dir}`,{recursive:true,withFileTypes:true})) {
      if(!item.isFile())continue;
      const file=relative(root,join(item.parentPath,item.name)).split('\\').join('/');
      if(!file.endsWith('.zip'))files.push(file);
    }
  }
  zip(root,files,'public/starter-kit.zip');
}
