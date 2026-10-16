# Marine fixtures (`connectors/enabled/ndbc-observations.json`)

Responses the shipped NDBC definition is tested against, through its sidecar and
`connectors/enabled/shipped.test.ts`. NOAA NDBC data are U.S. public domain.

| File | What it is |
| --- | --- |
| `ndbc-latest-obs.txt` | **Recorded** from `https://www.ndbc.noaa.gov/data/latest_obs/latest_obs.txt` on 2026-10-16 at about 06:20 UTC by the built-in browser on the operator's laptop, then **trimmed** to 24 of its 862 lines: the two `#` header lines, the first two stations (buoys 22101 and 22102 off Korea) and every Hawaiʻi and American Samoa station NDBC lists (51000–51214, ILOH1, KLIH1, KWHH1, MOKH1, NWWH1, OOUH1, PRHH1). Lines as served except the date, moved back from `2026 10 16` to `2026 09 23` so the reports are in the past at the shared suite's clock (2026-09-23 20:00 UTC); the column alignment is unchanged. |
| `ndbc-latest-obs-empty.txt` | The same two header lines and no station. |
