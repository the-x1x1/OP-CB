# The Command Center (offline preparedness expansion)

_Branch `feature/command-center`, from `feature/roadmap-3` `5dca743`, started 2026-10-30._

OP-CB gains a start screen (Online or Offline), a Command Center over the map with seven
sections, and a guided setup engine whose walkthroughs end in tests that pass only on
evidence. Everything OP-CB already had stays where it was: the map shell is untouched
underneath, and World & Maps → **Show the map** (or Esc) is one press away.

## 1. What already existed and was reused

| Need                | Reused                                                                                                                                      | Where                                                   |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Offline enforcement | Work offline (`network.workOffline`): one switch at every door — the runtime's gated fetch, the session's `webRequest`, Electron `net`      | `apps/desktop/src/main/network-gate.ts`, `main.ts`      |
| Offline maps        | World packs (`.worldpack`: manifest, checksums, signatures, place index), data vaults on external drives, the bundled world, the tile cache | `packages/offline`, `offline.*` IPC, Settings → Offline |
| Radios              | `meshtastic-local` (USB on Linux, TCP anywhere), `readsb-local`, `ais-local`; the Connections tab                                           | `providers/*-local`, `panels/connections-panel.tsx`     |
| Own GPS             | `ProviderHealth.ownPosition` from the Meshtastic node (NO FIX = no coordinates)                                                             | `provider-sdk/health.ts`                                |
| Power, disk, drives | `field.status` (battery, disk headroom, wake), vault health, the field status strip                                                         | `runtime/support`, `components/field-status-model.ts`   |
| Profiles            | Field / Balanced / Docked (`display.profile`, `actions.setProfile`)                                                                         | `store/actions.ts`                                      |
| Records on disk     | `JsonDocStore` (atomic, validated, corrupt files kept aside)                                                                                | `runtime/support/json-doc-store.ts`                     |
| IPC                 | Typed contract, schema-validated in main, demo client, three channel-coverage tests                                                         | `packages/ipc-contract`, `main/ipc-schemas.ts`          |

Not reused, because nothing like it existed: a local-service registry, walkthroughs, readiness,
the preparedness inventory.

## 2. The pieces

