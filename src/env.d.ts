import type { KawsayAPI } from '@shared/kawsay-api';

declare global {
  interface Window {
    kawsayAPI?: KawsayAPI;
  }
}
