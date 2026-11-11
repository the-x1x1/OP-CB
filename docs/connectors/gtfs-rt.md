# GTFS Realtime vehicle positions (`gtfs-rt`)

A transit agency's live vehicle positions in GTFS Realtime: a protobuf `FeedMessage`, polled
like any REST source. Each vehicle is an object of type `transit-vehicle` at its position.
Added 2026-11-10.

The reader (`packages/connector-runtime/src/gtfs-realtime.ts`) decodes the feed without a
dependency, from `gtfs-realtime.proto` (google/transit, commit 2ce6aa79, 2026-11-05). It reads
the header and each entity's `vehicle`; trip updates, alerts, shapes, deleted entities and
every field it does not name are skipped, so a feed that carries them still reads. A body
that is not a feed (a web page, a JSON error, a download cut short) is reported as
`MALFORMED`.

## The record a mapping reads

One per vehicle, with the proto's own field names and enums by name; a field the feed left
out is left out.

```json
{
  "id": "entity id",
  "feedTimestamp": 1790193595,
  "vehicle": {
    "trip": {
      "trip_id": "…",
      "route_id": "1",
      "direction_id": 1,
      "start_date": "20260923",
      "start_time": "14:05:00",
      "schedule_relationship": "SCHEDULED"
    },
    "vehicle": {
      "id": "1801",
      "label": "Bus 1801",
      "license_plate": "…",
      "wheelchair_accessible": "WHEELCHAIR_ACCESSIBLE"
    },
    "position": { "latitude": 42.36, "longitude": -71.06, "bearing": 90, "speed": 8.5, "odometer": 123456.75 },
    "stop_id": "…",
    "current_stop_sequence": 5,
    "current_status": "STOPPED_AT",
    "timestamp": 1790193585,
    "congestion_level": "RUNNING_SMOOTHLY",
    "occupancy_status": "MANY_SEATS_AVAILABLE",
    "occupancy_percentage": 30
  }
}
```

`feedTimestamp` is the header's time, for vehicles that carry none of their own. Timestamps
are Unix seconds (the mapping reads them as such); `speed` is metres per second and
`bearing` degrees clockwise from north, as the spec defines them.

## Definitions

`connectors/examples/transit/` has one definition for each feed with a licence record in
`config/licenses/providers.json` — MBTA, CapMetro, Metro Transit (Minneapolis–St Paul),
OVapi (the Netherlands), Entur (Norway, which asks for an `ET-Client-Name` header: the
definition sends `opcb-transit`), TransLink (South East Queensland) and HSL (Helsinki). All
are off and marked `user-configured`; turning one on, or shipping one enabled, waits on the
operator's reading of its licence (the records say what each needs: MBTA's and CapMetro's are
revocable grants, OVapi's NDOV terms are unconfirmed, Metro Transit has no licence text).

They share one mapping: the external id is the vehicle's id (else the entity's), the label
its label (else its id), the route as a second label, and trip, stop, status, occupancy,
congestion and wheelchair access as properties; speed and bearing are its motion.

## Tests

`fixtures/connectors/gtfs-rt/` holds feeds encoded by Google's protobuf library (Python) from
the same field numbers and types — an encoder independent of this reader — with the script
that makes them. `gtfs-realtime.test.ts` decodes them field by field; the MBTA and Entur
definitions run the shared connector suite through their sidecars (all 14 checks). **No feed
has been read live yet:** the build container cannot reach the agencies. A live read of each
before it is turned on is the first check.
