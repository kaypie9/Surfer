'use client';

import React from 'react';
import { cn } from '@/lib/utils';

type OverlayProps = {
  visible: boolean;
  title?: string;
  subtitle?: string;
  primaryText?: string;
  secondaryText?: string;
  onPrimary?: () => void;
  onSecondary?: () => void;
  children?: React.ReactNode;
  className?: string;
};

export function Overlay({
  visible,
  title,
  subtitle,
  primaryText = 'play',
  secondaryText,
  onPrimary,
  onSecondary,
  children,
  className
}: OverlayProps) {
  if (!visible) return null;
  return (
    <div className={cn('absolute inset-0 z-20 grid place-items-center bg-gradient-to-b from-black/40 to-black/70', className)}>
      <div className="w-full max-w-md mx-auto p-4 md:p-6 rounded-2xl bg-black/60 backdrop-blur border border-white/10 text-center text-white">
        {title && <h2 className="text-2xl md:text-3xl font-semibold tracking-tight">{title}</h2>}
        {subtitle && <p className="mt-2 text-white/80">{subtitle}</p>}

        {children}

        <div className="mt-5 flex items-center justify-center gap-3">
          <button
            onClick={onPrimary}
            className="px-5 py-2 rounded-xl bg-white text-black font-semibold hover:opacity-90 active:opacity-80"
          >
            {primaryText}
          </button>
          {secondaryText && (
            <button
              onClick={onSecondary}
              className="px-5 py-2 rounded-xl bg-white/10 border border-white/20 text-white hover:bg-white/15 active:bg-white/20"
            >
              {secondaryText}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
