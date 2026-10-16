# Space fixtures (`connectors/enabled/launch-library-2.json`)

Responses the shipped Launch Library 2 definition is tested against, through its sidecar and
`connectors/enabled/shipped.test.ts`. The Space Devs' terms let their data be used and shared in
any form.

| File | What it is |
| --- | --- |
| `ll2-launches-upcoming.json` | **Recorded** from `https://ll.thespacedevs.com/2.3.0/launches/upcoming/?limit=3&mode=normal&format=json` on 2026-10-16 at about 05:40 UTC by the built-in browser on the operator's laptop, then **trimmed** in the browser to the fields a definition reads (status, times, provider, rocket, mission, pad and its location); every value kept is as served. The agencies' biographies, logos, images and launch counts are left out. |
| `ll2-launches-empty.json` | **Invented** in the same shape: no upcoming launches. |
