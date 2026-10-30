import type { GuideDefinition } from '../guide-types.js';

/**
 * Meshtastic and LoRa: the reference walkthrough. Written for someone who has never used a radio.
 *
 * WorldView reads the node's node list, positions, telemetry, firmware and LoRa settings, and
 * never reads text messages. It sends one thing only, on the operator's press each time: a test
 * message to one node (the operator's decision of 2026-10-30), refused while the radio has no
 * region. The radio's region, channel and key are set in the Meshtastic client.
 */
export const MESHTASTIC_GUIDE: GuideDefinition = {
  id: 'meshtastic',
  version: 1,
  section: 'comms',
  title: 'Meshtastic radio (LoRa mesh)',
  summary: 'Plug in a Meshtastic radio and see your mesh on the map, with no internet or phone signal.',
  whatItDoes:
    'A Meshtastic radio talks to other Meshtastic radios directly, over the air, with no phone network and no internet. OP-CB reads your radio and shows where the radios on your mesh are, how strong they are heard and their batteries. It never reads the text messages people send, and it transmits only one thing: a test message, when you press Send.',
  prerequisites: [
    'A Meshtastic-ready radio (this guide helps you check yours) with its antenna',
    'A USB data cable (some cables only charge), or a radio with Wi-Fi on your network',
    'For the last test: a second Meshtastic radio within range, on the same channel',
    'Internet once, only if the radio still needs its firmware installed',
  ],
  equipment: [
    {
      kind: 'Radio with GPS',
      items: ['LILYGO T-Beam', 'LILYGO T-Echo', 'Heltec Wireless Tracker', 'RAK WisBlock with a GPS module'],
    },
    { kind: 'Radio without GPS (cheaper, for a base)', items: ['Heltec LoRa 32 V3', 'RAK WisBlock starter kit'] },
    {
      kind: 'Helps range',
      items: ['A tuned antenna for your frequency band', 'Mounting the radio high (a mast, a window, a hilltop)'],
    },
    { kind: 'Power', items: ['18650 cell for the T-Beam', 'A USB power bank or small solar panel for a fixed node'] },
  ],
  steps: [
    {
      id: 'intro',
      title: 'What LoRa and Meshtastic are',
      body: [
        'LoRa ("long range") is a way of sending small amounts of data by radio over long distances on very little power. It uses licence-free bands, such as 902–928 MHz in the Americas and 863–870 MHz in Europe. LoRa is the hardware and the radio signal.',
        'Meshtastic is free software (firmware) that runs on LoRa hardware and turns radios into a mesh: each radio passes on what it hears, so a message can hop from radio to radio, up to a set number of hops (three by default). A plain LoRa board without Meshtastic firmware does not talk to a mesh.',
      ],
      bullets: [
        'Works with no internet and no phone signal: short texts, positions, battery and sensor readings.',
        'Does not carry voice, pictures or web pages, and is slow: a message is a couple of hundred letters at most.',
        'Range depends on height and what is in the way far more than on the radio. Hand-held radios near the ground in a town often reach 1–5 km; with a clear line of sight from high places it can be tens of kilometres. Hills, buildings, trees and bodies block it.',
        'A good antenna, mounted high and kept clear, matters more than anything else you can buy.',
      ],
    },
    {
      id: 'equipment',
      title: 'Which radio do you have?',
      body: [
        'Pick your radio. If yours is not listed, look for it on the Meshtastic supported-hardware page: if it is not there, it may be a LoRa board that cannot run Meshtastic.',
        'Radios are sold for one frequency band (for example 915 MHz or 868 MHz). The band must be the one allowed where you will use it.',
      ],
      choice: {
        prompt: 'My radio is',
        options: [
          {
            id: 't-beam',
            label: 'LILYGO T-Beam',
            detail: 'ESP32, GPS, holds an 18650 battery. USB serial chip (CP210x or CH9102).',
          },
          { id: 't-echo', label: 'LILYGO T-Echo', detail: 'nRF52, e-paper screen, GPS. Native USB.' },
          {
            id: 'heltec',
            label: 'Heltec LoRa 32 V3 / Wireless Tracker',
            detail: 'ESP32-S3, small screen; the Tracker has GPS.',
          },
          {
            id: 'rak',
            label: 'RAK WisBlock (RAK4631)',
            detail: 'nRF52 core on a base board; GPS is an add-on module.',
          },
          { id: 'other-meshtastic', label: 'Another radio on the Meshtastic hardware list' },
          {
            id: 'generic-lora',
            label: 'A LoRa board not on that list',
            detail: 'Not Meshtastic-ready: a LoRa chip alone does not join a mesh.',
            unsupported: true,
          },
        ],
      },
      byChoice: {
        'generic-lora': [
          'OP-CB can only read radios running Meshtastic firmware. A board that is not on the Meshtastic hardware list may not run it at all; check the list before going further, or use one of the radios above.',
        ],
      },
      links: [{ label: 'Meshtastic supported hardware', url: 'https://meshtastic.org/docs/hardware/devices/' }],
    },
    {
      id: 'hardware',
      title: 'Prepare the radio',
      body: [
        'Screw the antenna on before the radio is ever powered. A LoRa radio that transmits with no antenna can damage itself, and Meshtastic radios send on their own (positions, node info) once set up.',
      ],
      choiceFrom: 'equipment',
      byChoice: {
        't-beam': [
          'T-Beam: fit a charged 18650 cell the right way round (the + mark on the holder), or run it from USB. The power button is the one beside the USB port; hold it to switch off.',
          'Its USB serial chip is a CP210x or a CH9102. Linux has drivers for both. Windows may need the CP210x or CH9102 driver from the chip maker if no COM port appears.',
        ],
        't-echo': [
          "T-Echo: charge it by USB. It uses the nRF52's own USB, so no extra driver is needed on Linux or recent Windows.",
        ],
        heltec: [
          "Heltec: power it by USB, or a 1-cell LiPo on its JST connector (check the polarity: not all batteries match). Windows may need the CP210x driver for older V2 boards; the V3 uses the ESP32-S3's own USB.",
        ],
        rak: [
          "RAK WisBlock: seat the RAK4631 core and any GPS module on the base board before powering it, and fit the LoRa antenna to the core's LoRa connector (there may be a separate Bluetooth one).",
        ],
      },
      bullets: [
        'Use a USB data cable. If the computer does not notice the radio at all, try another cable first: many cables only charge.',
        'On Linux, your user needs permission to open the port: add yourself to the "dialout" group (sudo usermod -aG dialout $USER) and log out and in again.',
        'Plug the radio into the computer. On Linux it appears as /dev/ttyUSB0 or /dev/ttyACM0, and under /dev/serial/by-id with a stable name.',
      ],
    },
    {
      id: 'firmware',
      title: 'Meshtastic firmware',
      body: [
        'Radios bought "Meshtastic pre-installed" are ready. Others need the firmware once. Installing it is done with Meshtastic\'s own tools, not OP-CB, and needs the internet to download: do this before you go offline.',
        'The web flasher works in Chrome or Edge: pick your board, connect, and install. An nRF52 radio (T-Echo, RAK4631) can instead show up as a USB drive: double-press its reset button and copy the .uf2 file onto it.',
        "OP-CB never installs firmware or changes a radio's settings by itself.",
      ],
      needsInternet:
        'Downloading Meshtastic firmware and opening the web flasher need the internet. Everything after this step works offline.',
      links: [
        { label: 'Meshtastic web flasher', url: 'https://flasher.meshtastic.org/' },
        { label: 'Flashing guide', url: 'https://meshtastic.org/docs/getting-started/flashing-firmware/' },
      ],
      optional: true,
    },
    {
      id: 'radio',
      title: 'Set the region and channel',
      body: [
        'A new Meshtastic radio will not transmit until its region is set, and the region decides the frequencies and power it may use. Set it to where you will actually operate the radio — not where you bought it, and not where your computer thinks it is.',
        'Do this in a Meshtastic client: the Meshtastic app on a phone (Bluetooth), the web client in Chrome or Edge, or the meshtastic command-line tool. OP-CB shows the region the radio reports, but does not change radio settings.',
      ],
      choice: {
        prompt: 'I will operate this radio in',
        options: [
          {
            id: 'us',
            label: 'United States, Canada or Mexico',
            detail: 'Region US (902–928 MHz). Needs a 915 MHz radio.',
          },
          { id: 'eu868', label: 'Europe or the UK', detail: 'Region EU_868 (863–870 MHz). Needs an 868 MHz radio.' },
          { id: 'anz', label: 'Australia or New Zealand', detail: 'Region ANZ (915–928 MHz).' },
          { id: 'jp', label: 'Japan', detail: 'Region JP (920 MHz band).' },
          {
            id: 'other',
            label: 'Somewhere else',
            detail: "Look up its region in the Meshtastic client's list and the local rules.",
          },
        ],
      },
      bullets: [
        'Channel: radios only understand each other on the same channel name, settings ("preset", LONG_FAST by default) and key. To join a group, scan their channel QR code or open their channel link in your Meshtastic client.',
        "The key: the default channel's key is public, so anyone with Meshtastic can read it. For a private group, make a channel with a new random key and share its QR code only with your group. Keep it like a password.",
        'GPS: turn on "GPS" in the radio\'s position settings if it has one. A fixed base with no GPS can be given a fixed position instead.',
        "To let OP-CB read it over the network instead of USB, turn on the radio's Wi-Fi and its network API (port 4403) in the network settings.",
      ],
      links: [
        { label: 'LoRa region settings', url: 'https://meshtastic.org/docs/configuration/radio/lora/' },
        { label: 'Channels and keys', url: 'https://meshtastic.org/docs/configuration/radio/channels/' },
      ],
      troubleshooting: [
        {
          problem: 'The region list in the app has no entry for my country',
          fix: "Use the one the Meshtastic documentation gives for it, and check your country's licence-free band and power limits first.",
        },
      ],
    },
    {
      id: 'connect',
      title: 'Connect it to OP-CB',
      body: [
        'OP-CB reads the radio through its "Meshtastic mesh" source: by USB on Linux, or over the network from a radio with Wi-Fi (or from meshtasticd on this computer) on any system.',
        "Switch the source on below, then open its settings and give it the radio's USB port (Linux) or its network address. OP-CB contacts only the address you give; it does not search your network.",
        'This step passes when the source is connected to your radio and has its node list. Its model, battery, GPS state, firmware version, region and preset are shown as the radio reports them; anything it does not report is left out, never guessed.',
      ],
      actions: ['mesh.enable', 'mesh.openSettings'],
      check: 'mesh.nodeConnected',
      troubleshooting: [
        {
          problem: 'Nothing appears as a serial port',
          fix: 'Try another USB cable (a data one), another USB port, and on Windows the CP210x/CH9102 driver. Unplug and plug in again and look in Settings → Diagnostics for the list of ports.',
        },
        {
          problem: '"Permission denied" on the port (Linux)',
          fix: 'Add your user to the dialout group (sudo usermod -aG dialout $USER), then log out and back in.',
        },
        {
          problem: 'On Windows, there is no USB port setting',
          fix: "OP-CB reads a Meshtastic radio over USB on Linux only. On Windows, turn on the radio's Wi-Fi and network API and give OP-CB its address, or run meshtasticd.",
        },
        {
          problem: 'The source says it cannot reach the address',
          fix: "Check the radio is on the same network, its network API is on (port 4403), and the address is right. While working offline, approve the radio's address under Command Center → Resources → Local network.",
        },
        {
          problem: 'Another program has the port open',
          fix: 'Close the Meshtastic web client or CLI if it is connected over USB: only one program can use a serial port at a time.',
        },
        {
          problem: 'Wrong firmware, or it is not a Meshtastic radio',
          fix: 'The source waits for the Meshtastic node list. If none comes, install Meshtastic firmware (the firmware step).',
        },
      ],
    },
    {
      id: 'gps',
      title: 'Your own position',
      body: [
        "If your radio has GPS, OP-CB can show where you are from it. It takes the position only from your own radio's GPS — never from another radio on the mesh — and shows NO FIX, with no position at all, until the GPS has one.",
        'A first fix outdoors with a clear view of the sky can take a few minutes; indoors it may never come.',
      ],
      check: 'mesh.ownFix',
      optional: true,
      troubleshooting: [
        {
          problem: 'Stays at NO FIX',
          fix: "Take the radio outside or to a window with open sky and wait several minutes. Check GPS is turned on in the radio's position settings.",
        },
        { problem: 'My radio has no GPS', fix: 'Skip this step. You can still see other radios on the mesh.' },
      ],
    },
    {
      id: 'two-node',
      title: 'First radio test: hear a second radio',
      body: [
        'This proves the radios reach each other over the air. You need a second Meshtastic radio, switched on, on the same region and channel, within range, and with a position (its own GPS, or a fixed position set in its settings) so it can be placed.',
        'OP-CB looks for another radio heard in the last 15 minutes, and says how: directly, over relays, or only through the internet (which does not count).',
      ],
      check: 'mesh.otherNodeHeard',
      troubleshooting: [
        {
          problem: 'No other radio heard',
          fix: 'Both radios must use the same region, preset and channel key. Move them closer (start in the same room, a few metres apart), then apart again.',
        },
        {
          problem: 'Heard only through the internet (MQTT)',
          fix: 'That is not a radio link. Turn off MQTT on the radios for this test, or move them within radio range.',
        },
        {
          problem: 'The other radio is heard but has no position',
          fix: 'Give it GPS or a fixed position in its own settings so it can be placed.',
        },
        {
          problem: 'Antenna problems',
          fix: 'Check both antennas are screwed on fully and are for your band (a 433 MHz antenna on a 915 MHz radio barely works).',
        },
        {
          problem: 'Out of range',
          fix: 'Raise one radio (a window, a mast) and keep a clear line between them: hills, buildings and bodies block LoRa.',
        },
      ],
    },
    {
      id: 'message',
      title: 'Message test: both ways',
      body: [
        'Now send the other radio one short test message and wait for its acknowledgement. It is sent only when you press Send, on your channel, and only if your radio has a region set. Its text is not kept.',
        'Four things are kept apart, and only the last proves the link both ways: your radio is connected to the computer; your radio accepted the message into its queue; another radio repeated it (so it went out over the air); the radio it was for acknowledged it.',
        'Anyone with your channel key can read what you send. Keep test messages plain.',
      ],
      actions: ['mesh.sendTest'],
      check: 'mesh.messageAcked',
      final: true,
      troubleshooting: [
        {
          problem: 'Refused: region UNSET',
          fix: 'Set the region in the Meshtastic client (the region step). A radio with no region may not transmit.',
        },
        {
          problem: 'Accepted, but nothing heard',
          fix: 'The other radio did not hear it. Check the channel and key match, move closer, and try again in 30 seconds.',
        },
        {
          problem: 'Relayed, but not acknowledged',
          fix: 'It went out, but the radio it was for did not answer: it may be out of range of the relay, or switched off.',
        },
        {
          problem: 'MAX_RETRANSMIT or TIMEOUT',
          fix: 'Your radio tried several times and heard no answer. Move the radios closer or higher.',
        },
        {
          problem: 'DUTY_CYCLE_LIMIT',
          fix: 'Your region limits how much a radio may transmit. Wait a few minutes before trying again.',
        },
      ],
    },
    {
      id: 'map',
      title: 'Your mesh on the map',
      body: [
        'Radios with a position appear on the map as Meshtastic nodes, with how long ago each was heard, its signal (SNR) and its battery when it reports them. Click one for details.',
        "Other people's radios may be on your mesh. Their positions are shown live and are not kept in OP-CB's history, exported or put into packs.",
      ],
      actions: ['mesh.showOnMap'],
      check: 'mesh.onMap',
      optional: true,
    },
    {
      id: 'reference',
      title: 'Quick reference',
      body: ['Kept here for when you are offline. Open this guide again any time from Communications → Meshtastic.'],
      bullets: [
        'Antenna on before power, always.',
        'Same region, preset and channel key on every radio of a group.',
        'Height and a clear line of sight make range; walls, hills and trees take it.',
        'Source not connecting: cable, port permission (Linux dialout), another program holding the port.',
        'NO FIX: open sky and a few minutes.',
        'OP-CB sends only a test message, on your press; chat and read messages in the Meshtastic app.',
      ],
    },
  ],
};
