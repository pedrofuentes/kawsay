import type { KawsayAPI } from '@shared/kawsay-api';

declare global {
  interface Window {
    readonly kawsayAPI: KawsayAPI;
  }
}
