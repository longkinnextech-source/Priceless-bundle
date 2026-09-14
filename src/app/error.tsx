"use client";

import { useEffect } from "react";
import { Button, Card } from "@/components/ui";

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error("[app error]", error);
  }, [error]);

  return (
    <div className="mx-auto max-w-lg py-16 text-center">
      <Card>
        <p className="text-5xl">⚠️</p>
        <h1 className="mt-4 text-2xl font-extrabold">Something went wrong</h1>
        <p className="mt-2 text-sm text-ash-400">
          We hit an unexpected error. Your wallet balance is safe — nothing was half-processed.
        </p>
        <div className="mt-6 flex justify-center gap-3">
          <Button onClick={reset}>Try again</Button>
          <Button href="/" variant="secondary">
            Back home
          </Button>
        </div>
      </Card>
    </div>
  );
}
