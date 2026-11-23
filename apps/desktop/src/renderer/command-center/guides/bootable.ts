import type { GuideDefinition } from '../guide-types.js';

/**
 * A drive that starts a computer (2026-11-22): OP-CB, its data and its library on one USB
 * drive that boots most PCs into Linux — including one whose own system no longer starts —
 * and also carries the Windows portable copy for a PC that does start.
 *
 * Built on Ventoy (GPL-3.0; ventoy.net): the drive holds ISO files and a menu; a persistence
 * file keeps what is installed in the live system. Read from ventoy.net 2026-11-22: persistence
 * (`CreatePersistentImg.sh`, ext4, label `casper-rw` for Ubuntu and its family, the file on the
 * first partition, `/ventoy/ventoy.json` `persistence` entries) and Secure Boot (on by default
 * since 1.0.76; a one-time MokManager key enrolment per computer; a new key since 1.1.13). OP-CB
 * changes nothing on the computer or the drive itself here: the guide says how, in those tools.
 */
export const BOOTABLE_GUIDE: GuideDefinition = {
  id: 'bootable-drive',
  version: 1,
  section: 'resources',
  title: 'A drive that starts any computer',
  summary:
    'Put OP-CB, its maps and library on a USB drive that boots most PCs into Linux, even one whose own system will not start.',
  whatItDoes:
    'Most PCs can start from a USB drive instead of their own disk. With Ventoy, one drive holds a Linux system (Ubuntu), a file that keeps what you install in it, OP-CB, and OP-CB’s data folder with your maps, library and private folder. Plug it into a computer, choose the drive in the start-up menu, and you are in your own OP-CB — no installing, nothing written to that computer. The same drive carries the Windows portable copy for a PC that starts normally.',
  prerequisites: [
    'A USB drive: 64 GB is enough for OP-CB and a small library; 256 GB or more (a USB SSD is far faster) for Wikipedia and a world map',
    'A Windows or Linux computer to prepare it, and the internet once: Ventoy, an Ubuntu ISO (about 6 GB), and the OP-CB .deb and portable zip',
    'Preparing the drive erases everything on it',
  ],
  equipment: [{ kind: 'Storage', items: ['A USB 3 drive or USB SSD of 64 GB or more'] }],
  steps: [
    {
      id: 'which',
      title: 'What you prepare it on',
      body: [
        'Ventoy installs from Windows or Linux. Whatever you prepare it on, the finished drive starts PCs of any make, and Intel Macs.',
        'Computers that cannot start it: Macs with Apple chips (M1 and later), Chromebooks in their normal mode, and phones or tablets.',
      ],
      choice: {
        prompt: 'I will prepare the drive on',
        options: [
          { id: 'windows', label: 'Windows' },
          { id: 'linux', label: 'Linux' },
          {
            id: 'mac',
            label: 'A Mac',
            detail: 'Ventoy has no Mac installer: borrow a Windows or Linux computer for this part.',
            unsupported: true,
          },
        ],
      },
      byChoice: {
        mac: [
          'Ventoy cannot be installed from macOS. Prepare the drive on a Windows or Linux computer; once made, it starts Intel Macs (hold Option at the chime) as well as PCs.',
        ],
      },
      links: [{ label: 'Ventoy', url: 'https://www.ventoy.net/' }],
    },
    {
      id: 'ventoy',
      title: 'Make the drive bootable with Ventoy',
      body: [
        'Download Ventoy from ventoy.net (or its GitHub releases) and check the download’s SHA-256 against the one published beside it.',
        'Choose the USB drive — the right one: everything on it is erased — and install. Leave Secure Boot support on (the default). The drive ends up with a large partition named Ventoy, readable by Windows, Linux and macOS, where everything below goes.',
      ],
      choiceFrom: 'which',
      byChoice: {
        windows: ['Unzip Ventoy and run Ventoy2Disk.exe. Pick the drive under Device, then Install.'],
        linux: [
          'Unpack Ventoy, then in that folder run: sudo sh Ventoy2Disk.sh -i /dev/sdX — with your USB drive’s name for sdX (lsblk lists drives; check the size to be sure).',
        ],
      },
      needsInternet: 'Downloading Ventoy and Ubuntu needs the internet.',
      links: [
        { label: 'Ventoy: get started', url: 'https://www.ventoy.net/en/doc_start.html' },
        { label: 'Ventoy downloads', url: 'https://www.ventoy.net/en/download.html' },
      ],
    },
    {
      id: 'ubuntu',
      title: 'Put Ubuntu and OP-CB on it',
      body: [
        'Download the Ubuntu Desktop ISO (the current LTS) from ubuntu.com and copy the .iso file onto the Ventoy partition, for example into a folder named ISO. No unpacking: Ventoy starts it as it is.',
        'Copy the OP-CB files onto the drive too: the .deb (for Linux) and the portable zip (for Windows), from the OP-CB releases page. Unzip the portable zip into a folder on the drive: on a Windows PC that starts normally, run OP-CB.exe from there.',
      ],
      needsInternet: 'Downloading Ubuntu and OP-CB needs the internet.',
      links: [
        { label: 'Ubuntu Desktop', url: 'https://ubuntu.com/download/desktop' },
        { label: 'OP-CB releases', url: 'https://github.com/the-x1x1/OP-CB/releases' },
      ],
    },
    {
      id: 'persistence',
      title: 'Keep what you install (persistence)',
      body: [
        'A live Ubuntu forgets everything when it shuts down unless it has a persistence file. Make one of 8 GB or more (OP-CB installed takes about 500 MB; the rest is room for updates and settings): on Linux, with the CreatePersistentImg.sh script from Ventoy’s persistence page — sudo bash CreatePersistentImg.sh -s 8192 — which makes an ext4 file labelled casper-rw, the label Ubuntu looks for. Pre-made files are also on Ventoy’s releases page.',
        'Put the file on the Ventoy partition (for example persistence/ubuntu.dat) and tell Ventoy which ISO it belongs to, in /ventoy/ventoy.json on the drive: a "persistence" list with an "image" (the ISO’s path, e.g. /ISO/ubuntu-24.04-desktop-amd64.iso) and a "backend" (the file’s path). VentoyPlugson edits this file for you.',
        'Keep OP-CB’s maps and library on the big Ventoy partition, not in the persistence file (next step): they can be far larger, and Windows can read them there too.',
      ],
      links: [{ label: 'Ventoy persistence plugin', url: 'https://www.ventoy.net/en/plugin_persistence.html' }],
      troubleshooting: [
        {
          problem: 'Ubuntu starts but forgets OP-CB after a restart',
          fix: 'The persistence file is not being used: check the "image" path in ventoy.json matches the ISO, and choose the persistence entry in Ventoy’s menu when it asks.',
        },
      ],
    },
    {
      id: 'boot',
      title: 'Start a computer from the drive',
      body: [
        'Plug the drive in, switch the computer on and press its start-up menu key straight away — F12 on many Dell and Lenovo computers, F9 on HP, F11 or F8 on many others, Esc on some; Intel Macs: hold Option. Choose the USB drive, then the Ubuntu ISO in Ventoy’s menu, with persistence.',
        'The first time on each computer with Secure Boot on, a blue MokManager screen asks to enrol Ventoy’s key: follow Ventoy’s Secure Boot page (Enroll key, from the drive, then reboot). Done once per computer.',
        'In Ubuntu the first time: open a terminal in the folder holding the .deb and run sudo apt install ./opcb_<version>_amd64.deb, then start OP-CB from the applications list.',
      ],
      links: [{ label: 'Ventoy and Secure Boot', url: 'https://www.ventoy.net/en/doc_secure.html' }],
      troubleshooting: [
        {
          problem: 'The computer starts its own system instead',
          fix: 'The start-up menu key was missed or USB start-up is off: try again pressing the key repeatedly, or allow USB boot in the firmware settings.',
        },
        {
          problem: 'An error screen instead of the blue MokManager screen',
          fix: 'That computer does not accept Ventoy with Secure Boot: switch Secure Boot off in its firmware settings for this start, or turn off Ventoy’s Secure Boot option. Some computers also need "Allow Microsoft 3rd Party UEFI CA" switched on.',
        },
      ],
    },
    {
      id: 'data',
      title: 'Keep OP-CB’s data on the drive',
      body: [
        'In OP-CB on the drive: Command Center → Resources → Where OP-CB keeps its data → Keep all OP-CB data on a drive…, choose a new folder on the Ventoy partition (it appears under /media), and restart OP-CB. Maps, the library and the private folder then live on the big partition.',
        'From here on, download maps (Save to that drive) and books into it.',
        'Label the drive and keep it with your kit. Start it every few months: let Ubuntu and OP-CB update while you are online, and check the maps and books open offline. A drive can fail: two drives, kept apart, are safer than one. The private folder is encrypted, but the rest of the drive is not.',
      ],
    },
    {
      id: 'test',
      title: 'Test: a book from the drive',
      body: [
        'Started from the drive, open Knowledge and make sure the library there holds at least one book (the starter collection or any Kiwix book). This passes when OP-CB, running from the drive, can open a book in its library.',
      ],
      actions: ['library.openKnowledge'],
      check: 'library.builtInBooks',
      final: true,
    },
  ],
};
