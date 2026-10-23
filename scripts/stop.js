import { fileURLToPath } from "node:url";
process.chdir(fileURLToPath(new URL("../", import.meta.url)));
const { stopService } = await import("../server/runtime.js");
try {
  console.log(await stopService()
    ? "Meeting kit stopped. Port released and public tunnel closed."
    : "No managed meeting kit is running in this project.");
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
}
