import decompress from "decompress";
import { $ } from "../utils/$.js";

export async function downloadResource(href: string) {
  const response = await fetch(href, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Resource download failed with status ${response.status}`);
  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  const tmpdir = await $("mktemp -d");
  await decompress(buffer, tmpdir);
  return tmpdir;
}

export async function disposeResource(path: string) {
  await $(`rm -r "${path}"`).catch(() => void 0);
}
