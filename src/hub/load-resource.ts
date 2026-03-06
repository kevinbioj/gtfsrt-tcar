import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Temporal } from "temporal-polyfill";

import { downloadResource } from "./download-resource.js";
import { importResource } from "./import-resource.js";

let currentInterval: NodeJS.Timeout | undefined;

export async function useHubResource(resourceUrl: string) {
	const initialResource = await loadResource(resourceUrl);

	const resource = {
		hub: initialResource.resource,
		lastModified: initialResource.lastModified,
		importedAt: Temporal.Now.instant(),
	};

	if (currentInterval !== undefined) {
		clearInterval(currentInterval);
	}

	currentInterval = setInterval(
		async () => {
			console.log("➔ Checking for HUB resource staleness.");

			try {
				const response = await fetch(resourceUrl, {
					method: "HEAD",
					signal: AbortSignal.timeout(30_000),
				});

				if (!response.ok) {
					console.error(`    ⛛ Got HTTP ${response.status}, aborting.`);
					return;
				}

				if (response.headers.get("last-modified") === resource.lastModified) {
					console.log("    ⛛ HUB resource is up-to-date.");
					return;
				}

				console.log("    ⛛ HUB resource is stale, requesting update.");

				const newResource = await loadResource(resourceUrl);
				resource.hub = newResource.resource;
				resource.lastModified = newResource.lastModified;
				resource.importedAt = Temporal.Now.instant();
			} catch (cause) {
				console.error(`✘ HUB update routine failed:`, cause);
			}
		},
		Temporal.Duration.from({ minutes: 5 }).total("milliseconds"),
	);

	return resource;
}

// --- loadResource

async function loadResource(resourceUrl: string) {
	console.log(`➔ Loading HUB resource at '${resourceUrl}'.`);

	const workingDirectory = await mkdtemp(join(tmpdir(), "gtfsrt-tcar_"));
	console.log(`    ⛛ Generated working directory at '${workingDirectory}'.`);

	try {
		const { lastModified } = await downloadResource(resourceUrl, workingDirectory);
		const resource = await importResource(workingDirectory);
		console.log("✓ Successfully loaded resource!");
		return { resource, lastModified };
	} catch (cause) {
		throw new Error("Failed to load HUB resource", { cause });
		// console.log("✘ Failed to load resource!", error);
	} finally {
		await rm(workingDirectory, { recursive: true });
	}
}
