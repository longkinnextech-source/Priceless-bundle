"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Alert, Button, Card, Field, Spinner, inputClass } from "@/components/ui";
import { useToast } from "@/components/Toast";
import { apiPost } from "@/lib/client";

export default function LoginForm({ nextPath }: { nextPath?: string }) {
  const router = useRouter();
  const toast = useToast();
  const [phone, setPhone] = useState("");
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [needsActivation, setNeedsActivation] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setNeedsActivation(false);
    setBusy(true);
    try {
      const result = await apiPost<{ message: string; redirect: string }>("/api/auth/login", { phone, pin });
      toast.success("Signed in", result.message);
      router.push(nextPath || result.redirect || "/buy");
      router.refresh();
    } catch (err) {
      const message = (err as Error).message;
      setError(message);
      if (message.toLowerCase().includes("activat")) setNeedsActivation(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-md">
      <div className="mb-6 text-center">
        <h1 className="text-3xl font-extrabold">Welcome back</h1>
        <p className="mt-2 text-sm text-ash-400">Sign in with the mobile number you registered.</p>
      </div>

      <Card>
        <form onSubmit={submit} className="space-y-4">
          <Field label="Mobile number">
            <input
              className={inputClass}
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="0244123456"
              inputMode="tel"
              autoComplete="tel"
              autoFocus
              required
            />
          </Field>

          <Field label="PIN" hint="4–6 digits">
            <input
              className={inputClass}
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/[^0-9]/g, "").slice(0, 6))}
              placeholder="••••"
              type="password"
              inputMode="numeric"
              autoComplete="current-password"
              required
            />
          </Field>

          {error ? (
            <Alert tone="error">
              {error}
              {needsActivation ? (
                <>
                  {" "}
                  <Link href="/signup" className="font-semibold underline">
                    Activate now
                  </Link>
                </>
              ) : null}
            </Alert>
          ) : null}

          <Button type="submit" disabled={busy} className="w-full" size="lg">
            {busy ? <Spinner /> : null}
            {busy ? "Signing in…" : "Sign in"}
          </Button>
        </form>
      </Card>

      <p className="mt-5 text-center text-sm text-ash-400">
        New here?{" "}
        <Link href="/signup" className="font-semibold text-fire-400 hover:text-fire-300">
          Create an account
        </Link>
      </p>
    </div>
  );
}
