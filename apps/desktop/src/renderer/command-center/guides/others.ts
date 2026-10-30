import type { GuideDefinition } from '../guide-types.js';

/** RTL-SDR and other receivers: receive-only, through the decoders the operator runs. */
export const SDR_GUIDE: GuideDefinition = {
  id: 'sdr',
  version: 1,
  section: 'comms',
  title: 'RTL-SDR receiver (aircraft and ships)',
  summary: 'Hear aircraft and ships near you yourself, with a USB radio receiver and no internet.',
  whatItDoes:
    'An RTL-SDR is a cheap USB radio receiver. With a decoder program it picks up the position reports aircraft (ADS-B, 1090 MHz) and ships (AIS, around 162 MHz) broadcast, so you see the traffic around you even with no internet. It only receives: it cannot transmit or send messages.',
  prerequisites: [
    'An RTL-SDR USB receiver (RTL2832U with an R820T2 or R828D tuner)',
    'An antenna for the band: 1090 MHz for aircraft, VHF marine (about 162 MHz) for ships',
    'A decoder program: readsb or dump1090 for aircraft, AIS-catcher or rtl_ais for ships',
  ],
  equipment: [
    { kind: 'Receiver', items: ['RTL-SDR Blog V3 or V4', 'Nooelec NESDR (with a TCXO)'] },
    { kind: 'Antennas', items: ['A 1090 MHz antenna mounted high, for aircraft', 'A marine VHF antenna, for ships'] },
    {
      kind: 'Optional',
      items: ['A 1090 MHz filtered amplifier for weak signals', 'A second receiver to hear aircraft and ships at once'],
    },
  ],
  steps: [
    {
      id: 'intro',
      title: 'What the receiver does',
      body: [
        'Aircraft and ships send their position, speed and identity by radio many times a minute, for anyone to receive. A receiver near you hears those within radio range: aircraft out to a few hundred kilometres when they are high, ships out to a few tens of kilometres, less at ground level or behind hills and buildings.',
        'One receiver tunes one band at a time: aircraft or ships, not both. It is receive-only — an RTL-SDR has no transmitter.',
      ],
    },
    {
      id: 'decoder',
      title: 'Run a decoder',
      body: [
        "OP-CB does not drive the radio itself; a decoder program does, and OP-CB reads what it decodes. OP-CB does not bundle these programs (their licences do not allow it to): install them from your system's packages or their projects.",
      ],
      bullets: [
        'Aircraft: readsb (or dump1090-fa) serves the aircraft it hears as aircraft.json over HTTP, usually on port 8080 at /data/aircraft.json.',
        'Ships: AIS-catcher (or rtl_ais) decodes AIS and serves the sentences (NMEA) over TCP; OP-CB connects to it, on port 10110 unless you give another.',
        'Linux: the kernel\'s DVB driver can grab the dongle first; decoders usually blacklist it (dvb_usb_rtl28xxu). Your user needs access to the USB device (the "plugdev" group or the decoder\'s udev rule).',
        'Windows: the dongle needs the WinUSB driver (installed with Zadig) for most decoders.',
      ],
      needsInternet: 'Installing a decoder needs the internet once. Running it does not.',
      links: [{ label: 'RTL-SDR quick start', url: 'https://www.rtl-sdr.com/qsg' }],
    },
    {
      id: 'connect',
      title: 'Connect it to OP-CB',
      body: [
        'Switch on the source for your decoder below — "Local ADS-B receiver (readsb)" for aircraft, "Local AIS receiver" for ships — and give it the decoder\'s address in its settings. On this computer that is 127.0.0.1; a decoder on another computer of yours (a Raspberry Pi, say) is reached by its address, which you approve for offline use under Resources → Local network.',
      ],
      actions: ['sdr.enable', 'sdr.openSettings'],
      check: 'sdr.sourceOn',
      troubleshooting: [
        {
          problem: 'The source cannot reach the decoder',
          fix: "Check the decoder is running and its port: readsb's web port (often 8080, /data/aircraft.json), or the TCP port AIS-catcher serves NMEA on.",
        },
        {
          problem: 'Works online, stops in Offline mode',
          fix: 'A decoder on another computer is on your network, not this one: approve its address under Resources → Local network.',
        },
        {
          problem: 'usb_claim_interface error',
          fix: 'Another program, or the kernel DVB driver, holds the dongle. Stop it or blacklist dvb_usb_rtl28xxu, then unplug and replug.',
        },
      ],
    },
    {
      id: 'receive',
      title: 'First reception test',
      body: [
        'This passes when OP-CB has objects from your own receiver — aircraft or ships it really heard — not from the internet sources. Near an airport or a coast it is quick; elsewhere it can take a while, and at night there are fewer aircraft.',
      ],
      check: 'sdr.receiving',
      final: true,
      troubleshooting: [
        {
          problem: 'Connected, but nothing heard',
          fix: 'Put the antenna high with a view of the sky (aircraft) or the sea (ships), away from the computer. Check it is the antenna for the band.',
        },
        {
          problem: 'Very few aircraft',
          fix: "The gain may be too high or too low: try the decoder's automatic gain. A filtered amplifier helps in towns.",
        },
      ],
    },
  ],
};

