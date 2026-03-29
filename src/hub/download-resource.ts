import decompress from "decompress";

export async function downloadResource(resourceUrl: string, outputDirectory: string) {
	const lastModifiedResponse = await fetch(resourceUrl, { method: "HEAD", signal: AbortSignal.timeout(3_000) });

	const response = await fetch(resourceUrl, {
		signal: AbortSignal.timeout(30_000),
	});

	if (!response.ok) {
		throw new Error(`Failed to download HUB at '${resourceUrl}' (HTTP ${response.status})`);
	}

	const parts = Buffer.from(await response.arrayBuffer());
	await decompress(parts, outputDirectory);

	return { lastModified: lastModifiedResponse.headers.get("Last-Modified")! };
}
