import GtfsRealtime from "gtfs-realtime-bindings";
import type { Context } from "hono";
import { stream } from "hono/streaming";

import { createFeed } from "./create-feed.js";

export function handleRequest(
	c: Context,
	output: "protobuf" | "json",
	tripUpdates: Map<string, GtfsRealtime.transit_realtime.ITripUpdate> | null,
	vehiclePositions: Map<string, GtfsRealtime.transit_realtime.IVehiclePosition> | null,
	detourEntities: readonly GtfsRealtime.transit_realtime.IFeedEntity[] | null = null,
	alertEntities: readonly GtfsRealtime.transit_realtime.IFeedEntity[] | null = null,
) {
	const feed = createFeed(tripUpdates, vehiclePositions, detourEntities, alertEntities);

	if (output === "json") {
		c.header("Content-Type", "application/json");
		return c.json(feed, 200);
	}

	c.header("Content-Type", "application/octet-stream");
	return stream(c, async (stream) => {
		const encoded = GtfsRealtime.transit_realtime.FeedMessage.encode(feed).finish();
		await stream.write(encoded);
	});
}
