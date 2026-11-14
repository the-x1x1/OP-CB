# GTFS Realtime test feeds

Encoded by Google's protobuf library (Python, `google.protobuf` 7.36) from message types
declared with the field numbers, types and enums of `gtfs-realtime.proto`
(github.com/google/transit, commit 2ce6aa79, 2026-11-05) — an encoder independent of the
reader in `packages/connector-runtime/src/gtfs-realtime.ts`. Vehicle ids, plates and trips in
these three are made up.

- `vehicles.pb`: six entities — `v1` with every vehicle field the reader takes; `v2` with only
  a position; `tu1` a trip update; `v3` deleted; `alert1` an alert; `v4` with carriage details
  (one with occupancy -1: a 10-byte varint) and a trip `NEW` to the schedule.
- `empty.pb`: a header and no entities.
- `trip-updates-only.pb`: a header with no timestamp and one trip update.

The generator is kept beside the test as `generate.py`; run `python3 generate.py .` here.

`recorded/mbta-vehicles.pb` is not made up: the header and the first 4 of 367 entities of
MBTA's live VehiclePositions feed, read 2026-11-11 03:29 UTC through the operator's browser and
cut at entity boundaries, byte for byte (`recorded/mbta-vehicles.meta.json` has the source,
hash, licence and selection). Its values are tested against MBTA's own JSON feed read the same
minute. MBTA's data policy allows raw retention and redistribution with the credit
"MBTA / MassDOT" (text only, no logos).
