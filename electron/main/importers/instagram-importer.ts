import { createMetaMessagesImporter } from './meta-dyi-messages';

export const instagramImporter = createMetaMessagesImporter({
  id: 'instagram',
  displayName: 'Instagram',
  rootDir: 'your_instagram_activity',
  buckets: ['inbox'],
  allowRootlessMessages: false,
  archiveLabel: 'Instagram',
});
