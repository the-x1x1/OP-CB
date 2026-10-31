# Taking O'ahu offline — the field workflow

The exemplar for the cyberdeck: everything OP-CB needs for O'ahu, built while online,
carried on the external SSD, checked there, installed onto it, and used with the network off.
Each step says what it proves; the verification status is in [VERIFICATION.md](VERIFICATION.md).

The region is the `oahu` preset (`pnpm worldpack regions`): W −158.35 S 21.20 E −157.60 N 21.75,
O'ahu with a little sea around it. `hawaii` covers all the islands if you want them.

## 1. While online: build the packs

Several small packs rather than one large one. Each stays inside the `.worldpack` limits (zip32,
2 GiB per entry, 8 GiB declared — [OFFLINE-PACKS.md](../OFFLINE-PACKS.md)), and each can be
replaced on its own.

```bash
mkdir -p ~/opcb-field/oahu-2026-10

# The basemap: your own OpenStreetMap extract (docs/OFFLINE-BASEMAPS.md — you download the
# inputs; nothing is fetched by OP-CB), packed as a map pack.
pnpm basemap:build --region oahu --out ~/opcb-field/basemaps
pnpm worldpack build --region oahu --include map --pmtiles ~/opcb-field/basemaps/<file>.pmtiles \
  --id oahu-map --name "O'ahu map" --out ~/opcb-field/oahu-2026-10/oahu-map.worldpack

# Places and airports for search.
pnpm worldpack build --region oahu --include places,airports \
  --places fixtures/places/seed-places.geojson --airports fixtures/airports/seed-airports.geojson \
  --id oahu-places --name "O'ahu places" --out ~/opcb-field/oahu-2026-10/oahu-places.worldpack

# Recent earthquakes from OP-CB's own history, if you want them in the field.
pnpm worldpack build --region oahu --include earthquakes --history-dir ~/.config/OP-CB/history \
  --days 30 --id oahu-quakes --name "O'ahu earthquakes" --out ~/opcb-field/oahu-2026-10/oahu-quakes.worldpack
```

Sign them if you keep a publisher key (`pnpm worldpack keygen`, then `--sign`), and add the
`.worldpack-pub` to OP-CB (Settings → Offline packs → publishers) so they read as trusted.

Only data whose licence allows offline packs goes in: the build refuses a source whose policy
in `config/licenses/providers.json` says no. Third-party data is never shipped with OP-CB.

## 2. Bundle them

```bash
pnpm worldpack bundle ~/opcb-field/oahu-2026-10
```

Every pack is verified (structure, sizes, SHA-256 of every file, signature), and
`opcb-bundle.json` (each pack's id, name, version, bounds, size, SHA-256, signature state)
and `SHA256SUMS.txt` are written beside them. A broken pack, or two packs with the same id,
refuses the whole bundle.

## 3. Carry them to the SSD and check the copy

Copy the folder to the SSD (any folder on it), then:

```bash
pnpm worldpack bundle /media/$USER/FIELD/bundles/oahu-2026-10 --check
# or without the repository:  cd /media/$USER/FIELD/bundles/oahu-2026-10 && sha256sum -c SHA256SUMS.txt
```

A damaged copy, a missing file or a stray one fails here, before anything is installed.

## 4. Install onto the SSD

In OP-CB: Settings → Offline packs → Data vaults → **Add a data vault…** → a folder on the SSD
(e.g. `/media/$USER/FIELD/opcb`). Then **Install pack onto it** for each pack in the bundle.
The packs are verified again, extracted on the SSD, and listed with "on the vault".

## 5. Go offline

Settings → Network → **Work offline**, or simply switch Wi-Fi off and unplug Ethernet. Then:

- the 2D map draws from the O'ahu map pack (choose "OP-CB dark" or "OP-CB light" in 2D);
- search finds O'ahu places and airports from the places pack;
- recorded history replays from OP-CB's own history (internal SSD);
- local receivers on this computer (readsb, Meshtastic) keep running — they are not the internet.

Pulling the SSD makes its packs "not connected" (listed, not forgotten); nothing is written to the
empty mount point; plugging it back brings them back as they were.

## What is proven where

| Step                                                                                                 | Evidence                                                                                        |
| ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Oahu preset, bundle, `--check` (good copy, damaged byte, missing, stray, escaping name)              | `tools/worldpack/src/bundle.test.ts`; the real CLI on two seed-data packs (VERIFICATION.md §M2) |
| Install onto a vault, search from it offline, pull, empty mount point, re-plug, start with it absent | `packages/runtime/test/offline/offline.test.ts` (folders standing in for the SSD)               |
| No connection leaves the computer while working offline                                              | `apps/desktop/scripts/offline-trace-linux.mjs` (strace of every `connect()`), container and CI  |
| A real basemap pack, a real SSD, the P16s with Wi-Fi off                                             | **UNVERIFIED** — hardware checks H7, H8                                                         |
