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
its label (else its id); the route, trip, stop, status, occupancy, congestion and wheelchair
access are properties (a `route` label is mapped too, but the world model keeps only its own
label keys as labels, so it stays a property); speed and bearing are its motion. Selected, a vehicle
has a Transit section that gives them in words — "Stopped at stop 899 (the trip's 1st)", "Many seats
available (0 % full)" — and leaves out what the feed says it does not know.

## Tests

`fixtures/connectors/gtfs-rt/` holds feeds encoded by Google's protobuf library (Python) from
the same field numbers and types — an encoder independent of this reader — with the script
that makes them. `gtfs-realtime.test.ts` decodes them field by field; the MBTA and Entur
definitions run the shared connector suite through their sidecars (all 14 checks).

`recorded/mbta-vehicles.pb` is a slice of MBTA's live feed (header and four vehicles, byte for
byte); the test checks every value the mapping reads against MBTA's own JSON feed from the same
minute. Live reads on 2026-11-11 from the operator's browser (same-origin requests; the build
container cannot reach the agencies): MBTA 367 entities, Entur 384 KB, Metro Transit 35 KB and
OVapi 66 entities, all protobuf starting with the header. CapMetro, TransLink and HSL were not
read same-origin and are unchecked (`docs/providers/LIVE-CHECKS.md`). Feed size decides the cost of the 30 s
cadence: Entur's whole-country feed (384 KB a read) is about 1.1 GB a day, MBTA's (42 KB) about
120 MB — raise `endpoint.intervalSeconds` for a metered link. `connectors/examples/transit/transit.test.ts`
runs the MBTA definition over the recorded slice end to end, with the clock at the minute it was
read: four transit vehicles in the world state with their route, trip, stop and load.