/**
 * The offline library (version 2, 2026-10-30): ZIM files WorldView opens itself, books from the
 * Kiwix catalogue, and the public-domain emergency references. kiwix-serve is optional now.
 */
export const LIBRARY_GUIDE: GuideDefinition = {
  id: 'library',
  version: 2,
  section: 'knowledge',
  title: 'Offline library (Wikipedia, manuals, emergency guides)',
  summary: 'Keep Wikipedia, medical and repair references and emergency guides on this computer, readable offline.',
  whatItDoes:
    'Kiwix publishes whole websites — Wikipedia, WikiMed, iFixit, WikiHow, Wikivoyage, survival and medicine collections — as single files called ZIM files. OP-CB opens ZIM files itself, finds pages by title, and shows them in a reader window with no internet. It also fetches public-domain emergency guides from FEMA, the CDC and the U.S. Army.',
  prerequisites: [
    'The internet once, to download books and guides (reading them needs none)',
    'Room for them: from tens of megabytes for one topic to around 100 GB for all of English Wikipedia with pictures',
  ],
  equipment: [{ kind: 'Storage', items: ['An external SSD for large libraries (keep OP-CB’s data on it: Resources)'] }],
  steps: [
    {
      id: 'intro',
      title: 'What you can keep offline',
      body: [
        'The Kiwix library lists what is available, by language and topic, with each file’s size. Wikipedia comes in sizes: "maxi" with pictures, "nopic" without, "mini" with only the start of each article. Topic selections (medicine, climate, history) are much smaller.',
        'Each file keeps its own licence and credits (Wikipedia’s are CC BY-SA), shown in the book. OP-CB ships no library content: what you download is yours to choose.',
      ],
      links: [{ label: 'Kiwix library', url: 'https://library.kiwix.org/' }],
    },
    {
      id: 'books',
      title: 'Get books',
      body: [
        'In Knowledge, search the Kiwix catalogue and press Download: the file goes into the library folder, is checked against the catalogue and its own checksum, and appears in Your library. A download that stops carries on where it left off.',
        'Or copy .zim files you already have into the library folder (Open the library folder) and press Look again.',
        'This passes when the library holds a book OP-CB can open.',
      ],
      actions: ['library.openKnowledge'],
      check: 'library.builtInBooks',
      needsInternet: 'Downloading books needs the internet. Reading them does not.',
      troubleshooting: [
        {
          problem: '"older xz compression"',
          fix: 'The file was made before about 2021. Download the current version from the catalogue, or open it with kiwix-serve (below).',
        },
        {
          problem: 'Not enough space',
          fix: 'Choose a smaller version (nopic or mini), or keep OP-CB’s data on an external drive (Resources).',
        },
      ],
    },
    {
      id: 'references',
      title: 'Emergency references',
      body: [
        'Six public-domain guides: FEMA’s Are You Ready?, the Army’s Survival and First Aid manuals, and CDC sheets on safe water, wound care and practical skills. One press downloads them; each is checked to be a PDF and its SHA-256 recorded.',
      ],
      actions: ['library.downloadReferences'],
      check: 'library.references',
      needsInternet: 'Downloading needs the internet; the guides then open offline in your PDF viewer.',
    },
    {
      id: 'find',
      title: 'Find a page offline',
      body: [
        'Switch to Offline mode and find a page by the start of its title. Open it to read it in the reader window. This is the final test: it passes when a page was found while OP-CB was offline.',
      ],
      actions: ['mode.offline', 'library.find'],
      check: 'library.findOffline',
      final: true,
      troubleshooting: [
        {
          problem: 'Nothing found',
          fix: 'Titles are matched from their start: "Water" finds "Water purification"; "purification" does not. Try the first word of the subject.',
        },
      ],
    },
    {
      id: 'server',
      title: 'Optional: kiwix-serve for full-text search',
      body: [
        'OP-CB finds pages by title. For searching inside the text of every page, or for files in the older xz format, run kiwix-serve on this computer: kiwix-serve --address=127.0.0.1 --port=8080 /path/to/your/*.zim — OP-CB finds it and searches it too (Knowledge → Kiwix server). Skip this step if you do not need it.',
      ],
      actions: ['services.refresh'],
      check: 'library.running',
      links: [{ label: 'Kiwix downloads', url: 'https://kiwix.org/en/applications/' }],
    },
    {
      id: 'manage',
      title: 'Update or remove books',
      body: [
        'New versions of most files come out every few months: download the new one, then delete the old file from the library folder. Deleting a ZIM file removes the book; OP-CB keeps nothing of it elsewhere.',
      ],
    },
  ],
};

