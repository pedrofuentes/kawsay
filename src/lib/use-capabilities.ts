// Reads the aggregate CAPABILITY report once on mount (#441) — a boolean-per-seam
// snapshot of the bundled-asset seams that resolve lazily and degrade (media binaries,
// the off-thread cluster worker, the smart-search embedder, the place gazetteer). It
// only READS: nothing here downloads, resolves, or mutates anything. A failed probe (a
// missing bridge or a rejected call) is treated CALMLY as "unknown" — capabilities stays
// null and the UI simply shows no degraded-capability notice, rather than surfacing an
// alarming error to a grieving user (there is no renderer logger to route a diagnostic
// to; the loud, redacted diagnostic already lives main-side).
import { useEffect, useState } from 'react';
import type { CapabilitiesDTO } from '@shared/kawsay-api';
import { useKawsayApi } from './kawsay-api';

export interface UseCapabilitiesResult {
  /** `checking` until the mount-time probe settles, then `ready`. */
  status: 'checking' | 'ready';
  /** The resolved report, or `null` when it could not be read (treated as unknown). */
  capabilities: CapabilitiesDTO | null;
}

const CHECKING: UseCapabilitiesResult = { status: 'checking', capabilities: null };

export function useCapabilities(): UseCapabilitiesResult {
  const api = useKawsayApi();
  const [state, setState] = useState<UseCapabilitiesResult>(CHECKING);

  useEffect(() => {
    if (api === undefined) {
      setState({ status: 'ready', capabilities: null });
      return undefined;
    }
    let active = true;
    void api
      .getCapabilities()
      .then((capabilities) => {
        if (active) setState({ status: 'ready', capabilities });
      })
      .catch(() => {
        // Calm fallback: an unreadable probe is "unknown", never an alarming error.
        if (active) setState({ status: 'ready', capabilities: null });
      });
    return () => {
      active = false;
    };
  }, [api]);

  return state;
}
