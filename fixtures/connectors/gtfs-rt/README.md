# GTFS Realtime test feeds

Encoded by Google's protobuf library (Python, `google.protobuf` 7.36) from message types
declared with the field numbers, types and enums of `gtfs-realtime.proto`
(github.com/google/transit, commit 2ce6aa79, 2026-11-05) — an encoder independent of the
reader in `packages/connector-runtime/src/gtfs-realtime.ts`. Nothing here was recorded from a
live feed: the container cannot reach the transit agencies, and no feed has been read live
yet. Vehicle ids, plates and trips are made up.

- `vehicles.pb`: six entities — `v1` with every vehicle field the reader takes; `v2` with only
  a position; `tu1` a trip update; `v3` deleted; `alert1` an alert; `v4` with carriage details
  (one with occupancy -1: a 10-byte varint) and a trip `NEW` to the schedule.
- `empty.pb`: a header and no entities.
- `trip-updates-only.pb`: a header with no timestamp and one trip update.

The generator is kept beside the test as `generate.py`; run `python3 generate.py .` here.
