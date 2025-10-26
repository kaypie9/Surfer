// app/layout.tsx
import type { Metadata } from 'next';
import Providers from '@/components/providers'; // <-- NOTE: using your `componants` folder
import AddMiniAppPrompt from '@/components/AddMiniAppPrompt'

export const metadata: Metadata = {
  title: 'Hyper Run',
  description: 'Neon runner',
};


export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <AddMiniAppPrompt />
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
