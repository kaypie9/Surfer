// components/AddMiniAppPrompt.tsx
'use client';

import { useEffect, useState, useCallback } from 'react';
import { sdk } from '@farcaster/miniapp-sdk';

const LS_KEY = 'hyperrun:addMiniAppPrompt:added';

export default function AddMiniAppPrompt() {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let ignore = false;

    async function init() {
      try {
        const inMini = (await sdk.isInMiniApp()) === true;
        const added = localStorage.getItem(LS_KEY) === 'yes';
        if (!ignore && inMini && !added) setOpen(true);
      } catch {
        /* no-op */
      }
    }
    init();
    return () => {
      ignore = true;
    };
  }, []);

  const handleConfirm = useCallback(async () => {
    try {
      setBusy(true);
      await sdk.actions.addMiniApp();
      // mark as added only after confirm flow
      localStorage.setItem(LS_KEY, 'yes');
      setOpen(false);
    } catch {
      // user dismissed native prompt or host error
      // do not set flag so it will show next launch
    } finally {
      setBusy(false);
    }
  }, []);

  const handleCancel = useCallback(() => {
    // just close for now, no flag, so it will appear next launch
    setOpen(false);
  }, []);

  if (!open) return null;

  return (
    <div
      aria-modal="true"
      role="dialog"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.6)',
        display: 'grid',
        placeItems: 'center',
        zIndex: 9999,
      }}
    >
<div
  style={{
    width: 320,
    maxWidth: '92vw',
    background: '#111218',
    borderRadius: 14,
    padding: 14,
    color: 'white',
    boxShadow: '0 6px 20px rgba(0,0,0,0.45)',
    border: '1px solid rgba(255,255,255,0.08)',
    transform: 'scale(0.92)', // slightly smaller overall
  }}
>

        <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 12 }}>
          <div
            style={{
              width: 48,
              height: 48,
              borderRadius: 12,
              background: 'linear-gradient(145deg,#00e0ff,#0080ff)',
              display: 'grid',
              placeItems: 'center',
              fontWeight: 800,
            }}
          >
            HR
          </div>
          <div style={{ fontSize: 18, fontWeight: 700 }}>Add Mini App. Hyper Run</div>
        </div>

        <div
          style={{
            background: '#1a1b22',
            borderRadius: 10,
            padding: 12,
            fontSize: 14,
            opacity: 0.9,
            marginBottom: 16,
          }}
        >
          Add to Farcaster for quick access and notifications
        </div>

        <div style={{ display: 'flex', gap: 12, justifyContent: 'space-between' }}>
          <button
            onClick={handleCancel}
            disabled={busy}
            style={{
              flex: 1,
              height: 44,
              borderRadius: 10,
              background: '#262833',
              color: 'white',
              border: '1px solid rgba(255,255,255,0.06)',
              cursor: 'pointer',
            }}
          >
            Cancel
          </button>

          <button
            onClick={handleConfirm}
            disabled={busy}
            style={{
              flex: 1,
              height: 44,
              borderRadius: 10,
              background: 'linear-gradient(90deg,#6b4dff,#8a6bff)',
              color: 'white',
              fontWeight: 700,
              border: 'none',
              cursor: 'pointer',
              opacity: busy ? 0.8 : 1,
            }}
          >
            {busy ? 'Working…' : 'Confirm'}
          </button>
        </div>
      </div>
    </div>
  );
}