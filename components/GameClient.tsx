// components/GameClient.tsx
'use client';
import Runner3D from '@/components/Runner3D';

export default function GameClient() {
  const submit = async (score: number) => {
    // call your api here if you want
    // await fetch('/api/score', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ score }) });
    console.log('score', score);
  };
  return (
    <div style={{ position: 'relative' }}>
      <Runner3D onSubmitScore={submit} />
    </div>
  );
}
