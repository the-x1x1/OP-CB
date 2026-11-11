# Live checks of the keyless sources

Each source was built against a recorded answer (`fixtures/`, `connectors/enabled/*.test.json`).
Services change their answers without notice; the first screen test of 0.7.1 found the Kiwix
catalogue had moved its downloads to another host and every search came back empty. This file
records when each source's live answer was last compared with what the app reads, and what was
found. `pnpm connector:test --all --live` does the same for the definitions from a machine whose
network reaches them; the build container's does not.

## 2026-11-08

Read from a browser on the operator's network (same-origin requests; the exact request URL the
app sends, taken from the connector runtime with a recording fetch). For a connector: the share
of items in which each field its mapping reads holds a value, compared with the same share in its
fixture; for an ArcGIS layer also whether the server accepts every `outFields` name (a renamed
field is an error). For a coded provider: the keys of the answer and of one record, against the
fixture's.

| Source                                                                          | Answer                                                        | Found                                                                                                                                          |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `eccc-aqhi`                                                                     | 124 stations                                                  | every mapped field in every item                                                                                                               |
| `gdacs-droughts`, `-earthquakes`, `-floods`, `-tropical-cyclones`, `-wildfires` | 18, 12, 15, 197, 12 events                                    | every mapped field; `country`/`iso3` absent for events at sea (as in the fixture)                                                              |
| `gdacs-volcanoes`                                                               | HTTP 404                                                      | no volcano event current (the nine of 2025–26 are closed, by GDACS's search); 404 is GDACS's "none now", already declared `emptyStatus: [404]` |
| `launch-library-2`                                                              | 30 launches                                                   | every mapped field in every item                                                                                                               |
| `swpc-aurora`                                                                   | 1 grid                                                        | `Observation Time`, `Forecast Time`, `coordinates` present                                                                                     |
| `usgs-volcanoes`                                                                | 161 volcanoes                                                 | every field; the notice fields only on the 41 % with a current notice                                                                          |
| `nhc-forecast-cones`, `-points`, `-tracks`, `-past-track`, `-wind-field`        | 1, 8, 1, 2, 1 features (Tropical Storm Pena, Central Pacific) | every `outFields` name accepted and present, no others                                                                                         |
| `nifc-wildfire-perimeters`                                                      | 51 perimeters                                                 | the same                                                                                                                                       |
| `nwps-river-flooding`                                                           | 12 gauges in flood                                            | the same                                                                                                                                       |
| `nws-storm-reports`                                                             | 0 reports                                                     | the query accepted (every field name valid)                                                                                                    |
| `spc-day1-outlook`                                                              | 1 area                                                        | the same                                                                                                                                       |
| `usgs-earthquakes` (feed)                                                       | —                                                             | answer, feature and properties keys identical to the fixture                                                                                   |
| `nws-alerts`                                                                    | 15 alerts (Alaska)                                            | nothing the app reads gone; NWS added `code`, `eventCode`, `language`, `note`, `scope`, `web`                                                  |
| `nhc-storms` (`CurrentStorms.json`)                                             | 1 storm                                                       | every key the app reads, with the same value types (intensity and pressure as strings); NHC added nine more GIS and product links              |
| `adsb-lol` (`/v2/mil`)                                                          | 91 aircraft                                                   | every key present in some aircraft; `alt_baro` a number or `"ground"` as before                                                                |
| `digitraffic-ais` (locations, vessels)                                          | —                                                             | keys identical to the fixtures                                                                                                                 |
| `celestrak` (GP JSON)                                                           | —                                                             | keys identical to the fixture                                                                                                                  |
| `celestrak` SATCAT (`records.php`)                                              | 4 records                                                     | every documented field; numbers as numbers, empties `""`, missing RCS `null`; an unknown number answers 200 with plain text, read as no record |
| `swpc-kp-index`                                                                 | —                                                             | now a list of objects (`{time_tag, Kp, a_running, station_count}`) rather than rows under a header row; `kp-index.ts` already reads both       |

`ndbc-observations` (whitespace-separated text): the header and units lines identical to the
fixture's, 810 stations, every row the 22 columns the definition names.

Public camera catalogues (`cctv-public` packs; the keys the packs read, against the fixtures):

| Pack               | Answer                       | Found                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------ | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `calgary`          | 216 cameras                  | every key; Socrata added `:@computed_region_*` columns                                                                                                                                                                                                                                                                                                                   |
| `drivebc`          | 1,068 cameras                | every key; DriveBC added 25 more (`https_cam`, `marked_stale`, …)                                                                                                                                                                                                                                                                                                        |
| `nsw`              | 250 cameras                  | every key; frames on both hosts the pack already allows                                                                                                                                                                                                                                                                                                                  |
| `iceland`          | 499 images                   | every key; `PntX`/`PntY` added; frames on the allowed directory's host                                                                                                                                                                                                                                                                                                   |
| `dgt`              | 1,938 cameras                | every key, frames on `etraffic.dgt.es`                                                                                                                                                                                                                                                                                                                                   |
| `hongkong` (XML)   | —                            | every element the pack reads                                                                                                                                                                                                                                                                                                                                             |
| `taiwan` THB (XML) | 2,356 cameras                | every element; `LinkVersion` added; stills on `cctv-ssNN.thb.gov.tw`                                                                                                                                                                                                                                                                                                     |
| `singapore`, `tfl` | 1 frame list, 889 cameras    | every key                                                                                                                                                                                                                                                                                                                                                                |
| `fintraffic`       | 815 stations, 813 collecting | **drift:** `municipality`, `province` and `cameraType` are gone from every station. The pack used the first two for a camera's place line; cameras still list, with no place line. The station name (`vt25_Hanko_Santala`) is not parsed for one: its parts are roads, municipalities, villages and streets without a fixed order. A test with the live shape pins this. |

Imagery layers (WMTS/WMS capabilities: the layer, its tile matrix set or style, and its newest
frame):

| Layer                                                                      | Found                                                                                                                                                                                                                                                                                                                                              |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GIBS: GOES-East, GOES-West, Himawari band 13                               | present, `GoogleMapsCompatible_Level6`, PNG; newest frame 10 minutes old                                                                                                                                                                                                                                                                           |
| GIBS: IMERG 30-minute precipitation                                        | present; newest frame about five hours old (IMERG's usual delay)                                                                                                                                                                                                                                                                                   |
| GIBS: VIIRS NOAA-20 true colour                                            | present, `Level9`, JPEG; today's day in the time domain                                                                                                                                                                                                                                                                                            |
| GIBS: VIIRS SNPP true colour                                               | present, but **its newest day is 2026-11-02** in both the capabilities and GIBS's time domain, a week behind NOAA-20: the layer shows that day's picture until GIBS has newer ones; its date was only in the overlay button's tooltip and in What's here, so the Map bar now adds it to a followed picture more than two days old ("· from 2 Nov") |
| GIBS: Black Marble                                                         | present, its one 2016 frame                                                                                                                                                                                                                                                                                                                        |
| nowCOAST: GOES longwave, CONUS base reflectivity, lightning strike density | present with the styles the definitions name; newest frames minutes old                                                                                                                                                                                                                                                                            |
| EUMETSAT: Meteosat 0° and IODC IR 10.8                                     | the WMTS layer and `EPSG:3857 - 512` set present; the WMS time dimension (`timeFrom`) current, 15-minute steps                                                                                                                                                                                                                                     |

Not checked here: Home Assistant (the operator's own), the camera packs that need the operator's key (Ontario, Trafikverket), Taiwan's
freeway list (`tisvcloud.freeway.gov.tw` did not load from the operator's network that day), and the GTFS-realtime transit feeds, which have licence records in `config/licenses/providers.json` but no reader in the app yet.

Also read live the same day and built against: the Kiwix catalogue and Metalink files (and a mirror: HEAD gives the exact size, ranges resume with 206 and the right `Content-Range`, the file starts with the ZIM magic), kiwix-serve's
search (`books.id`), KartaView's photo search, the six emergency references, and Protomaps' build
index (see CHANGELOG, Unreleased).

## 2026-11-09 (UTC)

Digitraffic's AIS service (`digitraffic-ais`), read from the operator's browser with the
`Digitraffic-User: opcb` header: 651 positions in five minutes and 691 static rows in an hour.
The position keys are the fixtures' exactly; the static rows use only the REST spelling
(`referencePointA`…`D`, `shipType`), which the fixtures carry beside the MQTT spelling the reader
also accepts. Five positions and the four static rows for those
ships were kept unchanged as `fixtures/digitraffic-ais/recorded/`, which the provider's tests now
read; the live answer carries values the invented fixtures did not, such as a static row whose
IMO, ship type, reference points and ETA are all "not available", and the provider reads them as
such.

The same evening, the past-day USGS earthquake feed (192 events) and NWS's active alerts (456,
16 with their own polygon) were read the same way, and a few rows of each kept unchanged as
`fixtures/usgs/recorded/` and `fixtures/weather/recorded/`, read by the providers' tests. Both
are US public domain. Each selection was checked against a second read (USGS: the five events
byte for byte; NWS: the selection's SHA-256 in the browser and in the repo); Digitraffic's static
rows matched a second read apart from their timestamps, and its positions, which move by the
minute, rest on the one read.

## 2026-11-11 (UTC)

GTFS Realtime vehicle feeds, read from the operator's browser with same-origin requests (a
cross-origin read from the browser is refused by CORS and says nothing about the feed):

| Source                                                              | Answer                                    | Found                                                                                                                                                |
| ------------------------------------------------------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mbta-gtfs-rt`                                                      | 367 entities, 42,343 bytes                | four vehicles decoded by the app's reader equal MBTA's JSON feed of the same minute field for field; kept as `fixtures/connectors/gtfs-rt/recorded/` |
| `entur-norway-gtfs-rt`                                              | 384,385 bytes, `application/octet-stream` | a protobuf FeedMessage (starts with the header)                                                                                                      |
| `metro-transit-msp-gtfs-rt`                                         | 34,928 bytes                              | the same                                                                                                                                             |
| `ovapi-nl-gtfs-rt`                                                  | 66 entities, 9,008 bytes, no content type | the same; the reader does not rely on the content type                                                                                               |
| `capmetro-gtfs-rt`, `translink-seq-gtfs-rt`, `hsl-helsinki-gtfs-rt` | not read same-origin                      | unchecked                                                                                                                                            |

NOAA's GFS 10 m wind on CoastWatch ERDDAP (`NCEP_Global_Best`), read the same way: the dataset
is a 3-hourly, 0.5° forecast running eight days ahead (time `(last)` is the end of the forecast,
not now), latitude is stored north to south, longitude 0 to 359.5, and the answer's columns are
`time, latitude, longitude, ugrd10m, vgrd10m` in m/s. Its licence reads that the data may be
used and redistributed for free. A coarse grid (20° by 40°, 90 points) for 2026-11-11 03:00 UTC
is kept as `fixtures/connectors/wind/gfs-wind-10deg.json` (rows as served; the envelope written
in ERDDAP's layout; the time moved to 2026-09-23T18:00Z for the suite's clock). `now` in a time
constraint is refused (400: "Start=NaN"); a time between steps is answered with the nearest step
(03:34 → 03:00, 04:40 → 06:00); a time past the forecast is 404. Brackets and parentheses may go
unescaped.

NOAA CoastWatch ERDDAP tabledap (`cwwcNDBCMet`, NDBC buoy observations), read the same way on
2026-11-11: the answer has griddap's layout — `{ table: { columnNames, columnTypes, columnUnits,
rows } }`, `null` where a value is missing — so `response.table` reads it. Variable names are
upper case (`WSPD`, `WD`, `ATMP`, and `WSPU`/`WSPV` for the components); an unknown one is a 400
naming it; a regular-expression station constraint was answered 503 ("temporary problem") at the
time. A buoy's rows are a time series (two rows for 51201 from 00:26 and 00:56). The dataset's
licence line is the same as the GFS grid's (used and redistributed for free, no warranty).
