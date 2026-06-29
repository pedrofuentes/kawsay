// Per-source metadata for the guided import: a calm card, a plain-language
// "how to export" recipe, and the copy for pointing Kawsay at the saved file or
// folder. Brand names appear as words only (no logos). `{name}` is replaced with
// the loved one's name at render time so the whole flow feels personal.
import type { ReactElement } from 'react';
import type { SourceType } from '@shared/kawsay-api';
import { Icon } from '@renderer/components/Icon';

export interface SourceMeta {
  type: SourceType;
  /** Card title, also used to recognise the source in headings. */
  title: string;
  /** One plain line of what comes in. */
  description: string;
  icon: ReactElement;
  /** Whether the saved export is a single file or a folder. */
  pickerKind: 'file' | 'folder';
  /** Heading for the walkthrough/primer screen (may contain `{name}`). */
  walkthroughHeading: string;
  /** Ordered export instructions; empty for the folder primer. */
  steps: string[];
  /** One-screen primer shown instead of steps (folder source). */
  primer?: string;
  /** Label for the "point at the file/folder" field. */
  locateLabel: string;
  locateHelper: string;
  locatePlaceholder: string;
  /** The "only a copy" reassurance for the locate screen. */
  reassurance: string;
}

const SOURCE_LIST: SourceMeta[] = [
  {
    type: 'whatsapp',
    title: 'WhatsApp chats',
    description: 'Messages, voice notes, photos & videos',
    icon: <Icon name="messages" className="h-6 w-6" />,
    pickerKind: 'file',
    walkthroughHeading: "Bringing in {name}'s WhatsApp",
    steps: [
      'On your phone, open WhatsApp and go to your chat with {name}.',
      'Open the chat menu, choose More, then Export chat.',
      'Choose "Attach media" so photos and voice notes come along.',
      'Send the file to yourself, then save it onto this computer.',
    ],
    locateLabel: 'Where is the WhatsApp file you saved?',
    locateHelper: 'It usually ends in .zip or .txt.',
    locatePlaceholder: 'e.g. Downloads/WhatsApp Chat with …',
    reassurance: "You're just making a copy — nothing will be deleted from WhatsApp.",
  },
  {
    type: 'folder',
    title: 'A folder of photos',
    description: 'From this computer, a phone, or a drive',
    icon: <Icon name="photos" className="h-6 w-6" />,
    pickerKind: 'folder',
    walkthroughHeading: "Choosing a folder of {name}'s photos",
    steps: [],
    primer:
      'Already have photos saved — from iCloud, Google Photos, or a phone? Just point Kawsay at the folder they live in. Kawsay reads the photos where they are and never changes or moves them.',
    locateLabel: 'Which folder are the photos in?',
    locateHelper: 'Choose a folder on this computer or a connected drive.',
    locatePlaceholder: 'e.g. Pictures/From Mum’s phone',
    reassurance: "You're just making a copy — nothing will be deleted, changed, or moved.",
  },
  {
    type: 'google_takeout',
    title: 'Google Takeout',
    description: 'Email and Google Photos',
    icon: <Icon name="archive" className="h-6 w-6" />,
    pickerKind: 'file',
    walkthroughHeading: "Bringing in {name}'s Google memories",
    steps: [
      'On a computer, sign in and go to takeout.google.com.',
      "Choose Google Photos (and Mail, if you'd like), then start the export.",
      'Google sends a download link when it is ready — this can take a while.',
      'Download the file and save it onto this computer.',
    ],
    locateLabel: 'Where is the Takeout file you saved?',
    locateHelper: 'It is usually a .zip file in your Downloads.',
    locatePlaceholder: 'e.g. Downloads/takeout-…zip',
    reassurance: "You're just making a copy — nothing will be deleted from Google.",
  },
  {
    type: 'messenger',
    title: 'Messenger',
    description: 'Messenger chats, photos, videos & voice notes',
    icon: <Icon name="messages" className="h-6 w-6" />,
    pickerKind: 'file',
    walkthroughHeading: "Bringing in {name}'s Messenger chats",
    steps: [
      'On Facebook, open Settings, then "Your information".',
      'Choose "Download your information" and select Messages.',
      'Choose JSON format, create the file, and wait for Facebook to prepare it.',
      'Download the file and save it onto this computer.',
    ],
    locateLabel: 'Where is the Messenger file you saved?',
    locateHelper: 'It is usually a .zip file from Facebook, or an extracted folder.',
    locatePlaceholder: 'e.g. Downloads/facebook-messages-…zip',
    reassurance: "You're just making a copy — nothing will be deleted from Messenger.",
  },
  {
    type: 'facebook',
    title: 'Facebook',
    description: 'Posts, messages, and photos',
    icon: <Icon name="globe" className="h-6 w-6" />,
    pickerKind: 'file',
    walkthroughHeading: "Bringing in {name}'s Facebook memories",
    steps: [
      'On Facebook, open Settings, then "Your information".',
      'Choose "Download your information".',
      'Pick what to include and the date range, then create the file.',
      'Download the file and save it onto this computer.',
    ],
    locateLabel: 'Where is the Facebook file you saved?',
    locateHelper: 'It is usually a .zip file in your Downloads.',
    locatePlaceholder: 'e.g. Downloads/facebook-…zip',
    reassurance: "You're just making a copy — nothing will be deleted from Facebook.",
  },
  {
    type: 'linkedin',
    title: 'LinkedIn',
    description: 'Messages and connections',
    icon: <Icon name="briefcase" className="h-6 w-6" />,
    pickerKind: 'file',
    walkthroughHeading: "Bringing in {name}'s LinkedIn memories",
    steps: [
      'On LinkedIn, open Settings, then "Data privacy".',
      'Choose "Get a copy of your data".',
      'Select what to include, then request the archive.',
      'Download the file and save it onto this computer.',
    ],
    locateLabel: 'Where is the LinkedIn file you saved?',
    locateHelper: 'It is usually a .zip file in your Downloads.',
    locatePlaceholder: 'e.g. Downloads/Basic_LinkedInDataExport_…zip',
    reassurance: "You're just making a copy — nothing will be deleted from LinkedIn.",
  },
];

/** Sources in the order they are offered during onboarding. */
export const SOURCES: SourceMeta[] = SOURCE_LIST;

const BY_TYPE = new Map<SourceType, SourceMeta>(SOURCE_LIST.map((source) => [source.type, source]));

export function getSource(type: SourceType): SourceMeta {
  const source = BY_TYPE.get(type);
  if (source === undefined) {
    throw new Error(`Unknown source type: ${type}`);
  }
  return source;
}

/** Replace every `{name}` placeholder with the loved one's name. */
export function withName(template: string, name: string): string {
  return template.replace(/\{name\}/g, name);
}
