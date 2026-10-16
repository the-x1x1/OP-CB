# Air-quality fixtures (`connectors/enabled/eccc-aqhi.json`)

| File | What it is |
| --- | --- |
| `eccc-aqhi-latest.json` | **Recorded** from `https://api.weather.gc.ca/collections/aqhi-observations-realtime/items?f=json&limit=500&latest=true` on 2026-10-16 at about 07:15 UTC by the built-in browser on the operator's laptop (Data Source: Environment and Climate Change Canada), then **trimmed** to 6 of 124 stations: Tiverton (listed as latest though its reading is from 2026-10-14), Cold Lake, Metro Vancouver - NW, and the three highest readings that hour (Quesnel 4, Castlegar 3, Grande Prairie 3). `observation_datetime` moved back 23 days (2026-10-16 → 2026-09-23 and so on) for the shared suite's clock; the ids and the text times are as served. |
| `eccc-aqhi-empty.json` | **Invented** in the same shape: no stations. |
