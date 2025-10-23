/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: false, // prevent double-mount in dev (no double scene init)
  // Optional: disable huge dev sourcemaps to speed startup a bit
  productionBrowserSourceMaps: false,
};

export default nextConfig;