/** Kolibri: an optional learning platform, the operator's own install. */
export const LEARNING_GUIDE: GuideDefinition = {
  id: 'learning',
  version: 1,
  section: 'knowledge',
  title: 'Courses and lessons (Kolibri)',
  summary: 'Optional: offline courses, videos and exercises through Kolibri.',
  whatItDoes:
    'Kolibri, from Learning Equality, is a free offline learning platform: channels of courses, videos and exercises (Khan Academy, CK-12 and many more) imported once and used with no internet. OP-CB finds it on this computer and opens it in your browser.',
  prerequisites: ['Kolibri installed on this computer', 'Channels imported while online, or from a drive'],
  steps: [
    {
      id: 'install',
      title: 'Install Kolibri',
      body: [
        'Install Kolibri for your system from learningequality.org, start it, and finish its setup in the browser. Import channels while online (or from a drive that has them).',
        "Kolibri usually listens on port 8080, the same as the guide's Kiwix example: give one of them another port, and set Kolibri's here under Resources → Local services.",
      ],
      needsInternet: 'Installing Kolibri and importing channels from the internet need it. Using them does not.',
      links: [{ label: 'Kolibri downloads', url: 'https://learningequality.org/download/' }],
    },
    {
      id: 'found',
      title: 'Find Kolibri',
      body: ['This passes when Kolibri answers on this computer at its port, as Kolibri.'],
      actions: ['services.refresh', 'learning.open'],
      check: 'learning.running',
      final: true,
    },
  ],
};

/** Local AI: Ollama, the operator's own install, never required. */
export const AI_GUIDE: GuideDefinition = {
  id: 'local-ai',
  version: 1,
  section: 'intelligence',
  title: 'Local AI assistant',
  summary: 'Optional: ask questions of an AI model that runs on this computer, with no internet.',
  whatItDoes:
    'A language model can answer questions and summarise text. Run with Ollama, it works entirely on this computer: nothing you ask leaves it. Its answers come from the model, not from checked facts: they can be wrong, and are never emergency or medical instructions. With your offline library installed, it can be asked to answer from pages it finds there, and shows which pages they were.',
  prerequisites: [
    'Ollama installed on this computer',
    'At least one model, downloaded while online',
    'Memory: about 4 GB free for a small (3B) model, 8 GB or more for a 7–8B one',
    'Disk: 2–5 GB per model',
  ],
  equipment: [
    {
      kind: 'Helps',
      items: [
        '16 GB of memory or more',
        'A graphics card Ollama supports (on integrated graphics the processor does the work)',
      ],
    },
  ],
  steps: [
    {
      id: 'intro',
      title: 'What to expect',
      body: [
        'On a laptop processor a small model writes a few words a second, and its first answer waits while the model loads (up to a minute or two). It uses a lot of power: on battery, prefer short questions, and the Field profile.',
        'OP-CB does not need it. Everything else works without it.',
      ],
    },
    {
      id: 'install',
      title: 'Install Ollama and a model',
      body: [
        'Install Ollama from ollama.com for your system, and start it (on Linux it runs as a service). Then download a model, for example a small one: ollama pull llama3.2',
        'OP-CB does not run install scripts or download models for you.',
      ],
      needsInternet: 'Installing Ollama and downloading models need the internet. Asking questions does not.',
      links: [
        { label: 'Download Ollama', url: 'https://ollama.com/download' },
        { label: 'Model library', url: 'https://ollama.com/library' },
      ],
    },
    {
      id: 'found',
      title: 'Find Ollama',
      body: ['OP-CB asks http://127.0.0.1:11434 (or the port you set). This passes when Ollama answers there.'],
      actions: ['services.refresh'],
      check: 'ai.running',
      troubleshooting: [
        {
          problem: 'Nothing answers',
          fix: 'Start Ollama (ollama serve, or the Ollama app/service) and check its port.',
        },
      ],
    },
    {
      id: 'model',
      title: 'Choose a model',
      body: ['This passes when Ollama lists at least one model and one is chosen in Local Intelligence.'],
      actions: ['services.refresh', 'ai.openSection'],
      check: 'ai.modelInstalled',
    },
    {
      id: 'test',
      title: 'Offline test',
      body: [
        "Ask the chosen model one short question. This passes when it answers. The answer is labelled as the model's own words; the time it took and its speed are shown so you know what to expect.",
      ],
      actions: ['mode.offline', 'ai.runTest'],
      check: 'ai.inference',
      final: true,
      troubleshooting: [
        {
          problem: 'No answer in time',
          fix: 'The first answer loads the model and can take minutes. Try a smaller model.',
        },
        {
          problem: 'No model called …',
          fix: 'Download it with ollama pull while online, or choose one that is listed.',
        },
      ],
    },
  ],
};