| Piece                     | What it does                                                                                                                                                                                                                                                            | Where                                                              |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Operating Mode Controller | `mode.state` / `mode.choose`. Until a mode is chosen in this session the desktop sends **nothing** to the internet (main's `modeChosen` gate), so picking Offline is never preceded by online requests. The choice is remembered (`network.chosenAt`) and changes live. | `ipc-contract/command-center.ts`, `runtime/handlers.ts`, `main.ts` |
| Approved local hosts      | `network.localHosts`: one host each, only private / link-local addresses or local-only names (`localHostProblem`), never a range, the internet or the metadata address. These pass the offline gate (fetch and session).                                                | `network-gate.ts` `blockedOffline`                                 |
| Local Service Registry    | Ollama, kiwix-serve, Kolibri, asked on `http://127.0.0.1:<port>` only, when the shell asks. Never installed, started or stopped by OP-CB.                                                                                                                               | `runtime/support/local-services.ts`                                |
| Guided Setup Engine       | Declarative `GuideDefinition`s (steps, choices, actions, checks, troubleshooting, needs-internet notes); a pure engine (Next only after a passed check, Skip leaves a guide unverified, versioned progress); progress in `guides.json`.                                 | `renderer/command-center/guide-*.ts`, `guides/`                    |
| Checks                    | Pure functions of what the runtime said, each passing only on evidence and saying what it saw.                                                                                                                                                                          | `renderer/command-center/checks.ts`                                |
| Readiness Evaluator       | Ready / Verification required / Setup required / Degraded / Unavailable, each with its reason; Ready only when the walkthrough's final test passed.                                                                                                                     | `renderer/command-center/readiness.ts`                             |
| Preparedness              | `preparedness.json` (items, contacts, notes), due and expired items, CSV checklist (formula cells quoted) and JSON backup to a file the operator chooses.                                                                                                               | `prep.*` IPC, `Prepare` section                                    |
| Mesh test message         | The operator's decision of 2026-10-30. One text to one node, on the press, refused while the radio's region is UNSET or transmit is off; the answer keeps connected / accepted / relayed / acknowledged apart.                                                          | `provider-sdk/test-message.ts`, `meshtastic-local`                 |
| Command Center UI         | Start screen; seven sections; the walkthrough runner.                                                                                                                                                                                                                   | `renderer/command-center/*.tsx`, `command-center.css`              |

New IPC request channels (ADR-004 amendment 2026-10-30): `mode.state`, `mode.choose`,
`services.status`, `services.open`, `library.search`, `mesh.sendTest`, `ai.test`,
`guides.list|save|reset`, `prep.list|save|delete|export`. `services.open` builds the address in
main from settings; the page names only the service and, for the library, a `/content/` path
read strictly (`libraryPath`).

## 3. What "Offline" guarantees, and what it does not

- **Enforced by OP-CB:** its own requests — providers, map tiles, imagery, place search,
  updates, the reachability probe — are refused before they are sent unless they go to this
  computer or an approved host. Reconnecting Wi-Fi changes nothing; only choosing Online does.
- **Not enforced:** other programs. A local service (Ollama, kiwix-serve, Kolibri) is the
  operator's own process; OP-CB asks it over loopback and cannot stop it reaching the
  internet. `ModeState.enforcement` is `'app'` and the start screen and Overview say so.
- Sources that hold their own connection (MQTT, a Meshtastic node over TCP) are not fetches and
  keep running in either mode, as before.

## 4. Walkthroughs

| Guide           | Final test (what must be seen)                                                                          |
| --------------- | ------------------------------------------------------------------------------------------------------- |
| Getting started | Offline mode is on                                                                                      |
| Offline maps    | Offline mode, and an active pack is the local map                                                       |
| Offline library | A library search answered with pages while offline                                                      |
| Kolibri         | Kolibri answers as Kolibri on its port                                                                  |
| Local AI        | The chosen model answered a question (time and tokens/s shown)                                          |
| Meshtastic      | A test message acknowledged by the node it was for (after: a second radio heard by radio within 15 min) |
| RTL-SDR         | Objects heard by the operator's own receiver                                                            |
| Preparedness    | Water and first aid counted                                                                             |

Answer shapes of the local services come from each project's own documentation and tests, read
2026-10-30 (Ollama `docs/api.md`; kiwix-tools `docs/kiwix-serve.rst` and libkiwix
`test/library_server.cpp`, `test/server_search.cpp`; Kolibri `core/device/utils.py`). None
was answered by a running copy. Meshtastic field numbers are from its published message
definitions, read outside this repository (GPL-3.0; nothing vendored).

## 4a. Optional software and its licences

No new npm dependency and nothing bundled. Each service is the operator's own install, reached
over loopback; OP-CB ships none of their code or content.

| Software                            | Licence                               | How OP-CB uses it                                                                               |
| ----------------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Ollama                              | MIT                                   | HTTP on loopback (`/api/version`, `/api/tags`, `/api/generate`)                                 |
| kiwix-serve (kiwix-tools, libkiwix) | GPL-3.0                               | HTTP on loopback (OPDS catalogue, `/search?format=xml`); pages opened in the browser            |
| Kolibri                             | MIT                                   | HTTP on loopback (`/api/public/info/`); opened in the browser                                   |
| Meshtastic firmware                 | GPL-3.0                               | runs on the operator's radio; OP-CB speaks its client API from field numbers (nothing vendored) |
| ZIM content                         | each file's own (Wikipedia: CC BY-SA) | served by the operator's kiwix-serve; never shipped                                             |

## 5. Evidence (2026-10-30)

| Kind                  | State                                                                                                                                                                                                                                                                                                                                 |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Automated, container  | 369 test files, 2,415 pass, 0 fail; typecheck matches the clean baseline; boundary check PASS; Prettier 3.8.1 clean on every touched file (CI's 3.9.8 is the proof); the repository's name check empty                                                                                                                                |
| Simulated integration | Runtime integration tests (mode, guides, preparedness, settings refusals); local services against fixtures copied from each project's docs; Meshtastic send/acknowledge against encoded frames                                                                                                                                        |
| Seen on a screen      | The renderer bundled with esbuild in browser demo mode, driven by Playwright in Chromium: start screen, Overview and readiness, Communications, the Meshtastic walkthrough (steps 1–6, the check refusing in a build with no Meshtastic source), World & Maps, Preparedness with the starter list, Resources, the map shell after Esc |
| Real hardware         | **None.** No T-Beam, RTL-SDR, external SSD, Ollama, kiwix-serve or Kolibri has been used with this code                                                                                                                                                                                                                               |
| Real Electron         | **Not run** in this session (no Electron in the container): the main-process mode gate and `services.open` are type-checked and unit-tested only                                                                                                                                                                                      |

## 6. Known limitations

- One map pack is drawn at a time (the newest). An area download therefore carries the world at
  lower detail too, so the map never goes blank outside the area.
- No light theme: OP-CB's design tokens are dark-only, and the Command Center uses them.
- The library is searched one book at a time (kiwix-serve's rule for multi-book search is one
  language); pages open in the browser, not inside OP-CB (an embedded view would need the
  CSP widened, which is the operator's decision).
- "Ask with your library" gives the model search excerpts, not whole articles.
- The radio's region, channel and key are read, never written: they are set in the Meshtastic
  client.
- CyberChef and offline note-taking were considered and not added: nothing in OP-CB would
  use them, and adding a service only to list it would be decoration.
- Docker, WSL2 and installers for the optional services are not used or required.

## 7. Manual acceptance still required

The seven scenarios of the brief, on the P16s (Linux) and the Windows laptop: first start
offline; a pack installed, the network cut, the map used; a T-Beam configured, connected and a
two-radio message acknowledged; a ZIM library searched offline and an article opened; a local
model answering offline; a start with no network and the SSD unplugged; and the existing map,
sources, history, devices and exports used as before.

## 8. Map download (2026-10-30, the operator's "world map, not just O'ahu")

World & Maps → **Download a map for offline use**, and the offline-maps walkthrough's
"Download a map" step:

- **The world** down to a chosen zoom (5–10), **the world plus the area on the map** down to
  street level (12–15), or **the whole planet** (the build file itself, every zoom; over 100 GB).
- Source: Protomaps' daily OpenStreetMap build (`build.protomaps.com/<date>.pmtiles`), the
  newest named by `build-metadata.protomaps.dev/builds.json` (read live 2026-10-30: 61 builds,
  newest `20261029.pmtiles`, 139,191,612,225 bytes, version 4.15.2). Licence: the register's
  `protomaps-builds` record (ODbL; attribution "Protomaps · © OpenStreetMap contributors (ODbL)"),
  checked by a test against `config/licenses/providers.json`.
- **Check the size** reads only the build's header and the directories that hold wanted tiles;
  the exact size and the free space where it goes are shown before anything is downloaded, and
  a download that would leave less than 1 GB free is refused.
- The extract is written straight into a pack folder (`worldpacks/.downloads/<id>`, or a
  vault's), tile data in coalesced byte ranges (four at a time, retried), hashed as written,
  read back and checked (every directory, every entry inside the file), then given a manifest
  and `licenses/NOTICES.md` and renamed into place (`WorldPackRegistry.adoptDownload`). The
  whole-planet file is streamed with resume and must match the build list's MD5. A cancel or a
  failure removes the folder: nothing half-written is ever live.
- Online only: in Offline mode the gated fetch refuses and the panel says to switch.
- PMTiles is read and written by OP-CB's own code (`packages/offline/src/pmtiles.ts`,
  `pmtiles-extract.ts`) from the published v3 specification; no new dependency.
- `pnpm basemap:extract --world-zoom N [--plan-only]` does the same from the command line:
  how the size of a world map to ship inside the installer will be measured.

Evidence: tile ids against the specification's table (including 12/3423/1763 → 19078479);
synthetic archives extracted and compared tile by tile (world and area, sea deduplicated,
leaves when the root would not fit); the whole flow in the runtime against a fake Protomaps
server (plan, download, verify, install, MD5 refusal, cancel, Offline refusal). Outside the
repository, the specification's Protomaps sample archive (Florence, 92 tiles, zooms 0–15) was
extracted whole and in part and every tile read back byte-identical. **Not yet done:** a
download from the real build server (the container's network refuses it), and a world map
shipped inside the installer (its size has to be measured first, then the operator decides).

## 9. All data on an external drive (2026-10-30)

Resources → **Where OP-CB keeps its data** (`renderer/command-center/data-location-card.tsx`,
`main/data-location.ts`, ADR-004 amendment): the data folder, its kind and free space; **Keep
all OP-CB data on a drive…** (from the next start; the small user documents are copied,
history and packs stay; a folder OP-CB already uses is adopted unchanged); back to the
usual folder; restart. A portable copy keeps everything in `OP-CB-data` beside the app. A
moved folder without OP-CB's marker (the drive not mounted) is never used: the start asks.
Tested with temporary folders in the container; not yet in the packaged app on a real SSD.

## 10. The built-in library and the emergency references (2026-10-30)

The operator's "ship it like NOMAD": the library no longer needs kiwix-serve.

- **Reading ZIM files** (`packages/offline/src/zim.ts`): header, MIME list, the URL-sorted entry
  list (binary search by namespace + path), the title-sorted list (the header's, or the front
  articles' `X/listing/titleOrdered/v1`), redirects, metadata (`M/`), the main page, clusters
  plain or zstd (Node's `zlib.zstdDecompress`, 512 MB cap), large plain clusters read blob by
  blob, and the MD5 the file ends with. xz clusters are refused with words saying so. Written
  from the format, no openZIM code; checked on 2026-10-30 against the openZIM testing suite's
  files (old and new namespace schemes, `wikipedia_en_climate_change_mini_2024-06`, and every
  damaged file there: each either refused or read only where undamaged), which are not in the
  repository. Unit tests build their own files.
- **The library** (`runtime/src/support/zim-library.ts`): every `.zim` in `<data>/library`,
  opened lazily, re-read when files change; title search across books (and, for a question,
  each longer word of it); plain text of an article for grounded answers.
- **The reader** (`main/library-reader.ts`, `library-reader-pages.ts`, ADR-004 amendment): a
  separate window and session, scripts off, a strict CSP, nothing off the book.
- **Downloads** (`runtime/src/support/library-downloads.ts`): the Kiwix OPDS catalogue
  (`library.kiwix.org/catalog/v2/entries?q=&lang=&count=`, shape from libkiwix's tests), only
  download links on `download.kiwix.org`, made https; the Metalink file (RFC 5854) for size,
  SHA-256 and https mirrors; Range continuation from `<library>/.downloads/<file>.part` across
  restarts; size, SHA-256 and the ZIM MD5 (computed while downloading) before the file is
  renamed into the library. Licence register: `kiwix-library`.
- **Emergency references** (`EMERGENCY_REFERENCES` in the contract): six U.S. federal
  public-domain PDFs with their addresses and which were opened on 2026-10-30; fetched on the
  operator's press into `<library>/references/`, `%PDF-` checked, SHA-256 recorded in
  `references.json`; opened with the system's PDF viewer. Licence register:
  `us-federal-preparedness`.
- **The planet map** now continues (`map-download.ts`): `partial.json` beside an unfinished
  whole-planet file names its build; the plan picks that build while the list still offers it;
  the download re-hashes what is there and asks for the rest by Range. Cut-down maps are still
  cleared on failure (quick to make again).
- **Walkthrough**: the library guide is version 2 (books, references, find offline as the final
  test; kiwix-serve an optional step). Readiness counts readable built-in books first.

Evidence: unit tests (`zim.test.ts`, `library-reader.test.ts`, `checks.test.ts`) and runtime
integration tests (`library.test.ts`: listing, title search through redirects, catalogue,
download from a Metalink mirror, SHA-256 refusal, MD5 refusal, continuation after a restart,
references with a fallback and a refused web page, Offline mode; `map-download.test.ts`: the
planet continued after a restart). Not yet seen: the reader window on a screen, a real Kiwix
download, a real reference download, a real planet download.
