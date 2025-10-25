'use client';

import React from 'react';

export default function ClickZones() {
  const key = (k: string) => window.dispatchEvent(new KeyboardEvent('keydown', { key: k }));
  return (
    <div className="pointer-events-auto absolute inset-0 z-10 hidden md:block">
      <div className="absolute inset-y-0 left-0 w-1/3" onClick={() => key('ArrowLeft')} />
      <div className="absolute inset-y-0 right-0 w-1/3" onClick={() => key('ArrowRight')} />
      <div className="absolute bottom-0 left-1/3 right-1/3 h-1/2" onClick={() => key(' ')} />
    </div>
  );
}
