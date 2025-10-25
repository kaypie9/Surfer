'use client'

import { ReactNode } from 'react'
import { useAccount, useConnect, useDisconnect } from 'wagmi'
import { farcasterMiniApp } from '@farcaster/miniapp-wagmi-connector'

type Api = {
  address?: `0x${string}`
  isConnected: boolean
  isPending: boolean
  connectFc: () => void
  disconnect: () => void
}

export default function ConnectWallet({
  children,
}: {
  children?: (api: Api) => ReactNode
}) {
  const { address, isConnected } = useAccount()
  const { connect, isPending } = useConnect()
  const { disconnect } = useDisconnect()

  const api: Api = {
    address,
    isConnected,
    isPending,
    connectFc: () => connect({ connector: farcasterMiniApp() }),
    disconnect,
  }

  // no default button, only render what’s passed as children
  return children ? <>{children(api)}</> : null
}
