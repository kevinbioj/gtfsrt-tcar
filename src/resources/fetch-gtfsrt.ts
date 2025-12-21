import { decodeGtfsRt } from "../utils/gtfsrt-coding.js";

export async function fetchGtfsrt(href: string) {
	const response = await fetch(href, { signal: AbortSignal.timeout(30_000) });
	if (!response.ok)
		throw new Error(
			`Failed to fetch GTFS-RT at '${href}': ${response.status}.`,
		);

	if (response.status === 204) {
		return { entity: [] };
	}

	const buffer = Buffer.from(await response.arrayBuffer());
	const feed = decodeGtfsRt(buffer);
	if (
		Temporal.Now.instant()
			.since(
				Temporal.Instant.fromEpochMilliseconds(feed.header.timestamp * 1000),
			)
			.total("minutes") >= 10
	) {
		return { entity: [] };
	}

	return feed;
}
