"use client";

/**
 * Brand logo.
 *
 * Reads /public/logo.png so swapping in the real artwork is a one-file change
 * (drop your logo.png into /public — no code edits needed). If the file is
 * missing or fails to load, it falls back to a vector flame monogram so the
 * header never renders a broken image.
 */

import { useState } from "react";

type LogoProps = {
  size?: number;
  withWordmark?: boolean;
  className?: string;
  subtitle?: string | null;
};

export default function Logo({ size = 36, withWordmark = true, className = "", subtitle = null }: LogoProps) {
  const [failed, setFailed] = useState(false);

  return (
    <span className={`inline-flex items-center gap-2.5 ${className}`}>
      <span
        className="relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-xl"
        style={{ width: size, height: size }}
      >
        {failed ? (
          <FallbackMark size={size} />
        ) : (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img
            src="/logo.png"
            alt="Priceless Bundle"
            width={size}
            height={size}
            onError={() => setFailed(true)}
            className="h-full w-full object-cover"
          />
        )}
      </span>

      {withWordmark ? (
        <span className="flex flex-col leading-none">
          <span className="text-[1.02rem] font-extrabold tracking-tight text-white">
            Priceless <span className="fire-text">Bundle</span>
          </span>
          <span className="mt-0.5 text-[0.62rem] font-medium uppercase tracking-[0.16em] text-ash-500">
            {subtitle ?? "Data · Instant"}
          </span>
        </span>
      ) : null}
    </span>
  );
}

function FallbackMark({ size }: { size: number }) {
  return (
    <span
      className="flex h-full w-full items-center justify-center fire-gradient"
      style={{ fontSize: size * 0.5 }}
      aria-hidden="true"
    >
      <svg viewBox="0 0 32 32" width={size * 0.68} height={size * 0.68} fill="none">
        <path
          d="M16 2.5c1.2 5.2 6.8 7.4 6.8 13.2A6.8 6.8 0 0 1 16 22.5a6.8 6.8 0 0 1-6.8-6.8c0-2.6 1.3-4.3 2.6-6 .4 1.6 1.3 2.6 2.4 3.1.6-4.2-1.1-7.6 1.8-10.3Z"
          fill="#fff"
          fillOpacity="0.95"
        />
        <path d="M12.6 24.6h6.8V29a1 1 0 0 1-1 1h-4.8a1 1 0 0 1-1-1v-4.4Z" fill="#fff" fillOpacity="0.95" />
      </svg>
    </span>
  );
}
