import { createMetaMessagesImporter } from './meta-dyi-messages';

export const messengerImporter = createMetaMessagesImporter({
  id: 'messenger',
  displayName: 'Facebook Messenger',
  rootDir: 'your_activity_across_facebook',
  buckets: ['inbox', 'archived_threads', 'filtered_threads'],
  allowRootlessMessages: true,
  archiveLabel: 'Messenger',
});
