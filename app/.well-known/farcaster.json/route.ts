import { NextResponse } from 'next/server';

// make sure this route always runs on the server at request time
export const dynamic = 'force-dynamic';

const ROOT = process.env.NEXT_PUBLIC_URL || 'https://hyperrun-theta.vercel.app';

// your known-good association values (fallbacks)
const FALLBACK = {
  header:
    'eyJmaWQiOjUzNjY0NiwidHlwZSI6ImF1dGgiLCJrZXkiOiIweGY0RjYxQkMyNmQyRmVkMDJCRUU4MkU4OEVGQTREOWFjMDAyYzMxODUifQ',
  payload: 'eyJkb21haW4iOiJoeXBlcnJ1bi10aGV0YS52ZXJjZWwuYXBwIn0',
  signature:
    'Ux2A9aSBS6o5rw7UmtAQ6wQGmJhdXfOYap26Hmhd/25kEflZAUAvArXLrjuoBNvIjY5WggQsQgAtpqQUSoIbghw=',
};

export async function GET() {
  const header = process.env.NEXT_PUBLIC_FARCASTER_HEADER || FALLBACK.header;
  const payload = process.env.NEXT_PUBLIC_FARCASTER_PAYLOAD || FALLBACK.payload;
  const signature =
    process.env.NEXT_PUBLIC_FARCASTER_SIGNATURE || FALLBACK.signature;

      // --- Base Builder block (owner required; allowed optional) ---
  const ownerAddress =
    process.env.NEXT_PUBLIC_BASE_BUILDER_OWNER ||
    '0x4D2dCa78049cd11f885622cC76Bf26ea75073a3E'; // <- your owner
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
      name: 'Hyper Run',
      subtitle: 'run',
      description: 'Hyper run mini app',
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
