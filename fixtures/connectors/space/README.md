# Space fixtures (`connectors/enabled/launch-library-2.json`, `swpc-aurora.json`)

Responses the shipped Launch Library 2 definition is tested against, through its sidecar and
`connectors/enabled/shipped.test.ts`. The Space Devs' terms let their data be used and shared in
any form. SWPC's aurora forecast is a U.S. Government work in the public domain.

| File | What it is |
| --- | --- |
| `ll2-launches-upcoming.json` | **Recorded** from `https://ll.thespacedevs.com/2.3.0/launches/upcoming/?limit=3&mode=normal&format=json` on 2026-10-16 at about 05:40 UTC by the built-in browser on the operator's laptop, then **trimmed** in the browser to the fields a definition reads (status, times, provider, rocket, mission, pad and its location); every value kept is as served. The agencies' biographies, logos, images and launch counts are left out. |
| `swpc-ovation-aurora.json` | **Recorded** from `https://services.swpc.noaa.gov/json/ovation_aurora_latest.json` on 2026-10-16 at about 07:20 UTC by the built-in browser on the operator's laptop (observation 07:08Z, forecast 08:11Z; a quiet evening, peak 17%), then **trimmed** to 180°–270° E and 50°–80° N (2,821 of 65,160 points, Alaska and western Canada), every value as served. The two times moved back to 2026-09-23 19:05Z and 20:08Z for the shared suite's clock, the 63 minutes between them kept. |
| `swpc-ovation-quiet.json` | **Invented** in the same shape: nine points, none above 3% — no area at 10%. |
| `ll2-launches-empty.json` | **Invented** in the same shape: no upcoming launches. |
