// app/page.tsx
export const metadata = {
  title: 'Hyper Run',
  description: 'Dodge • Jump • Slide — chain combos for speed',
  openGraph: {
    title: 'Hyper Run',
    description: 'Dodge • Jump • Slide — chain combos for speed',
    images: ['https://hyperrun-theta.vercel.app/images/icon.png'], // absolute URL
  },
  other: {
    'fc:frame': 'vNext', // optional: lets Farcaster know this page can be a frame
  },
};

import GameClient from '@/components/GameClient';

export default function Page() {
  return (
    <main style={{ minHeight: '100svh', display: 'grid', placeItems: 'center', padding: 16 }}>
      <GameClient />
    </main>
  );
}
