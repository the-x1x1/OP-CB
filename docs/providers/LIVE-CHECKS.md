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
| `swpc-kp-index`                                                                 | —                                                             | now a list of objects (`{time_tag, Kp, a_running, station_count}`) rather than rows under a header row; `kp-index.ts` already reads both       |

Not checked here: `ndbc-observations` (text), the WMS/WMTS imagery layers (capabilities, not
records), Home Assistant (the operator's own), and the camera and transit sources.

Also read live the same day and built against: the Kiwix catalogue and Metalink files, kiwix-serve's
search (`books.id`), KartaView's photo search, the six emergency references, and Protomaps' build
index (see CHANGELOG, Unreleased).
