import decompress from "decompress";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REQUEST_TIMEOUT = 30_000;

type Version = {
  lastModified: string | null;
  etag: string | null;
};

export async function downloadArchive(href: string) {
  const directory = await mkdtemp(join(tmpdir(), "gtfsrt-tcar_"));
  const response = await fetch(href, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT),
  });
  if (!response.ok) throw new Error(`Unable to download archive at '${href}': status code ${response.status}.`);
  const version = await getArchiveStaleness(href);
  const buffer = Buffer.from(await response.arrayBuffer());
  await decompress(buffer, directory);
  return { directory, version };
}

export async function getArchiveStaleness(href: string) {
  const response = await fetch(href, {
    method: "HEAD",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT),
  });
  return {
    lastModified: response.headers.get("Last-Modified"),
    etag: response.headers.get("ETag"),
  };
}

export async function isArchiveStale(href: string, version: Version) {
  const response = await fetch(href, {
    method: "HEAD",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT),
  });
  if (response.headers.has("Last-Modified")) {
    return response.headers.get("Last-Modified") !== version.lastModified;
  }
  if (response.headers.has("ETag")) {
    return response.headers.get("ETag") !== version.etag;
  }
  return false;
}
