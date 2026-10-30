import type { GuideDefinition } from '../guide-types.js';

/**
 * Offline maps: on WorldView's own world packs (`.worldpack`), data vaults and place index —
 * nothing replaced. A map is downloaded in the app (runtime support/map-download.ts) or a pack
 * installed from a file.
 */
export const MAPS_GUIDE: GuideDefinition = {
  id: 'offline-maps',
  version: 2,
  section: 'world',
  title: 'Offline maps',
  summary: 'Install a map of your area that works with no internet, and prove it does.',
  whatItDoes:
    'Online, WorldView draws its maps from map servers on the internet. Offline, it can only draw what is stored on this computer: the small world map that ships with it, map tiles it has already shown you (kept in its tile cache), and world packs — files holding a detailed map of one region, with its place names for search.',
  prerequisites: [
    'A world pack file (.worldpack) for your region, or the means to build one (advanced)',
    'Space for it: on this computer or an external drive',
  ],
  equipment: [
    {
      kind: 'Storage',
      items: ['An external SSD for large packs (optional)', 'Enough free space on the internal disk otherwise'],
    },
  ],
  steps: [
    {
      id: 'intro',
      title: 'What works offline, and what does not',
      body: [
        'A world pack holds a flat (2D) street-and-terrain style map of one area, the place names in it for searching, and sometimes reference data such as infrastructure. It is checked when installed: every file inside must match the checksum its manifest lists, and a signed pack says who signed it.',
      ],
      bullets: [
        '2D maps of an installed region: yes, as detailed as the pack is.',
        'Satellite pictures: only the tiles already kept in the tile cache from earlier viewing.',
        '3D terrain: only if terrain data is installed. A world pack today holds none, so the 3D globe offline is smooth, without hills.',
        'Street-level pictures and online place search: not offline.',
        "Outside a pack's area you see the bundled world map, at low detail.",
      ],
    },
    {
      id: 'storage',
      title: 'Where to keep it',
      body: [
        "Small packs can live in WorldView's own folder on this computer. Large ones are better on an external drive, which WorldView calls a data vault: a folder it marks as its own so it can tell that drive from another, and that it never writes to while it is unplugged.",
        'If the drive is unplugged later, its packs are listed as missing, not deleted, and come back when it is plugged in again.',
      ],
      actions: ['maps.addVault'],
      check: 'maps.vaultReady',
      optional: true,
      troubleshooting: [
        {
          problem: 'The drive is "read-only"',
          fix: 'It is mounted read-only, or your user cannot write to it. Remount it writable (Linux) or check its permissions.',
        },
        {
          problem: 'The drive is "absent"',
          fix: 'It is unplugged or not mounted: the folder at that path is not the vault WorldView marked. Plug it in; nothing is written until it is back.',
        },
        { problem: 'No external drive', fix: "Skip this step: packs go into WorldView's own folder." },
      ],
    },
    {
      id: 'get',
      title: 'Download a map (or install one you have)',
      body: [
        "Download the world map: WorldView takes it from Protomaps' daily build of OpenStreetMap, the whole world down to the level of detail you choose. Each level of detail roughly doubles the size, and WorldView tells you the exact size before anything is downloaded. Zoom 6 shows countries, cities and main roads; zoom 8 adds towns and more roads; zoom 10 most streets in towns; full detail (zoom 15, every building) is the whole planet, well over 100 GB — for an external drive.",
        'For more detail where you live or travel, choose "The world plus this area": the world at a lower detail, and the area on the map now down to street level. Give it a name.',
        'The map is checked after downloading — every part of the file must hold together, and the whole-planet file must match the build\'s published checksum — then installed as a world pack, credited "© OpenStreetMap contributors" (ODbL).',
        'Or install a .worldpack file you already have: one you built, or one from someone you trust. Installing checks every file in it before it is used.',
      ],
      needsInternet: 'Downloading a map needs the internet (and Online mode). Using it afterwards does not.',
      actions: ['maps.download', 'maps.installPack'],
      check: 'maps.packActive',
      troubleshooting: [
        {
          problem: 'Refused: a checksum does not match',
          fix: 'The file is damaged or was changed after it was made. Copy it again from the original.',
        },
        {
          problem: 'Refused: needs a newer app',
          fix: 'The pack was made for a later WorldView. Update WorldView while online.',
        },
        {
          problem: 'Signed by an untrusted publisher',
          fix: 'If you know who made it, trust that publisher in Settings → Offline packs; or turn off "only trusted packs".',
        },
        {
          problem: 'Listed but "invalid"',
          fix: 'Its data vault is unplugged, or a file inside went missing. Plug the drive in, or install the pack again.',
        },
      ],
    },
    {
      id: 'offline-test',
      title: 'Test it with the internet off',
      body: [
        'Switch WorldView to Offline mode, then look at your region on the map. This step passes when WorldView is offline and an installed pack is active as its local map.',
        'For a stronger test, also turn off Wi-Fi (or unplug the network cable) and restart WorldView: the map of your region should still be there.',
      ],
      actions: ['mode.offline', 'maps.openMap'],
      check: 'maps.offlineMap',
      final: true,
      troubleshooting: [
        {
          problem: 'The map is blank or blurry in my region',
          fix: "Switch to the 2D map (packs are 2D) and zoom into the pack's area. Check the pack is enabled under Resources.",
        },
      ],
    },
    {
      id: 'search',
      title: 'Find a place offline',
      body: [
        "Search for a town or place inside your pack's area. Offline, search uses the pack's place names and the built-in list of cities; nothing is sent anywhere.",
      ],
      actions: ['maps.searchPlace'],
      check: 'maps.searchOffline',
      optional: true,
    },
    {
      id: 'manage',
      title: 'Keep your maps current',
      body: [
        "Under Command Center → Resources you can switch a pack off and on, remove it (its file is deleted from WorldView's folder or the vault), and see which vault it is on. To update a downloaded map, download it again: the newer build replaces it. To update another pack, install the newer pack file; an update pack applies to the version it was made for.",
        'To back up a pack, copy its .worldpack file somewhere safe; to move it, install it onto another vault.',
      ],
    },
  ],
};