/** Preparedness: the operator's own inventory, on this computer only. */
export const PREP_GUIDE: GuideDefinition = {
  id: 'preparedness',
  version: 1,
  section: 'prepare',
  title: 'Preparedness inventory and plan',
  summary: 'Record your supplies, equipment and contacts, with dates to check, and print the list.',
  whatItDoes:
    'Keeps your own list of emergency supplies and equipment — how much, where, when it expires or needs checking — and your emergency contacts, on this computer only. It reminds you of what is due and prints as a checklist. It is your record, not advice: for what to keep, use official guidance such as your local emergency management agency.',
  prerequisites: ['Your supplies to hand, to count them'],
  steps: [
    {
      id: 'intro',
      title: 'Your records stay here',
      body: [
        "What you enter is kept on this computer only, in OP-CB's folder, and is never sent anywhere. It leaves only when you export it, to a file you choose.",
        "For how much to keep (water per person per day, food, medicines), follow official guidance: Ready.gov in the United States, or your own country's agency.",
      ],
      links: [{ label: 'Ready.gov: build a kit', url: 'https://www.ready.gov/kit' }],
    },
    {
      id: 'start',
      title: 'Start your inventory',
      body: [
        'Add what you have, with how much. "Add a starter list" puts in the usual categories with no quantities (water, food, first aid, light, power, radio, documents) for you to count and fill in; an entry with no quantity counts as not yet checked.',
      ],
      actions: ['prep.addStarter', 'prep.openInventory'],
      check: 'prep.hasItems',
    },
    {
      id: 'essentials',
      title: 'Water and first aid',
      body: ['This passes when you have counted at least your water and a first-aid or medical item.'],
      actions: ['prep.openInventory'],
      check: 'prep.hasWaterAndMedical',
      final: true,
    },
    {
      id: 'contacts',
      title: 'Emergency contacts',
      body: [
        'Add the people and numbers you would need with no phone list to hand: family, a neighbour, your doctor, an out-of-area contact.',
      ],
      actions: ['prep.openInventory'],
      check: 'prep.hasContact',
      optional: true,
    },
    {
      id: 'print',
      title: 'Print it and check it',
      body: [
        'Export the checklist (CSV opens in any spreadsheet to print), and set a check interval on items that need it — batteries, water, medicines. The Overview shows what is expired or due.',
      ],
      actions: ['prep.exportChecklist'],
    },
  ],
};

/** The first walkthrough: the two modes and what to set up. */
export const START_GUIDE: GuideDefinition = {
  id: 'getting-started',
  version: 1,
  section: 'overview',
  title: 'Getting started: online and offline',
  summary: 'How Online and Offline mode work, and what to set up before you lose the internet.',
  whatItDoes:
    'OP-CB works with the internet, and without it from what is installed on this computer. The Command Center shows what is ready for offline use and what still needs setting up.',
  prerequisites: [],
  steps: [
    {
      id: 'modes',
      title: 'Online and Offline',
      body: [
        'Online: OP-CB reads its internet sources — aircraft, ships, satellites, weather, hazards — and can download updates and map tiles.',
        'Offline: OP-CB sends nothing to the internet. It shows what is on this computer: installed maps and packs, your history and saved places, your own receivers and radios, and local services such as an offline library. Reconnecting Wi-Fi does not turn the internet sources back on; only you switching back to Online does.',
        'Offline is enforced by OP-CB on its own requests. It is not a firewall: other programs on the computer, including services you run beside OP-CB, are not stopped by it.',
      ],
    },
    {
      id: 'prepare',
      title: 'Before you go offline',
      body: ['While you still have the internet, set up what you will need. Each has its own walkthrough:'],
      bullets: [
        'World & Maps → Offline maps: a map of your area.',
        'Knowledge → Offline library: Wikipedia and manuals.',
        'Communications → Meshtastic and the receiver: radios that need no internet.',
        'Local Intelligence → Local AI: optional.',
        'Preparedness → Inventory: your supplies and contacts.',
      ],
    },
    {
      id: 'try',
      title: 'Try Offline mode',
      body: [
        'Switch to Offline mode and look around: the Overview says what is ready, and why the rest is not. Switch back whenever you like; nothing kept is lost either way.',
      ],
      actions: ['mode.offline', 'mode.online'],
      check: 'mode.offline',
      final: true,
    },
  ],
};
