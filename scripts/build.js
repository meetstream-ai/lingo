import { readdirSync, mkdirSync, cpSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { packageExtension, PUBLIC_DOCS } from "./package-extension.js";
packageExtension();
for (const dir of ["server", "public", "scripts", "extension"])
  for (const file of readdirSync(dir))
    if (file.endsWith(".js"))
      execFileSync(process.execPath, ["--check", `${dir}/${file}`], {
        stdio: "inherit",
      });
rmSync("dist", { recursive: true, force: true });
mkdirSync("dist", { recursive: true });
for (const dir of ["public", "server", "scripts", "extension", "test", "deploy", ".github"])
  cpSync(dir, `dist/${dir}`, { recursive: true });
mkdirSync('dist/docs');
for (const name of PUBLIC_DOCS) cpSync(`docs/${name}`, `dist/docs/${name}`);
for (const file of [
  "package.json",
  "package-lock.json",
  ".env.example",
  "README.md",
  "QUICKSTART.md",
  "DESIGN.md",
  "LICENSE",
  "Dockerfile",
  "compose.yaml",
  ".dockerignore",
  ".gitignore",
  "playwright.config.js",
])
  cpSync(file, `dist/${file}`);
console.log(
  "Build verified. dist contains a complete source distribution: npm start (creates .env and installs missing dependencies). Deploy the Node service; dist/public alone is not the application.",
);
