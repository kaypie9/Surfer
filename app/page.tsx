import GameClient from '@/components/GameClient';

export default function Page() {
  return (
    <main style={{ minHeight: '100svh', display: 'grid', placeItems: 'center', padding: 16 }}>
      <GameClient />
    </main>
  );
}
