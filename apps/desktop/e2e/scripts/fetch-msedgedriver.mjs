// Fetch the msedgedriver matching the installed Edge/WebView2 build into
// e2e/.drivers/. Version MUST match or tauri-driver hangs (Tauri docs warn this
// explicitly). WebView2 is evergreen, so we resolve the version at runtime.
import { execSync } from "node:child_process";
import { mkdirSync, existsSync, createWriteStream } from "node:fs";
import { rm } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DRIVERS = resolve(HERE, "..", ".drivers");

function edgeVersion() {
  // ProductVersion of the installed Edge == the WebView2 Evergreen runtime.
  const exe = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
  const out = execSync(
    `powershell -NoProfile -Command "(Get-Item '${exe}').VersionInfo.ProductVersion"`,
  ).toString().trim();
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(out)) throw new Error(`bad Edge version: ${out}`);
  return out;
}

async function main() {
  const version = edgeVersion();
  const exe = resolve(DRIVERS, "msedgedriver.exe");
  const stamp = resolve(DRIVERS, `version-${version}.ok`);
  if (existsSync(exe) && existsSync(stamp)) {
    console.log(`[e2e] msedgedriver ${version} already present`);
    return;
  }
  mkdirSync(DRIVERS, { recursive: true });
  const url = `https://msedgedriver.microsoft.com/${version}/edgedriver_win64.zip`;
  const zip = resolve(DRIVERS, "edgedriver.zip");
  console.log(`[e2e] downloading msedgedriver ${version}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download ${url} -> HTTP ${res.status}`);
  const { Readable } = await import("node:stream");
  await new Promise((ok, err) => {
    const ws = createWriteStream(zip);
    Readable.fromWeb(res.body).pipe(ws).on("finish", ok).on("error", err);
  });
  // Expand-Archive is always available in PowerShell 5+.
  execSync(
    `powershell -NoProfile -Command "Expand-Archive -Path '${zip}' -DestinationPath '${DRIVERS}' -Force"`,
  );
  await rm(zip, { force: true });
  createWriteStream(stamp).end();
  if (!existsSync(exe)) throw new Error("msedgedriver.exe missing after extract");
  console.log(`[e2e] msedgedriver ${version} ready at ${exe}`);
}

main().catch((e) => {
  console.error(`[e2e] fetch-msedgedriver failed: ${e.message}`);
  process.exit(1);
});
