import path from "node:path";
import protobufjs from "protobufjs";

import type { Feed } from "../types/gtfs-rt.js";

const root = protobufjs.loadSync(
	path.join(import.meta.dirname, "..", "..", "assets", "gtfs-realtime.proto"),
);
const feedMessage = root.lookupType("transit_realtime.FeedMessage");

export function decodeGtfsRt(payload: Buffer) {
	const decoded = feedMessage.decode(payload);
	return feedMessage.toObject(decoded, {
		enums: String,
		longs: Number,
		defaults: true,
	}) as Feed;
}

export function encodeGtfsRt(payload: Feed) {
	const transformed = feedMessage.fromObject(payload);
	return feedMessage.encode(transformed).finish();
}
