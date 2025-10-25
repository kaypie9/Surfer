// components/WalletFarcasterBadge.tsx
'use client'

import { useEffect, useState } from 'react'
import { useAccount } from 'wagmi'
import { sdk } from '@farcaster/miniapp-sdk'

export default function WalletFarcasterBadge() {
  const { address } = useAccount()
  const [fid, setFid] = useState<number | null>(null)

  useEffect(() => {
    let on = true
    ;(async () => {
      try {
        // be tolerant to sdk shapes across versions
        const anySdk: any = sdk
        const tryVals = [
          anySdk?.viewer?.fid,
          anySdk?.state?.viewer?.fid,
          anySdk?.context?.viewer?.fid,
          anySdk?.frameContext?.fid,
          anySdk?.params?.fid,
        ].filter(Boolean)
        if (on && tryVals.length) setFid(Number(tryVals[0]))
      } catch {
        // ignore
      }
    })()
    return () => {
      on = false
    }
  }, [])

  const short = address ? address.slice(2, 7) : '-----'

  return (
    <div
      className="pointer-events-auto select-none"
      style={{
        position: 'fixed',
        right: 16,
        bottom: 20,
        zIndex: 50,
      }}
    >
      <div
        style={{
          display: 'flex',
          gap: 8,
          alignItems: 'center',
          padding: '8px 12px',
          borderRadius: 12,
          background:
            'linear-gradient(180deg, rgba(255,255,255,0.18), rgba(255,255,255,0.08))',
          boxShadow: '0 6px 24px rgba(0,0,0,0.35), inset 0 0 0 1px rgba(255,255,255,0.12)',
          backdropFilter: 'blur(6px)',
          WebkitBackdropFilter: 'blur(6px)',
          fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, Ubuntu, Cantarell, sans-serif',
          fontWeight: 700,
          color: 'white',
        }}
      >
        <span
          style={{
            fontSize: 12,
            opacity: 0.8,
            letterSpacing: 0.4,
          }}
        >
          WAL
        </span>
        <span
          style={{
            fontSize: 14,
            padding: '3px 8px',
            borderRadius: 8,
            background: 'rgba(0,0,0,0.35)',
            boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.08)',
          }}
        >
          {short}
        </span>

        <span
          style={{
            fontSize: 12,
            opacity: 0.8,
            letterSpacing: 0.4,
            marginLeft: 6,
          }}
        >
          UID
        </span>
        <span
          style={{
            fontSize: 14,
            padding: '3px 8px',
            borderRadius: 8,
            background: 'rgba(0,0,0,0.35)',
            boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.08)',
            minWidth: 28,
            textAlign: 'center',
          }}
        >
          {fid ?? '---'}
        </span>
      </div>
    </div>
  )
}
