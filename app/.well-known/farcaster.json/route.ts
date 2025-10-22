import { NextResponse } from 'next/server';

// make sure this route always runs on the server at request time
export const dynamic = 'force-dynamic';

const ROOT = process.env.NEXT_PUBLIC_URL || 'https://flippybirdgame.vercel.app';

// your known-good association values (fallbacks)
const FALLBACK = {
  header:
    'eyJmaWQiOjUyNzU5OSwidHlwZSI6ImF1dGgiLCJrZXkiOiIweGEwRTE5NjU2MzIxQ2FCYUY0NmQ0MzRGYTcxQjI2M0FiQjY5NTlGMDcifQ',
  payload: 'eyJkb21haW4iOiJmbGlwcHliaXJkZ2FtZS10d28udmVyY2VsLmFwcCJ9',
  signature:
    'TpbbMDa5/dS996BcA0G4slcUaJZfV4Hu4TkCQIgAVXlMlnrHxfGFY+Tfd6fQBM8bRSyQAP7+fxGRZ9dnNVMjaRs="',
};

export async function GET() {
  const header = process.env.NEXT_PUBLIC_FARCASTER_HEADER || FALLBACK.header;
  const payload = process.env.NEXT_PUBLIC_FARCASTER_PAYLOAD || FALLBACK.payload;
  const signature =
    process.env.NEXT_PUBLIC_FARCASTER_SIGNATURE || FALLBACK.signature;

      // --- Base Builder block (owner required; allowed optional) ---
  const ownerAddress =
    process.env.NEXT_PUBLIC_BASE_BUILDER_OWNER ||
    '0x488298039c374f013C21a8C16b5c6bEeEC4eDC0a'; // <- your owner
  // Optional: comma-separated list of additional builder addresses
  const allowedCsv = (process.env.NEXT_PUBLIC_BASE_BUILDER_ALLOWED || '').trim();
  const allowedAddresses = allowedCsv
    ? allowedCsv.split(',').map((s) => s.trim()).filter(Boolean)
    : undefined;

    
  return NextResponse.json({
    accountAssociation: { header, payload, signature },

        // 👇 add this block
    baseBuilder: {
      ownerAddress,
      ...(allowedAddresses?.length ? { allowedAddresses } : {}),
    },


    miniapp: {
      version: '1',
      name: 'Flappy Mini',
      subtitle: 'tap to fly',
      description: 'flappy style mini app',
      screenshotUrls: [`${ROOT}/screenshot-portrait.png`],
      iconUrl: `${ROOT}/icon.png`,
      splashImageUrl: `${ROOT}/splash.png`,
      splashBackgroundColor: '#000000',
      homeUrl: ROOT,
      webhookUrl: `${ROOT}/api/webhook`,
      primaryCategory: 'games',
      tags: ['game', 'arcade'],
      heroImageUrl: `${ROOT}/splash.png`,
      tagline: 'dodge the pipes',
      ogTitle: 'Flappy Mini',
      ogDescription: 'tap to play',
      ogImageUrl: `${ROOT}/splash.png`,
    },
  });
}
