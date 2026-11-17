/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // deploy.sh builds into .next-prod so a running `npm run dev` (which owns .next) is not disturbed.
  distDir: process.env.NEXT_DIST_DIR || ".next",
};

export default nextConfig;
