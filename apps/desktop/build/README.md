# Build resources

electron-builder's `buildResources` directory (`electron-builder.yml`). Nothing here is
packaged into the app; electron-builder embeds `icon.ico` in `WorldView.exe` and uses it for
the NSIS installer, and `icon.png` is the 512 px source for other platforms.

The icon is the OP-CB mark (the operator's own artwork, 2026-10-30): the O with the hazard
trefoil, cropped from the operator's image, padded square and written at 512 px (`icon.png`)
and as a multi-size `icon.ico` (16–256 px) with Pillow. `tools/dev/icon/make-icon.py` drew
the earlier WorldView globe and is no longer used for these files.
